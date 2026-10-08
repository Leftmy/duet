// Codex provider: OpenAI Codex through `codex app-server` (JSON-RPC over stdio). One app-server
// process serves every chat; each run is one Codex thread. Desk toolsets are given to Codex as
// dynamic tools, and approval requests go through the core's broker like Claude's.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { AppServer, findCodex } from './rpc.mjs';
import { createTranslator, historyEvents, subagentEvents, limitsEvent } from './translate.mjs';
import { rolloutEvents } from './rollout.mjs';
import { findTool, inputSchema, runTool } from '../../core/tools.mjs';

const CLIENT = { name: 'duet', title: 'Duet', version: '0.1.0' };

/**
 * Desk permission mode → Codex approval policy + sandbox. The Windows sandbox needs a separate setup
 * that app-server clients can't count on, so there the agent runs unsandboxed and "ask" modes rely on
 * approvals ('untrusted' asks before anything that isn't known to be read-only).
 */
function policyFor(mode, { cwd, dirs = [] } = {}) {
  const sandboxed = process.platform !== 'win32';
  const full = { type: 'dangerFullAccess' };
  const write = sandboxed ? { type: 'workspaceWrite', writableRoots: dirs, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } : full;
  const read = sandboxed ? { type: 'readOnly', networkAccess: false } : full;
  switch (mode) {
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandboxPolicy: full, sandbox: 'danger-full-access' };
    case 'auto':
      return { approvalPolicy: 'on-request', sandboxPolicy: write, sandbox: sandboxed ? 'workspace-write' : 'danger-full-access' };
    case 'plan':
      return { approvalPolicy: 'untrusted', sandboxPolicy: read, sandbox: sandboxed ? 'read-only' : 'danger-full-access', plan: true };
    default:
      // 'default' (ask) and 'acceptEdits' (file changes are approved client-side).
      return { approvalPolicy: 'untrusted', sandboxPolicy: write, sandbox: sandboxed ? 'workspace-write' : 'danger-full-access' };
  }
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const effortFor = (e) => (e === 'max' ? 'xhigh' : EFFORTS.has(e) ? e : undefined);

/** Desk tool result → Codex dynamic tool response. */
function dynamicResponse(r) {
  const contentItems = (r?.content ?? []).map((c) =>
    c.type === 'image' ? { type: 'inputImage', imageUrl: `data:${c.mimeType ?? 'image/png'};base64,${c.data}` } : { type: 'inputText', text: String(c.text ?? '') },
  );
  return { contentItems: contentItems.length ? contentItems : [{ type: 'inputText', text: '' }], success: !r?.isError };
}

/** Every turn of a thread with full items, oldest first. */
async function allTurns(srv, threadId) {
  const turns = [];
  let cursor = null;
  do {
    const r = await srv.request('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) });
    turns.push(...(r.data ?? []));
    cursor = r.nextCursor;
  } while (cursor);
  return turns;
}

/** Runs the codex CLI (the same binary the app server uses). */
function codexCli(args) {
  const codex = findCodex();
  if (!codex) return Promise.reject(new Error('Codex CLI not found'));
  return new Promise((resolve, reject) =>
    execFile(codex.bin, args, { env: { ...process.env, ...codex.env }, windowsHide: true, timeout: 60000 }, (err, out, errOut) =>
      err ? reject(new Error((errOut || out || err.message).toString().trim())) : resolve(out.toString().trim()),
    ),
  );
}

const userInput = (text, images = []) => [
  ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
  ...images.map((img) => ({ type: 'image', url: `data:${img.mediaType};base64,${img.data}` })),
];

export function createCodexProvider({ log = () => {} } = {}) {
  let server = null;
  let starting = null;
  let models = [];
  let configModel = null;
  let version = null;
  /** Codex thread id → run */
  const runs = new Map();

  function route(method, p) {
    if (method === 'account/rateLimits/updated') {
      const ev = limitsEvent(p.rateLimits);
      if (ev) for (const run of new Set(runs.values())) run.emit(ev);
      return;
    }
    const tid = p.threadId ?? p.thread?.id;
    const run = tid && runs.get(tid);
    if (run) run.notify(method, p);
  }

  async function onRequest(method, p, id) {
    const run = p.threadId && runs.get(p.threadId);
    if (!run) {
      if (method.endsWith('requestApproval')) return { decision: 'decline' };
      throw new Error('No active Duet chat for this Codex thread');
    }
    return run.request(method, p, id);
  }

  async function ensureServer() {
    if (server && !server.closed) return server;
    if (starting) return starting;
    starting = (async () => {
      const codex = findCodex();
      if (!codex) throw new Error('Codex CLI not found. Install it with: npm install -g @openai/codex');
      const srv = new AppServer({
        codex,
        log,
        onNotification: (m, p) => {
          if (m === 'serverRequest/resolved') return runs.get(p.threadId)?.resolved(p.requestId);
          route(m, p);
        },
        onRequest,
        onExit: (err) => {
          log('codex app-server exited', err.message);
          if (server === srv) server = null;
          for (const run of new Set(runs.values())) run.serverGone(err);
        },
      });
      const init = await srv.initialize(CLIENT);
      version = init?.userAgent?.match(/\/([\d.]+)/)?.[1] ?? null;
      server = srv;
      return srv;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  async function loadModels(srv) {
    const [list, config] = await Promise.all([
      srv.request('model/list', {}).catch(() => ({ data: [] })),
      srv.request('config/read', { includeLayers: false }).catch(() => null),
    ]);
    models = (list.data ?? []).filter((m) => !m.hidden);
    configModel = config?.config?.model ?? null;
    return models;
  }

  /** 'default' = the model from Codex's own config when this CLI can run it, else the CLI's default. */
  function resolveModel(model) {
    if (model && model !== 'default') return model;
    if (configModel && models.some((m) => m.id === configModel)) return configModel;
    return models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? undefined;
  }

  return {
    id: 'codex',
    label: 'Codex',
    brand: { color: '#10A37F', mark: 'X' },
    caps: {
      steer: true,
      interrupt: true,
      images: true,
      fork: true,
      rollback: 'turns',
      rewindFiles: false,
      subagents: true,
      backgroundTasks: false,
      contextUsage: true,
      slashCommands: false,
      segments: false,
      chrome: false,
      modes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
    },

    open(spec, sink) {
      const tr = createTranslator();
      let threadId = null;
      let closed = false;
      let busy = false;
      let cfg = { model: spec.model, effort: spec.effort, permissionMode: spec.permissionMode || 'default' };
      /** fileChange items seen, for approval cards */
      const changes = new Map();
      /** server request id → AbortController of a pending approval */
      const approvals = new Map();
      const toolsets = spec.tools ?? [];

      const emit = (ev) => !closed && sink.event(ev);

      const ready = (async () => {
        const srv = await ensureServer();
        if (!models.length) await loadModels(srv);
        const pol = policyFor(cfg.permissionMode, spec);
        const common = {
          model: resolveModel(cfg.model),
          cwd: spec.cwd || os.homedir(),
          approvalPolicy: pol.approvalPolicy,
          sandbox: pol.sandbox,
          ...(spec.instructions ? { developerInstructions: spec.instructions } : {}),
        };
        const dynamicTools = toolsets.flatMap((set) =>
          set.tools.map((t) => ({ namespace: set.name, name: t.name, description: t.description, inputSchema: inputSchema(t) })),
        );
        const r = spec.resume
          ? await srv.request('thread/resume', { threadId: spec.resume, ...common })
          : await srv.request('thread/start', { ...common, dynamicTools });
        threadId = r.thread.id;
        // A thread the server still has loaded ignores resume-time instructions; put them into its history instead.
        if (spec.resume && spec.instructions) {
          await srv.request('thread/inject_items', {
            threadId,
            items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: spec.instructions }] }],
          });
        }
        runs.set(threadId, run);
        emit({ type: 'session', sessionId: threadId, model: r.model });
        return srv;
      })();
      ready.catch((e) => finish(String(e?.message || e)));

      const turnParams = () => {
        const pol = policyFor(cfg.permissionMode, spec);
        const model = resolveModel(cfg.model);
        const effort = effortFor(cfg.effort);
        return {
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          summary: 'auto',
          approvalPolicy: pol.approvalPolicy,
          sandboxPolicy: pol.sandboxPolicy,
          ...(spec.dirs?.length ? { runtimeWorkspaceRoots: [spec.cwd, ...spec.dirs] } : {}),
          collaborationMode: { mode: pol.plan ? 'plan' : 'default', settings: { model: model ?? '', reasoning_effort: effort ?? null, developer_instructions: null } },
        };
      };

      async function sendNow({ text, images, priority }) {
        const srv = await ready;
        const input = userInput(text, images);
        if (busy && tr.turnId && priority === 'next') {
          await srv.request('turn/steer', { threadId, input, expectedTurnId: tr.turnId });
          return;
        }
        busy = true;
        await srv.request('turn/start', { threadId, input, ...turnParams() });
      }

      function finish(error) {
        if (closed) return;
        closed = true;
        if (threadId) runs.delete(threadId);
        for (const child of tr.children.keys()) runs.delete(child);
        for (const ac of approvals.values()) ac.abort();
        sink.closed({ error: error ?? null });
      }

      const ask = async (id, req) => {
        const ac = new AbortController();
        approvals.set(id, ac);
        try {
          return await sink.approval({ ...req, signal: ac.signal });
        } finally {
          approvals.delete(id);
        }
      };

      const run = {
        emit,
        notify(method, p) {
          if (method === 'item/started' && p.item?.type === 'fileChange') changes.set(p.item.id, p.item.changes ?? []);
          for (const ev of tr.push(method, p, threadId)) {
            if (ev.type === 'turn.end') busy = false;
            emit(ev);
          }
          // Collab subagents run in their own threads; follow them on this run.
          for (const child of tr.children.keys()) if (!runs.has(child)) runs.set(child, run);
        },

        async request(method, p, id) {
          const mode = cfg.permissionMode;
          if (method === 'item/commandExecution/requestApproval') {
            if (mode === 'bypassPermissions') return { decision: 'accept' };
            const command = (p.commandActions ?? []).map((a) => a.command).join(' && ') || p.command || '';
            const r = await ask(id, {
              toolName: 'Bash',
              input: { command, ...(p.reason ? { description: p.reason } : {}) },
              toolUseID: p.itemId,
              description: p.reason ?? undefined,
              canAlways: true,
            });
            return { decision: r.decision === 'always' ? 'acceptForSession' : r.decision === 'allow' ? 'accept' : 'decline' };
          }
          if (method === 'item/fileChange/requestApproval') {
            if (mode === 'bypassPermissions' || mode === 'acceptEdits') return { decision: 'accept' };
            const list = changes.get(p.itemId) ?? [];
            const c = list[0];
            const r = await ask(id, {
              toolName: 'Patch',
              input: c ? { file_path: c.path, kind: c.kind?.type ?? 'update', diff: c.diff ?? '' } : {},
              toolUseID: p.itemId,
              description: [p.reason, list.length > 1 ? list.map((x) => x.path).join('\n') : null].filter(Boolean).join('\n') || undefined,
              canAlways: true,
            });
            return { decision: r.decision === 'always' ? 'acceptForSession' : r.decision === 'allow' ? 'accept' : 'decline' };
          }
          if (method === 'item/tool/call') {
            const tool = findTool(toolsets, p.namespace, p.tool);
            if (!tool) return { contentItems: [{ type: 'inputText', text: `Unknown tool ${p.namespace}.${p.tool}` }], success: false };
            return dynamicResponse(await runTool(tool, p.arguments, { toolUseId: p.callId }));
          }
          if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
            return { decision: mode === 'bypassPermissions' ? 'approved' : 'denied' };
          }
          if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
          if (method === 'item/tool/requestUserInput') return { answers: {} };
          throw new Error(`Unsupported request: ${method}`);
        },

        /** The server dropped a request (turn interrupted, answered elsewhere). */
        resolved(requestId) {
          approvals.get(requestId)?.abort();
        },

        serverGone(err) {
          busy = false;
          finish(err.message);
        },

        send(msg) {
          sendNow(msg).catch((e) => {
            busy = false;
            emit({ type: 'turn.end', isError: true, error: String(e?.message || e) });
          });
        },
        async configure(patch) {
          cfg = { ...cfg, ...patch };
        },
        ready: () => ready.then(() => undefined),
        async interrupt() {
          const srv = await ready;
          if (tr.turnId) await srv.request('turn/interrupt', { threadId, turnId: tr.turnId }).catch(() => {});
        },
        close() {
          const tid = threadId;
          finish(null);
          if (tid && server && !server.closed) server.request('thread/unsubscribe', { threadId: tid }).catch(() => {});
        },
      };
      return run;
    },

    async probe() {
      const srv = await ensureServer();
      const [account, list, limits] = await Promise.all([
        srv.request('account/read', { refreshToken: false }).catch(() => null),
        loadModels(srv),
        srv.request('account/rateLimits/read').catch(() => null),
      ]);
      const acc = account?.account;
      return {
        available: true,
        version,
        account: acc?.type === 'chatgpt' ? { email: acc.email, subscriptionType: acc.planType } : acc ? { subscriptionType: acc.type } : {},
        loggedIn: Boolean(acc),
        models: [
          { value: 'default', displayName: 'Default', description: resolveModel('default') ?? '', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] },
          ...list.map((m) => ({
            value: m.id,
            displayName: m.displayName || m.id,
            description: m.description ?? '',
            supportedEffortLevels: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e.effort).filter(Boolean),
          })),
        ],
        commands: [],
        usage: limits?.rateLimits ? limitsEvent(limits.rateLimits) : null,
      };
    },

    /** Skills Codex can use in a folder (user, project and built-in ones). */
    async skills(cwd) {
      const srv = await ensureServer();
      const r = await srv.request('skills/list', { cwds: [cwd || os.homedir()] });
      return (r.data ?? []).flatMap((x) => x.skills ?? []).filter((k) => k.enabled !== false).map((k) => ({ name: k.name, description: k.description ?? '', scope: k.scope }));
    },

    /** MCP servers Codex knows (config.toml and plugins). */
    async mcpStatus() {
      const srv = await ensureServer();
      const r = await srv.request('mcpServerStatus/list', {});
      return (r.data ?? []).map((m) => {
        const tools = m.tools ? Object.keys(m.tools).length : 0;
        const status = m.toolsError ? 'failed' : m.authStatus === 'notLoggedIn' ? 'needs-auth' : 'connected';
        return { name: m.name, status, tools, scope: m.pluginId ? 'plugin' : 'config', ...(m.toolsError ? { error: String(m.toolsError) } : {}) };
      });
    },

    /** Reloads MCP servers from config (Codex has no per-server reconnect). */
    async mcpReconnect() {
      const srv = await ensureServer();
      await srv.request('config/mcpServer/reload', undefined);
    },

    /** codex mcp add/remove (writes ~/.codex/config.toml). */
    mcpAdd({ name, transport, target, args = [], env = {} }) {
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
      return codexCli(transport === 'stdio' ? ['mcp', 'add', ...envArgs, name, '--', target, ...args] : ['mcp', 'add', name, '--url', target]);
    },
    mcpRemove: (name) => codexCli(['mcp', 'remove', name]),

    async usage() {
      const srv = await ensureServer();
      const r = await srv.request('account/rateLimits/read');
      return limitsEvent(r?.rateLimits);
    },

    async listSessions() {
      const srv = await ensureServer();
      const r = await srv.request('thread/list', { limit: 200, sortKey: 'updated_at' });
      return (r.data ?? []).map((th) => ({
        sessionId: th.id,
        provider: 'codex',
        title: th.name || (th.preview || '').split('\n')[0].slice(0, 120) || 'Codex',
        cwd: th.cwd || '',
        gitBranch: th.gitInfo?.branch ?? undefined,
        lastModified: (th.updatedAt ?? th.createdAt ?? 0) * 1000,
        createdAt: (th.createdAt ?? 0) * 1000,
      }));
    },

    /** The rollout file (watched to notice the Codex app or CLI continuing the thread). */
    async sessionFile(sessionId) {
      const srv = await ensureServer();
      const r = await srv.request('thread/read', { threadId: sessionId, includeTurns: false });
      return r.thread?.path ?? null;
    },

    /** The rollout file has every command and tool call; thread/read (messages and edits only) is the fallback. */
    async loadHistory(sessionId) {
      const srv = await ensureServer();
      const meta = await srv.request('thread/read', { threadId: sessionId, includeTurns: false });
      const fromFile = meta.thread?.path ? rolloutEvents(meta.thread.path) : null;
      if (fromFile) return fromFile;
      return historyEvents({ turns: await allTurns(srv, sessionId) });
    },

    async loadSubagents(sessionId) {
      const srv = await ensureServer();
      const spawns = [];
      for (const turn of await allTurns(srv, sessionId))
        for (const item of turn.items ?? [])
          if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent')
            for (const child of item.receiverThreadIds ?? []) spawns.push({ spawnId: item.id, child });
      const threads = await Promise.all(
        spawns.map(({ spawnId, child }) =>
          allTurns(srv, child)
            .then((turns) => ({ spawnId, thread: { turns } }))
            .catch(() => null),
        ),
      );
      return subagentEvents(threads.filter(Boolean));
    },

    async renameSession(sessionId, title) {
      const srv = await ensureServer();
      await srv.request('thread/name/set', { threadId: sessionId, name: title });
    },

    /** Codex keeps every thread; deleting archives it (hidden from lists, still on disk). */
    async deleteSession(sessionId) {
      const srv = await ensureServer();
      await srv.request('thread/archive', { threadId: sessionId });
    },

    async fork({ sessionId }) {
      const srv = await ensureServer();
      const r = await srv.request('thread/fork', { threadId: sessionId });
      return r.thread.id;
    },

    /** Drops the last n turns of a thread's history (files are not touched). */
    async rollback(sessionId, numTurns) {
      const srv = await ensureServer();
      await srv.request('thread/rollback', { threadId: sessionId, numTurns });
    },

    /** A full Codex task without a UI thread; resolves with its final text. */
    async runHeadless({ prompt, cwd, model, effort, permissionMode = 'acceptEdits', timeoutMs = 30 * 60000, onEvent, resume, dirs, tools, instructions, canUseTool }) {
      let result = { text: '', sessionId: null, isError: false, durationMs: 0, costUsd: 0 };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          run.close();
          reject(new Error('background task timed out'));
        }, timeoutMs);
        const run = this.open(
          { threadId: `headless-${Date.now()}`, cwd, dirs, model, effort, permissionMode, resume, tools, instructions },
          {
            event(ev) {
              onEvent?.(ev);
              if (ev.type === 'session') result.sessionId = ev.sessionId;
              if (ev.type === 'turn.end') {
                result = { ...result, text: ev.text ?? '', isError: Boolean(ev.isError), durationMs: ev.durationMs ?? 0 };
                clearTimeout(timer);
                run.close();
                resolve();
              }
            },
            async approval(req) {
              if (!canUseTool) return { decision: 'deny', message: 'No one to ask in a background task.' };
              const r = await canUseTool(req.toolName, req.input, { signal: req.signal });
              return r.behavior === 'allow' ? { decision: 'allow', updatedInput: r.updatedInput } : { decision: 'deny', message: r.message };
            },
            closed({ error }) {
              clearTimeout(timer);
              if (error) reject(new Error(error));
              else resolve();
            },
          },
        );
        run.send({ text: String(prompt) });
      });
      return result;
    },

    close() {
      server?.close();
      server = null;
    },
  };
}

export default createCodexProvider;

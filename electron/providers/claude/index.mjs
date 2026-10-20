// Claude provider: Claude Code through the Agent SDK. Each run is one long-lived streaming-input
// query, so model, effort and permission mode can change mid-session and turns can be interrupted.
import {
  query,
  createSdkMcpServer,
  tool,
  listSessions,
  getSessionMessages,
  listSubagents,
  forkSession,
  getSubagentMessages,
  renameSession,
  deleteSession,
} from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findFile, listSegments, loadSegment, withRecordedTimestamps } from '../../segments.mjs';
import { runTool } from '../../core/tools.mjs';
import { t as tr } from '../../i18n.mjs';
import { createTranslator, historyEvents, subagentEvents } from './translate.mjs';

/**
 * The Claude Code binary the SDK ships in its platform package (@anthropic-ai/claude-agent-sdk-<os>-<arch>,
 * plus -musl builds on Linux), mapped to app.asar.unpacked in the packaged app. null when not installed.
 */
const bundledClaude = (() => {
  const require = createRequire(import.meta.url);
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const name of [`${process.platform}-${process.arch}`, `${process.platform}-${process.arch}-musl`]) {
    try {
      const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${name}/package.json`);
      const bin = path.join(path.dirname(pkg), exe).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      if (fs.existsSync(bin)) return { bin, packaged: pkg.includes('app.asar') };
    } catch {}
  }
  return null;
})();

// In the packaged app the binary lives in app.asar.unpacked, where the SDK won't look; point it there.
const exeOption = bundledClaude?.packaged ? { pathToClaudeCodeExecutable: bundledClaude.bin } : {};

/** The Claude Code CLI binary that ships with the SDK (used for claude mcp ...). */
export function claudeCli() {
  return bundledClaude?.bin ?? 'claude';
}

class InputQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** reminder: hidden context sent ahead of the text (shown to the model, not in the chat feed). */
function userMessage(text, images = [], uuid, priority, reminder) {
  const content = [
    ...(reminder ? [{ type: 'text', text: `<system-reminder>\n${reminder}\n</system-reminder>` }] : []),
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
    ...(text ? [{ type: 'text', text }] : []),
  ];
  return {
    type: 'user',
    message: { role: 'user', content: images.length || reminder ? content : text },
    parent_tool_use_id: null,
    ...(uuid ? { uuid } : {}),
    // 'next' folds the message into the running turn at the next tool boundary (no interrupt).
    ...(priority ? { priority } : {}),
  };
}

export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

const supportsAdaptiveThinking = (model) => !/haiku/i.test(model || '');
const dirOpt = (cwd) => (cwd ? { dir: cwd } : undefined);

/** Desk toolsets as in-process SDK MCP servers (tools appear as mcp__<set>__<tool>). */
const sdkServers = (toolsets = []) =>
  Object.fromEntries(
    toolsets.map((set) => [
      set.name,
      createSdkMcpServer({
        name: set.name,
        version: '1.0.0',
        ...(set.instructions ? { instructions: set.instructions } : {}),
        tools: set.tools.map((t) =>
          tool(t.name, t.description, t.schema, (args, extra) => runTool(t, args, { signal: extra?.signal, toolUseId: extra?._meta?.['claudecode/toolUseId'] })),
        ),
      }),
    ]),
  );

/** A tool-less one-shot completion on a small model; the base of titles, commit messages, PR texts. */
async function oneShot({ prompt, system, model = 'haiku', timeoutMs = 90000, label = 'completion' }) {
  const q = query({
    prompt: String(prompt),
    options: {
      ...exeOption,
      cwd: os.homedir(),
      model,
      maxTurns: 1,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      systemPrompt: system,
    },
  });
  let out = '';
  try {
    await withTimeout(
      (async () => {
        for await (const m of q) if (m.type === 'result' && m.subtype === 'success') out = m.result ?? '';
      })(),
      timeoutMs,
      label,
    );
  } finally {
    q.close();
  }
  return out;
}

/** A /usage limit window → { pct 0–100, resetsAt ms }. */
const usageWindow = (w) => (w && w.utilization != null ? { pct: Math.max(0, Math.min(100, w.utilization)), resetsAt: w.resets_at ? Date.parse(w.resets_at) || null : null } : undefined);

/** Claude's /usage data as the desk's plan limits: { plan, session, weekly } (pct 0–100, resetsAt in ms). */
export function planLimits(u) {
  if (!u) return null;
  const rl = u.rate_limits_available ? u.rate_limits : null;
  return { plan: u.subscription_type ?? null, ...(rl ? { session: usageWindow(rl.five_hour), weekly: usageWindow(rl.seven_day) } : {}) };
}

export function createClaudeProvider({ stats, log = () => {} }) {
  const outputFiles = new Set();
  const live = new Set();
  let probeCache = null;

  const recordTurn = (cwd, msg) => {
    try {
      stats?.recordTurn({ cwd }, msg);
    } catch {}
  };

  /** Runs fn(query) on a live session if there is one, else on a short-lived one. */
  async function withQuery(fn) {
    for (const run of live) if (run.q) return fn(run.q);
    const input = new InputQueue();
    const q = query({ prompt: input, options: { ...exeOption, cwd: os.homedir() } });
    try {
      await withTimeout(q.initializationResult(), 60000, 'initialize');
      return await fn(q);
    } finally {
      input.close();
      q.close();
    }
  }

  async function readUsage(q) {
    const u = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 15000, 'usage');
    try {
      stats?.recordLimits(u);
    } catch {}
    return u;
  }

  return {
    id: 'claude',
    label: 'Claude',
    brand: { color: '#D97757', mark: 'C' },
    caps: {
      steer: true,
      interrupt: true,
      images: true,
      fork: true,
      rollback: 'anchor',
      rewindFiles: true,
      subagents: true,
      backgroundTasks: true,
      contextUsage: true,
      slashCommands: true,
      segments: true,
      chrome: true,
      modes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
    },

    /** Starts a run. spec: { threadId, cwd, dirs, model, effort, permissionMode, resume, resumeAt, instructions, tools, chrome }. */
    open(spec, sink) {
      const input = new InputQueue();
      let stderrTail = '';
      const translator = createTranslator('live');
      const q = query({
        prompt: input,
        options: {
          ...exeOption,
          cwd: spec.cwd,
          ...(spec.dirs?.length ? { additionalDirectories: spec.dirs } : {}),
          model: spec.model || undefined,
          effort: spec.effort || undefined,
          permissionMode: spec.permissionMode || 'default',
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          // Full subagent conversations + short live progress lines for the Agents panel.
          forwardSubagentText: true,
          // Lets the UI roll files back to any earlier user message.
          enableFileCheckpointing: true,
          agentProgressSummaries: true,
          // We have per-task stop buttons (tasks bar, Agents tab), so Stop only aborts the current turn
          // and background agents/tasks keep running. Without this the CLI kills them all on interrupt.
          perTaskStopAffordance: true,
          ...(supportsAdaptiveThinking(spec.model) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code', ...(spec.instructions ? { append: spec.instructions } : {}) },
          resume: spec.resume || undefined,
          // Conversation rewind: continue the session from an earlier message.
          ...(spec.resume && spec.resumeAt ? { resumeSessionAt: spec.resumeAt } : {}),
          // Desk tools (session helpers, built-in browser, other agents) and, if enabled, Claude in Chrome.
          mcpServers: sdkServers(spec.tools),
          ...(spec.chrome != null ? { extraArgs: spec.chrome ? { chrome: null } : { 'no-chrome': null } } : {}),
          canUseTool: async (toolName, toolInput, opts) => {
            const r = await sink.approval({
              toolName,
              input: toolInput,
              toolUseID: opts.toolUseID,
              agentID: opts.agentID,
              title: opts.title,
              displayName: opts.displayName,
              description: opts.description,
              decisionReason: opts.decisionReason,
              blockedPath: opts.blockedPath,
              canAlways: !opts.suppressAlwaysAllowRule && Boolean(opts.suggestions?.length),
              signal: opts.signal,
            });
            if (r.decision === 'deny') return { behavior: 'deny', message: r.message || 'The user declined this action.' };
            return {
              behavior: 'allow',
              updatedInput: r.updatedInput ?? toolInput,
              ...(r.decision === 'always' && opts.suggestions?.length ? { updatedPermissions: opts.suggestions } : {}),
            };
          },
          stderr: (chunk) => {
            stderrTail = (stderrTail + chunk).slice(-4000);
          },
        },
      });
      const run = { q };
      live.add(run);
      // A resumed session keeps its original system prompt, so handed-over context rides with the first message.
      let reminder = spec.resume && spec.instructions ? spec.instructions : null;

      (async () => {
        let error = null;
        try {
          for await (const msg of q) {
            if (msg.type === 'result' && !msg.parent_tool_use_id) recordTurn(spec.cwd, msg);
            if (msg.type === 'system' && msg.subtype === 'task_notification' && msg.output_file) {
              outputFiles.add(path.resolve(msg.output_file).toLowerCase());
            }
            for (const ev of translator.push(msg)) sink.event(ev);
          }
        } catch (e) {
          error = String(e?.message || e);
          log('query error', spec.threadId, error, stderrTail);
        }
        live.delete(run);
        run.q = null;
        sink.closed({ error, stderr: error ? stderrTail.slice(-1500) : undefined });
      })();

      return Object.assign(run, {
        send({ text, images, uuid, priority }) {
          input.push(userMessage(text, images, uuid, priority, reminder));
          reminder = null;
        },
        async configure({ model, effort, permissionMode }) {
          if (model !== undefined) await q.setModel(model);
          if (effort !== undefined) await q.applyFlagSettings({ effortLevel: effort });
          if (permissionMode !== undefined) await q.setPermissionMode(permissionMode);
        },
        ready: () => withTimeout(q.initializationResult(), 60000, 'initialize'),
        interrupt: () => q.interrupt(),
        close() {
          input.close();
          q.close();
        },
        rewindFiles: (uuid, dryRun) => q.rewindFiles(uuid, { dryRun: Boolean(dryRun) }),
        async contextUsage() {
          const u = await withTimeout(q.getContextUsage({ detail: 'summary' }), 15000, 'context');
          return {
            totalTokens: u.totalTokens,
            maxTokens: u.maxTokens,
            percentage: u.percentage,
            categories: u.categories.filter((c) => c.kind === 'used' && c.tokens > 0).map((c) => ({ name: c.name, tokens: c.tokens, color: c.color })),
          };
        },
        stopTask: (taskId) => q.stopTask(taskId),
        /** Moves a running foreground Bash/agent call to the background (like Ctrl+B in the CLI). */
        backgroundTask: (toolUseId) => q.backgroundTasks(toolUseId),
        usage: async () => planLimits(await readUsage(q)),
      });
    },

    async probe(force = false) {
      if (probeCache && !force) return probeCache;
      const input = new InputQueue();
      const q = query({ prompt: input, options: { ...exeOption, cwd: os.homedir() } });
      try {
        const init = await withTimeout(q.initializationResult(), 60000, 'initialize');
        let usage = null;
        try {
          usage = planLimits(await readUsage(q));
        } catch (e) {
          log('usage unavailable', String(e?.message || e));
        }
        let mcp = [];
        try {
          const list = await withTimeout(q.mcpServerStatus(), 20000, 'mcp');
          mcp = list.map((m) => ({ name: m.name, status: m.status, scope: m.scope ?? m.source, tools: m.tools?.length ?? 0 }));
        } catch (e) {
          log('mcp status unavailable', String(e?.message || e));
        }
        probeCache = {
          available: true,
          mcp,
          version: init.claude_code_version,
          models: init.models ?? [],
          account: init.account ?? {},
          commands: (init.commands ?? []).map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
          usage,
        };
        return probeCache;
      } finally {
        input.close();
        q.close();
      }
    },

    /** Plan limits now: from a live session, else a short-lived one (no MCP servers, nothing sent). */
    async usage() {
      for (const run of live) {
        if (!run.q) continue;
        try {
          return await run.usage();
        } catch {
          break;
        }
      }
      const input = new InputQueue();
      const q = query({ prompt: input, options: { ...exeOption, cwd: os.homedir(), mcpServers: {}, strictMcpConfig: true } });
      try {
        await withTimeout(q.initializationResult(), 60000, 'initialize');
        return planLimits(await readUsage(q));
      } finally {
        input.close();
        q.close();
      }
    },

    async mcpStatus() {
      return withQuery(async (q) =>
        (await q.mcpServerStatus()).map((m) => ({ name: m.name, status: m.status, scope: m.scope ?? m.source, tools: m.tools?.length ?? 0, error: m.error })),
      );
    },

    mcpReconnect: (name) => withQuery((q) => q.reconnectMcpServer(name)),

    async listSessions() {
      const sessions = await listSessions({ limit: 300 });
      return sessions.map((s) => ({
        sessionId: s.sessionId,
        provider: 'claude',
        title: s.customTitle || s.summary || s.firstPrompt || tr('claude.untitled'),
        cwd: s.cwd || '',
        gitBranch: s.gitBranch,
        lastModified: s.lastModified,
        createdAt: s.createdAt,
      }));
    },

    /** A saved session as desk events; segment = an earlier part before an in-file compaction. */
    async loadHistory(sessionId, cwd, segment) {
      const msgs = segment != null ? await loadSegment(sessionId, cwd, segment)
        : await withRecordedTimestamps(await getSessionMessages(sessionId, dirOpt(cwd)), sessionId, cwd);
      return historyEvents(msgs);
    },

    listSegments: (sessionId, cwd) => listSegments(sessionId, cwd),

    /** The transcript file (watched to notice other windows continuing the session). */
    sessionFile: (sessionId, cwd) => findFile(sessionId, cwd),

    /** All subagent transcripts of a saved session as desk events. */
    async loadSubagents(sessionId, cwd) {
      const ids = await listSubagents(sessionId, dirOpt(cwd));
      const all = await Promise.all(ids.map((id) => getSubagentMessages(sessionId, id, dirOpt(cwd)).catch(() => [])));
      return subagentEvents(all.flat());
    },

    renameSession: (sessionId, title, cwd) => renameSession(sessionId, title, dirOpt(cwd)),
    deleteSession: (sessionId, cwd) => deleteSession(sessionId, dirOpt(cwd)),

    async fork({ sessionId, cwd, uuid }) {
      const res = await forkSession(sessionId, { ...(cwd ? { dir: cwd } : {}), ...(uuid ? { upToMessageId: uuid } : {}) });
      return res.sessionId;
    },

    /** Tail of a finished background task's output file (only files reported by task notifications). */
    taskOutput(file) {
      const abs = path.resolve(String(file));
      if (!outputFiles.has(abs.toLowerCase()) || !fs.existsSync(abs)) return null;
      const size = fs.statSync(abs).size;
      const start = Math.max(0, size - 64 * 1024);
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        // Windows console tools (ping, cmd, ...) write in the OEM code page, not UTF-8.
        let text = buf.toString('utf8');
        if (text.includes('�')) {
          try {
            text = new TextDecoder('ibm866').decode(buf);
          } catch {}
        }
        return { text, truncated: start > 0 };
      } finally {
        fs.closeSync(fd);
      }
    },

    /**
     * A full Claude Code task without a UI thread; resolves with its final text. The session is saved,
     * so it shows up in the sidebar. onEvent receives desk events.
     */
    async runHeadless({ prompt, cwd, model, effort, permissionMode = 'acceptEdits', timeoutMs = 30 * 60000, onEvent, resume, dirs, abortController, canUseTool, tools, instructions }) {
      const q = query({
        prompt: String(prompt),
        options: {
          ...exeOption,
          cwd: cwd || os.homedir(),
          model: model || undefined,
          effort: effort || undefined,
          permissionMode,
          allowDangerouslySkipPermissions: true,
          ...(resume ? { resume } : {}),
          ...(abortController ? { abortController } : {}),
          // Lets a caller ask the user before risky tool calls.
          ...(canUseTool ? { canUseTool } : {}),
          ...(dirs?.length ? { additionalDirectories: dirs } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code', ...(instructions ? { append: instructions } : {}) },
          mcpServers: sdkServers(tools),
        },
      });
      const translator = createTranslator('live');
      let result = { text: '', sessionId: null, isError: false, durationMs: 0, costUsd: 0 };
      try {
        await withTimeout(
          (async () => {
            for await (const m of q) {
              for (const ev of translator.push(m)) onEvent?.(ev);
              if (m.type === 'system' && m.subtype === 'init') result.sessionId = m.session_id;
              if (m.type === 'result') {
                result = { ...result, text: m.result ?? '', isError: Boolean(m.is_error), durationMs: m.duration_ms ?? 0, costUsd: m.total_cost_usd ?? 0 };
                recordTurn(cwd, m);
              }
            }
          })(),
          timeoutMs,
          'background task',
        );
      } finally {
        q.close();
      }
      return result;
    },

    /** One-shot text completion without tools (defaults to Haiku). */
    async quickText({ prompt, system = 'You are a concise assistant.', model = 'haiku', timeoutMs = 90000 }) {
      return (await oneShot({ prompt, system, model, timeoutMs, label: 'quickText' })).trim();
    },
  };
}

export default createClaudeProvider;

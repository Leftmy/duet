// Bridge between the renderer and Claude Code via the Agent SDK.
// Each UI thread owns one long-lived streaming-input query, so model, effort and
// permission mode can be switched mid-session and turns can be interrupted.
import {
  query,
  listSessions,
  getSessionMessages,
  listSubagents,
  forkSession,
  getSubagentMessages,
  renameSession,
  deleteSession,
} from '@anthropic-ai/claude-agent-sdk';
import { listSegments, loadSegment } from './segments.mjs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sessionToolsServer } from './session-tools.mjs';
import { t as tr } from './i18n.mjs';

// In the packaged app the SDK's claude.exe lives in app.asar.unpacked; point the SDK at it explicitly.
const CLAUDE_EXE = (() => {
  try {
    const pkg = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json');
    if (!pkg.includes('app.asar')) return undefined;
    const exe = path.join(path.dirname(pkg), 'claude.exe').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
})();
const exeOption = CLAUDE_EXE ? { pathToClaudeCodeExecutable: CLAUDE_EXE } : {};

/** The Claude Code CLI binary that ships with the SDK (used for claude mcp ...). */
export function claudeCli() {
  try {
    const pkg = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json');
    const exe = path.join(path.dirname(pkg), 'claude.exe').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (fs.existsSync(exe)) return exe;
  } catch {}
  return 'claude';
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

function userMessage(text, images = [], uuid, priority) {
  const content = [
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
    ...(text ? [{ type: 'text', text }] : []),
  ];
  return {
    type: 'user',
    message: { role: 'user', content: images.length ? content : text },
    parent_tool_use_id: null,
    ...(uuid ? { uuid } : {}),
    // 'next' folds the message into the running turn at the next tool boundary (no interrupt).
    ...(priority ? { priority } : {}),
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

const supportsAdaptiveThinking = (model) => !/haiku/i.test(model || '');

export function createBridge({ emit, browser, stats, log = () => {} }) {
  const threads = new Map();
  // Main-process listeners of one thread's events (e.g. the Telegram bot following a chat it started).
  const observers = new Map();
  const out = (channel, payload) => {
    emit(channel, payload);
    const set = observers.get(payload?.threadId);
    if (set) for (const cb of [...set]) {
      try {
        cb(channel, payload);
      } catch (e) {
        log('observer error', e);
      }
    }
  };
  const outputFiles = new Set();
  let probeCache = null;

  function options(t) {
    return {
      ...exeOption,
      cwd: t.cwd,
      ...(t.dirs?.length ? { additionalDirectories: t.dirs } : {}),
      model: t.model || undefined,
      effort: t.effort || undefined,
      permissionMode: t.permissionMode || 'default',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      // Full subagent conversations + short live progress lines for the Agents panel.
      forwardSubagentText: true,
      // Lets the UI roll files back to any earlier user message.
      enableFileCheckpointing: true,
      agentProgressSummaries: true,
      ...(supportsAdaptiveThinking(t.model) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      resume: t.resume || undefined,
      // Conversation rewind: continue the session from an earlier message.
      ...(t.resume && t.resumeAt ? { resumeSessionAt: t.resumeAt } : {}),
      // Built-in browser tools (mcp__desk-browser__*) and, if enabled, Claude in Chrome.
      mcpServers: { ccd_session: sessionToolsServer(), ...(browser ? { 'desk-browser': browser.mcpServer(t.id) } : {}) },
      ...(t.chrome != null ? { extraArgs: t.chrome ? { chrome: null } : { 'no-chrome': null } } : {}),
      canUseTool: (toolName, input, opts) => askPermission(t, toolName, input, opts),
      stderr: (chunk) => {
        t.stderrTail = (t.stderrTail + chunk).slice(-4000);
      },
    };
  }

  function askPermission(t, toolName, input, opts) {
    return new Promise((resolve) => {
      const reqId = randomUUID();
      const finish = (result) => {
        if (!t.pending.has(reqId)) return;
        t.pending.delete(reqId);
        resolve(result);
      };
      t.pending.set(reqId, { resolve: finish, input, suggestions: opts.suggestions });
      out('claude:permission', {
        threadId: t.id,
        reqId,
        toolName,
        input,
        toolUseID: opts.toolUseID,
        agentID: opts.agentID,
        title: opts.title,
        displayName: opts.displayName,
        description: opts.description,
        decisionReason: opts.decisionReason,
        blockedPath: opts.blockedPath,
        canAlways: !opts.suppressAlwaysAllowRule && Boolean(opts.suggestions?.length),
      });
      opts.signal?.addEventListener(
        'abort',
        () => {
          finish({ behavior: 'deny', message: 'Aborted' });
          out('claude:permission-cancel', { threadId: t.id, reqId });
        },
        { once: true },
      );
    });
  }

  function start(t) {
    t.input = new InputQueue();
    t.stderrTail = '';
    const q = query({ prompt: t.input, options: options(t) });
    t.resumeAt = undefined;
    t.q = q;
    (async () => {
      let error = null;
      try {
        for await (const msg of q) {
          if (msg.type === 'system' && msg.subtype === 'init') t.sessionId = msg.session_id;
          if (msg.type === 'result' && !msg.parent_tool_use_id) {
            try {
              stats?.recordTurn({ cwd: t.cwd }, msg);
            } catch {}
          }
          if (msg.type === 'system' && msg.subtype === 'task_notification' && msg.output_file) {
            outputFiles.add(path.resolve(msg.output_file).toLowerCase());
          }
          if (msg.type === 'result' && !msg.parent_tool_use_id) t.running = false;
          out('claude:event', { threadId: t.id, msg });
        }
      } catch (e) {
        error = String(e?.message || e);
        log('query error', t.id, error, t.stderrTail);
      }
      if (t.q === q) {
        t.q = null;
        t.input = null;
        t.resume = t.sessionId || t.resume;
      }
      for (const p of [...t.pending.values()]) p.resolve({ behavior: 'deny', message: 'Session closed' });
      t.pending.clear();
      t.running = false;
      out('claude:closed', { threadId: t.id, error, stderr: error ? t.stderrTail.slice(-1500) : undefined });
    })();
  }

  return {
    async probe(force = false) {
      if (probeCache && !force) return probeCache;
      const input = new InputQueue();
      const q = query({ prompt: input, options: { ...exeOption, cwd: os.homedir() } });
      try {
        const init = await withTimeout(q.initializationResult(), 60000, 'initialize');
        let usage = null;
        try {
          usage = await withTimeout(
            q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
            15000,
            'usage',
          );
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
          mcp,
          version: (await q.initializationResult().catch(() => ({})))?.claude_code_version,
          models: init.models ?? [],
          account: init.account ?? {},
          commands: (init.commands ?? []).map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
          })),
          usage,
        };
        try {
          stats?.recordLimits(usage);
        } catch {}
        return probeCache;
      } finally {
        input.close();
        q.close();
      }
    },

    /** Runs n(query) on a live session if there is one, else on a short-lived one. */
    async withQuery(fn) {
      for (const t of threads.values()) if (t.q) return fn(t.q);
      const input = new InputQueue();
      const q = query({ prompt: input, options: { ...exeOption, cwd: os.homedir() } });
      try {
        await withTimeout(q.initializationResult(), 60000, 'initialize');
        return await fn(q);
      } finally {
        input.close();
        q.close();
      }
    },

    async mcpStatus() {
      return this.withQuery(async (q) =>
        (await q.mcpServerStatus()).map((m) => ({ name: m.name, status: m.status, scope: m.scope ?? m.source, tools: m.tools?.length ?? 0, error: m.error })),
      );
    },

    async mcpReconnect(name) {
      return this.withQuery((q) => q.reconnectMcpServer(name));
    },

    async usage() {
      for (const t of threads.values()) {
        if (!t.q) continue;
        try {
          const u = await withTimeout(
            t.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
            15000,
            'usage',
          );
          try {
            stats?.recordLimits(u);
          } catch {}
          return u;
        } catch {
          break;
        }
      }
      return (await this.probe(true)).usage;
    },

    async listSessions() {
      const sessions = await listSessions({ limit: 300 });
      return sessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || tr('claude.untitled'),
        cwd: s.cwd || '',
        gitBranch: s.gitBranch,
        lastModified: s.lastModified,
        createdAt: s.createdAt,
      }));
    },

    /** Names a new chat with a quick Haiku call and stores it as the session's custom title. */
    async autoTitle({ sessionId, cwd, text }) {
      const prompt =
        "Write a short title (2–5 words) for a chat based on the user's first message. " +
        'Write it in the language of the message. Reply with the title only — no quotes, emoji or trailing period.\n\n' +
        `Message:\n${String(text).slice(0, 2000)}`;
      const q = query({
        prompt,
        options: {
          ...exeOption,
          cwd: os.homedir(),
          model: 'haiku',
          maxTurns: 1,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          persistSession: false,
          systemPrompt: 'You name chat conversations. Reply with the title only.',
        },
      });
      let out = '';
      try {
        await withTimeout(
          (async () => {
            for await (const m of q) {
              if (m.type === 'result' && m.subtype === 'success') out = m.result ?? '';
            }
          })(),
          45000,
          'title',
        );
      } finally {
        q.close();
      }
      const title = out
        .split('\n')[0]
        .replace(/^[\s"'«»“”#*]+|[\s"'«»“”.*]+$/g, '')
        .slice(0, 80);
      if (!title) return null;
      await renameSession(sessionId, title, cwd ? { dir: cwd } : undefined);
      return title;
    },

    /** All subagent transcripts of a saved session, each message tagged with its spawning tool_use id. */
    async loadSubagents(sessionId, cwd) {
      const opts = cwd ? { dir: cwd } : undefined;
      const ids = await listSubagents(sessionId, opts);
      const all = await Promise.all(ids.map((id) => getSubagentMessages(sessionId, id, opts).catch(() => [])));
      return all.flat();
    },

    /** One-shot text completion without tools (defaults to Haiku). Used by feature modules. */
    async quickText({ prompt, system = 'You are a concise assistant.', model = 'haiku', timeoutMs = 90000 }) {
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
          'quickText',
        );
      } finally {
        q.close();
      }
      return out.trim();
    },

    /**
     * Runs a full Claude Code task in the background (no UI thread) and resolves with its final text.
     * The session is saved, so it shows up in the sidebar and can be opened later.
     */
    async runHeadless({ prompt, cwd, model, effort, permissionMode = 'acceptEdits', timeoutMs = 30 * 60000, onEvent, resume, dirs, abortController, canUseTool }) {
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
          // Lets a caller (e.g. the Telegram bot) ask the user before risky tool calls.
          ...(canUseTool ? { canUseTool } : {}),
          ...(dirs?.length ? { additionalDirectories: dirs } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          mcpServers: { ccd_session: sessionToolsServer(), ...(browser ? { 'desk-browser': browser.mcpServer(`headless-${Date.now()}`) } : {}) },
        },
      });
      let result = { text: '', sessionId: null, isError: false, durationMs: 0, costUsd: 0 };
      try {
        await withTimeout(
          (async () => {
            for await (const m of q) {
              onEvent?.(m);
              if (m.type === 'system' && m.subtype === 'init') result.sessionId = m.session_id;
              if (m.type === 'result') {
                result = { ...result, text: m.result ?? '', isError: Boolean(m.is_error), durationMs: m.duration_ms ?? 0, costUsd: m.total_cost_usd ?? 0 };
                try {
                  stats?.recordTurn({ cwd }, m);
                } catch {}
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

    /** Drafts a conventional one-line commit message for the given diff with a quick Haiku call. */
    async commitMessage(diff) {
      const q = query({
        prompt:
          'Write a git commit message for this diff. One subject line in English, imperative mood, at most 72 characters, ' +
          'optionally followed by a blank line and up to 3 short bullet lines. Output only the message. ' +
          'Never mention AI, assistants, Claude or co-authors.\n\n' +
          String(diff).slice(0, 24000),
        options: {
          ...exeOption,
          cwd: os.homedir(),
          model: 'haiku',
          maxTurns: 1,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          persistSession: false,
          systemPrompt: 'You write concise git commit messages.',
        },
      });
      let out = '';
      try {
        for await (const m of q) if (m.type === 'result' && m.subtype === 'success') out = m.result ?? '';
      } finally {
        q.close();
      }
      return out
        .replace(/^```\w*\n?|```$/g, '')
        .split('\n')
        .filter((l) => !/co-authored-by|generated with/i.test(l))
        .join('\n')
        .trim();
    },

    loadSession(sessionId, cwd, segment) {
      if (segment != null) return loadSegment(sessionId, cwd, segment);
      return getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined);
    },

    listSegments(sessionId, cwd) {
      return listSegments(sessionId, cwd);
    },

    renameSession(sessionId, title, cwd) {
      return renameSession(sessionId, title, cwd ? { dir: cwd } : undefined);
    },

    async deleteSession(sessionId, cwd) {
      return deleteSession(sessionId, cwd ? { dir: cwd } : undefined);
    },

    send({ threadId, cwd, model, effort, permissionMode, resume, text, images, uuid, chrome, dirs, priority }) {
      let t = threads.get(threadId);
      if (!t) {
        t = { id: threadId, pending: new Map(), q: null, input: null, stderrTail: '' };
        threads.set(threadId, t);
      }
      if (!t.q) {
        Object.assign(t, { cwd, dirs, model, effort, permissionMode, chrome, resume: resume || t.sessionId || t.resume });
        start(t);
      }
      t.input.push(userMessage(text, images, uuid, priority));
      t.running = true;
      return true;
    },

    /**
     * Runs a prompt as a regular app chat, so it shows up in the sidebar and streams live in the UI.
     * The renderer creates/opens the thread and sends the message; follow it with observe(threadId).
     * resume = session id of an existing chat to continue.
     */
    async startVisible({ prompt, cwd, dirs, model, effort, permissionMode, resume, projectId, source = 'external', timeoutMs = 15000 }) {
      const existing = resume ? [...threads.values()].find((x) => x.sessionId === resume || x.id === resume) : undefined;
      if (existing?.running) throw new Error(tr('claude.chatBusy'));
      const threadId = existing?.id ?? resume ?? `ext-${randomUUID()}`;
      emit('desk:external-run', { threadId, prompt, cwd, dirs, model, effort, permissionMode, resume, projectId, source });
      // Wait until the renderer actually sent it (the UI may still be loading).
      // The UI may already show this session under another thread id; accept whichever thread picks it up.
      const started = Date.now();
      const find = () =>
        [...threads.values()].find((x) => x.running && (x.id === threadId || (resume && (x.sessionId === resume || x.resume === resume))));
      let hit;
      while (!(hit = find())) {
        if (Date.now() - started > timeoutMs) throw new Error(tr('claude.uiNotReady'));
        await new Promise((r) => setTimeout(r, 100));
      }
      return { threadId: hit.id };
    },

    /** Subscribe to one thread's claude:event / permission / permission-cancel / closed. Returns unsubscribe. */
    observe(threadId, cb) {
      let set = observers.get(threadId);
      if (!set) observers.set(threadId, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (!set.size) observers.delete(threadId);
      };
    },

    isRunning(threadId) {
      return Boolean(threads.get(threadId)?.running);
    },

    sessionOf(threadId) {
      return threads.get(threadId)?.sessionId ?? null;
    },

    async configure({ threadId, model, effort, permissionMode }) {
      const t = threads.get(threadId);
      if (!t) return false;
      if (model !== undefined) {
        t.model = model;
        if (t.q) await t.q.setModel(model);
      }
      if (effort !== undefined) {
        t.effort = effort;
        if (t.q) await t.q.applyFlagSettings({ effortLevel: effort });
      }
      if (permissionMode !== undefined) {
        t.permissionMode = permissionMode;
        if (t.q) await t.q.setPermissionMode(permissionMode);
      }
      return true;
    },

    async contextUsage(threadId) {
      const t = threads.get(threadId);
      if (!t?.q) return null;
      const u = await withTimeout(t.q.getContextUsage({ detail: 'summary' }), 15000, 'context');
      return {
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        percentage: u.percentage,
        categories: u.categories.filter((c) => c.kind === 'used' && c.tokens > 0).map((c) => ({ name: c.name, tokens: c.tokens, color: c.color })),
      };
    },

    /** Rolls tracked files back to their state at a user message. Starts the session if it isn't live. */
    async rewind({ threadId, uuid, dryRun, config }) {
      let t = threads.get(threadId);
      if (!t) {
        t = { id: threadId, pending: new Map(), q: null, input: null, stderrTail: '' };
        threads.set(threadId, t);
      }
      if (!t.q) {
        Object.assign(t, config, { resume: config.resume || t.sessionId || t.resume });
        start(t);
        await withTimeout(t.q.initializationResult(), 60000, 'initialize');
      }
      return t.q.rewindFiles(uuid, { dryRun: Boolean(dryRun) });
    },

    /** Drops the conversation after 
esumeAt (null = from the very start); the next message continues from there. */
    rewindConversation({ threadId, resumeAt }) {
      let t = threads.get(threadId);
      if (!t) {
        t = { id: threadId, pending: new Map(), q: null, input: null, stderrTail: '' };
        threads.set(threadId, t);
      }
      const q = t.q;
      t.q = null;
      t.input?.close();
      t.input = null;
      q?.close();
      if (resumeAt) {
        t.resume = t.sessionId || t.resume;
        t.resumeAt = resumeAt;
      } else {
        t.resume = undefined;
        t.sessionId = undefined;
        t.resumeAt = undefined;
      }
      return true;
    },

    async fork({ sessionId, cwd, uuid }) {
      const res = await forkSession(sessionId, { ...(cwd ? { dir: cwd } : {}), ...(uuid ? { upToMessageId: uuid } : {}) });
      return res.sessionId;
    },

    async interrupt(threadId) {
      const t = threads.get(threadId);
      if (t?.q) await t.q.interrupt();
      return true;
    },

    async stopTask(threadId, taskId) {
      const t = threads.get(threadId);
      if (!t?.q) throw new Error(tr('claude.sessionInactive'));
      await t.q.stopTask(taskId);
      return true;
    },

    /** Moves a running foreground Bash/agent call to the background (like Ctrl+B in the CLI). */
    async backgroundTask(threadId, toolUseId) {
      const t = threads.get(threadId);
      if (!t?.q) throw new Error(tr('claude.sessionInactive'));
      return t.q.backgroundTasks(toolUseId);
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

    respondPermission({ threadId, reqId, decision, updatedInput, message }) {
      const p = threads.get(threadId)?.pending.get(reqId);
      if (!p) return false;
      if (decision === 'deny') {
        p.resolve({ behavior: 'deny', message: message || 'The user declined this action.' });
      } else {
        p.resolve({
          behavior: 'allow',
          updatedInput: updatedInput ?? p.input,
          ...(decision === 'always' && p.suggestions?.length ? { updatedPermissions: p.suggestions } : {}),
        });
      }
      // Answered somewhere (app or Telegram): drop the request everywhere else.
      out('claude:permission-cancel', { threadId, reqId });
      return true;
    },

    closeThread(threadId) {
      browser?.dispose(threadId);
      const t = threads.get(threadId);
      if (!t) return;
      t.input?.close();
      t.q?.close();
      threads.delete(threadId);
    },

    closeAll() {
      for (const id of [...threads.keys()]) this.closeThread(id);
    },
  };
}

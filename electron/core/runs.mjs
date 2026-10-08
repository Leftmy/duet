// The core: UI threads → provider runs. Routes desk events to the renderer and main-process
// observers (Telegram), brokers permission requests, and exposes provider-neutral session ops.
// IPC channels: agent:event { threadId, ev }, agent:permission, agent:permission-cancel, agent:closed.
import { randomUUID } from 'node:crypto';
import { t as tr } from '../i18n.mjs';

/**
 * toolsFor(key, { depth }) → desk toolsets (core/tools.mjs) a run gets; key is the thread id (it scopes
 * per-chat state such as the browser page), depth is 0 for chats and grows for agents they start.
 */

/** Permission modes from least to most autonomous; a subagent never gets more than its parent. */
const MODE_ORDER = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
const atMost = (mode, cap) => (MODE_ORDER.indexOf(mode) <= MODE_ORDER.indexOf(cap) ? mode : cap);

/** Events of a subagent that belong in its parent's feed (as the subagent's own transcript). */
const SUBAGENT_EVENTS = new Set(['text', 'thinking', 'tool', 'tool.delta', 'tool.output', 'tool.result']);
export function createCore({ emit, registry, browser, toolsFor = () => [], log = () => {} }) {
  const threads = new Map();
  // Main-process listeners of one thread's events (e.g. the Telegram bot following a chat it started).
  const observers = new Map();
  const out = (channel, payload) => {
    emit(channel, payload);
    const set = observers.get(payload?.threadId);
    if (set)
      for (const cb of [...set]) {
        try {
          cb(channel, payload);
        } catch (e) {
          log('observer error', e);
        }
      }
  };

  const thread = (id, provider) => {
    let t = threads.get(id);
    if (!t) threads.set(id, (t = { id, provider: provider || 'claude', pending: new Map(), run: null, running: false }));
    return t;
  };
  const providerOf = (t) => registry.get(t.provider);

  function askPermission(t, req) {
    return new Promise((resolve) => {
      const reqId = randomUUID();
      const { signal, ...rest } = req;
      const finish = (result) => {
        if (!t.pending.has(reqId)) return;
        t.pending.delete(reqId);
        resolve(result);
      };
      t.pending.set(reqId, { resolve: finish, input: req.input });
      out('agent:permission', { threadId: t.id, reqId, provider: t.provider, ...rest });
      signal?.addEventListener(
        'abort',
        () => {
          finish({ decision: 'deny', message: 'Aborted' });
          out('agent:permission-cancel', { threadId: t.id, reqId });
        },
        { once: true },
      );
    });
  }

  function start(t) {
    const p = providerOf(t);
    const c = t.config;
    // Assigned after open() returns; events of a run that is no longer the thread's are dropped.
    let run = null;
    run = p.open(
      {
        threadId: t.id,
        cwd: c.cwd,
        dirs: c.dirs,
        model: c.model,
        effort: c.effort,
        permissionMode: c.permissionMode,
        chrome: c.chrome,
        resume: t.resume,
        resumeAt: t.resume ? t.resumeAt : undefined,
        instructions: c.instructions,
        tools: toolsFor(t.id, { depth: t.depth ?? 0 }),
      },
      {
        event(ev) {
          if (t.run !== run) return;
          if (ev.type === 'session') t.sessionId = ev.sessionId;
          if (ev.type === 'turn.end') t.running = false;
          // Plan limits are per agent; say whose they are.
          if (ev.type === 'limits') ev = { ...ev, provider: t.provider };
          if (t.sub) return subagentEvent(t, ev);
          out('agent:event', { threadId: t.id, ev });
        },
        // A subagent asks in its parent's chat.
        approval: (req) =>
          t.sub
            ? askPermission(thread(t.sub.parentId), { ...req, agentID: t.sub.toolUseId, displayName: `${providerOf(t).label}: ${req.displayName ?? req.toolName}` })
            : askPermission(t, req),
        closed({ error, stderr } = {}) {
          if (t.run === run) {
            t.run = null;
            t.resume = t.sessionId || t.resume;
          }
          for (const p of [...t.pending.values()]) p.resolve({ decision: 'deny', message: 'Session closed' });
          t.pending.clear();
          t.running = false;
          if (t.sub) return finishSubagent(t, error ? 'error' : 'stopped', error ? String(error) : t.sub.text);
          out('agent:closed', { threadId: t.id, error: error ?? null, stderr });
        },
      },
    );
    t.resumeAt = undefined;
    // Handoff instructions only apply to the run they were given for.
    t.config = { ...c, instructions: undefined };
    t.run = run;
    return run;
  }

  function stop(t) {
    const run = t.run;
    t.run = null;
    run?.close();
  }

  // ---------- subagents: runs started by another run's run_agent tool ----------

  /** Sends one of a subagent's events to its parent chat. */
  const toParent = (t, ev) => out('agent:event', { threadId: t.sub.parentId, ev });

  function subagentEvent(t, ev) {
    const s = t.sub;
    if (SUBAGENT_EVENTS.has(ev.type)) {
      toParent(t, { ...ev, agent: s.toolUseId });
      if (ev.type === 'tool' && ev.final) toParent(t, { type: 'tool.sub', id: s.toolUseId, name: ev.name, input: ev.input });
    } else if (ev.type === 'turn.end') {
      finishSubagent(t, ev.isError ? 'error' : 'done', ev.isError ? ev.error || ev.text || '' : ev.text ?? '');
    } else if (ev.type === 'limits') toParent(t, ev);
    // The subagent's own session: the UI keeps it out of the chat list.
    else if (ev.type === 'session') toParent(t, { type: 'agent', id: s.toolUseId, sessionId: ev.sessionId });
  }

  function finishSubagent(t, status, text) {
    const s = t.sub;
    if (s.status !== 'running') return;
    s.status = status;
    s.text = text;
    toParent(t, { type: 'agent', id: s.toolUseId, status, result: text });
    for (const w of s.waiters.splice(0)) w();
  }

  /** Subagents a thread started, for cascading stops. */
  const childrenOf = (id) => [...threads.values()].filter((x) => x.sub?.parentId === id);

  const liveRun = (threadId) => {
    const t = threads.get(threadId);
    if (!t?.run) throw new Error(tr('claude.sessionInactive'));
    return t.run;
  };

  const core = {
    registry,

    /** Probe of every provider, keyed by id; the default (Claude) one is also spread at the top level. */
    async probe(force = false) {
      const entries = await Promise.all(
        registry.all().map(async (p) => {
          try {
            return [p.id, { ...(await p.probe(force)), label: p.label, caps: p.caps }];
          } catch (e) {
            log('probe failed', p.id, String(e?.message || e));
            return [p.id, { available: false, error: String(e?.message || e), label: p.label, caps: p.caps, models: [] }];
          }
        }),
      );
      const providers = Object.fromEntries(entries);
      if (!providers.claude?.available) throw new Error(providers.claude?.error || 'Claude is unavailable');
      return { ...providers.claude, providers };
    },

    usage: (provider) => registry.get(provider).usage?.() ?? null,

    async listSessions() {
      const lists = await Promise.all(
        registry.all().map((p) =>
          p.listSessions().catch((e) => {
            log('listSessions failed', p.id, String(e?.message || e));
            return [];
          }),
        ),
      );
      return lists.flat().sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    },

    loadSession: (sessionId, cwd, segment, provider) => registry.get(provider).loadHistory(sessionId, cwd, segment),
    listSegments: (sessionId, cwd, provider) => registry.get(provider).listSegments?.(sessionId, cwd) ?? [],
    loadSubagents: (sessionId, cwd, provider) => registry.get(provider).loadSubagents?.(sessionId, cwd) ?? [],
    renameSession: (sessionId, title, cwd, provider) => registry.get(provider).renameSession(sessionId, title, cwd),
    deleteSession: (sessionId, cwd, provider) => registry.get(provider).deleteSession(sessionId, cwd),

    send({ threadId, provider, cwd, dirs, model, effort, permissionMode, resume, text, images, uuid, chrome, priority, instructions }) {
      const t = thread(threadId, provider);
      if (provider && provider !== t.provider) {
        // The chat moved to another agent: the old run ends, the new one starts fresh or resumes its own session.
        stop(t);
        t.provider = provider;
        t.sessionId = undefined;
        t.resume = resume;
      }
      if (!t.run) {
        t.config = { cwd, dirs, model, effort, permissionMode, chrome, instructions };
        t.resume = resume || t.sessionId || t.resume;
        start(t);
      }
      t.run.send({ text, images, uuid, priority });
      t.running = true;
      return true;
    },

    /**
     * Runs a prompt as a regular app chat, so it shows up in the sidebar and streams live in the UI.
     * The renderer creates/opens the thread and sends the message; follow it with observe(threadId).
     * resume = session id of an existing chat to continue.
     */
    async startVisible({ prompt, cwd, dirs, model, effort, permissionMode, resume, projectId, provider, source = 'external', timeoutMs = 15000 }) {
      const existing = resume ? [...threads.values()].find((x) => x.sessionId === resume || x.id === resume) : undefined;
      if (existing?.running) throw new Error(tr('claude.chatBusy'));
      const threadId = existing?.id ?? resume ?? `ext-${randomUUID()}`;
      emit('desk:external-run', { threadId, prompt, cwd, dirs, model, effort, permissionMode, resume, projectId, provider, source });
      // Wait until the renderer actually sent it (the UI may still be loading).
      // The UI may already show this session under another thread id; accept whichever thread picks it up.
      const started = Date.now();
      const find = () => [...threads.values()].find((x) => x.running && (x.id === threadId || (resume && (x.sessionId === resume || x.resume === resume))));
      let hit;
      while (!(hit = find())) {
        if (Date.now() - started > timeoutMs) throw new Error(tr('claude.uiNotReady'));
        await new Promise((r) => setTimeout(r, 100));
      }
      return { threadId: hit.id };
    },

    /** Subscribe to one thread's agent:event / permission / permission-cancel / closed. Returns unsubscribe. */
    observe(threadId, cb) {
      let set = observers.get(threadId);
      if (!set) observers.set(threadId, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (!set.size) observers.delete(threadId);
      };
    },

    isRunning: (threadId) => Boolean(threads.get(threadId)?.running),
    sessionOf: (threadId) => threads.get(threadId)?.sessionId ?? null,
    providerOf: (threadId) => threads.get(threadId)?.provider ?? null,

    async configure({ threadId, model, effort, permissionMode }) {
      const t = threads.get(threadId);
      if (!t) return false;
      const patch = Object.fromEntries(Object.entries({ model, effort, permissionMode }).filter(([, v]) => v !== undefined));
      t.config = { ...t.config, ...patch };
      if (t.run) await t.run.configure(patch);
      return true;
    },

    async contextUsage(threadId) {
      const run = threads.get(threadId)?.run;
      return run?.contextUsage ? run.contextUsage() : null;
    },

    /** Rolls tracked files back to their state at a user message. Starts the session if it isn't live. */
    async rewind({ threadId, uuid, dryRun, config }) {
      const t = thread(threadId, config?.provider);
      if (!t.run) {
        t.config = { ...config };
        t.resume = config.resume || t.sessionId || t.resume;
        start(t);
        await t.run.ready?.();
      }
      if (!t.run.rewindFiles) throw new Error('Not supported by this agent');
      return t.run.rewindFiles(uuid, dryRun);
    },

    /**
     * Drops the end of the conversation; the next message continues from there. Anchor agents (Claude)
     * resume at resumeAt (null = from the very start); turn-based ones (Codex) drop the last dropTurns turns.
     */
    async rewindConversation({ threadId, resumeAt, dropTurns, sessionId, provider }) {
      const t = thread(threadId, provider);
      stop(t);
      const p = registry.get(provider ?? t.provider);
      if (p.caps.rollback === 'turns') {
        const sid = sessionId || t.sessionId || t.resume;
        if (sid && dropTurns > 0) await p.rollback(sid, dropTurns);
        t.resume = sid;
        t.resumeAt = undefined;
        return true;
      }
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

    fork: ({ sessionId, cwd, uuid, provider }) => registry.get(provider).fork({ sessionId, cwd, uuid }),

    async interrupt(threadId) {
      await threads.get(threadId)?.run?.interrupt();
      // Stopping a chat stops the agents it handed work to.
      for (const c of childrenOf(threadId)) if (c.sub.status === 'running') core.stopAgent(c.id);
      return true;
    },

    /**
     * Starts another agent on a task for a running chat (the run_agent tool). Its steps appear as a
     * subagent of the tool call toolUseId; returns { runId } at once — wait with waitAgent.
     */
    spawnAgent({ parentId, toolUseId, provider, prompt, model, readOnly, background }) {
      const parent = threads.get(parentId);
      const pc = parent?.config ?? {};
      const id = `sub-${randomUUID()}`;
      const t = thread(id, provider);
      const p = providerOf(t);
      t.depth = (parent?.depth ?? 0) + 1;
      t.sub = { parentId, toolUseId: toolUseId || id, status: 'running', text: '', waiters: [] };
      const mode = readOnly ? 'plan' : atMost(pc.permissionMode || 'default', 'bypassPermissions');
      t.config = { cwd: pc.cwd, dirs: pc.dirs, model, permissionMode: p.caps.modes?.includes(mode) ? mode : 'default' };
      toParent(t, {
        type: 'agent',
        id: t.sub.toolUseId,
        name: prompt.split('\n')[0].slice(0, 80),
        prompt,
        provider,
        ...(model ? { model } : {}),
        background: Boolean(background),
      });
      start(t);
      t.run.send({ text: prompt });
      t.running = true;
      return { runId: id };
    },

    /** Resolves once the subagent's current turn ends: { runId, status, text }. */
    waitAgent(runId, { signal, timeoutMs = 60 * 60000 } = {}) {
      const t = threads.get(runId);
      if (!t?.sub) return Promise.resolve({ runId, status: 'error', text: `Unknown run_id ${runId}` });
      const s = t.sub;
      const result = () => ({ runId, status: s.status, text: s.text });
      if (s.status !== 'running') return Promise.resolve(result());
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve(s.status === 'running' ? { runId, status: 'running', text: 'Still working — wait again later.' } : result());
        };
        const timer = setTimeout(done, timeoutMs);
        s.waiters.push(done);
        // The calling tool was cancelled (the parent turn stopped): stop the subagent with it.
        signal?.addEventListener('abort', () => core.stopAgent(runId), { once: true });
      });
    },

    /** A follow-up message to a subagent; resolves with its answer. */
    messageAgent(runId, text, opts) {
      const t = threads.get(runId);
      if (!t?.sub) return Promise.resolve({ runId, status: 'error', text: `Unknown run_id ${runId}` });
      if (t.sub.status === 'running') return Promise.resolve({ runId, status: 'running', text: 'Still working on the previous task — use wait_agent first.' });
      t.sub.status = 'running';
      toParent(t, { type: 'agent', id: t.sub.toolUseId, status: 'running' });
      toParent(t, { type: 'agent.msg', agent: t.sub.toolUseId, dir: 'to', text, label: 'message' });
      if (!t.run) start(t);
      t.run.send({ text });
      t.running = true;
      return core.waitAgent(runId, opts);
    },

    stopAgent(runId) {
      const t = threads.get(runId);
      if (!t?.sub) return false;
      if (t.sub.status === 'running') finishSubagent(t, 'stopped', t.sub.text || 'Stopped.');
      stop(t);
      return true;
    },

    async stopTask(threadId, taskId) {
      await liveRun(threadId).stopTask(taskId);
      return true;
    },

    backgroundTask: (threadId, toolUseId) => liveRun(threadId).backgroundTask(toolUseId),

    taskOutput(file) {
      for (const p of registry.all()) {
        const r = p.taskOutput?.(file);
        if (r) return r;
      }
      return null;
    },

    respondPermission({ threadId, reqId, decision, updatedInput, message }) {
      const p = threads.get(threadId)?.pending.get(reqId);
      if (!p) return false;
      p.resolve({ decision, updatedInput, message });
      // Answered somewhere (app or Telegram): drop the request everywhere else.
      out('agent:permission-cancel', { threadId, reqId });
      return true;
    },

    closeThread(threadId) {
      browser?.dispose(threadId);
      const t = threads.get(threadId);
      if (!t) return;
      for (const c of childrenOf(threadId)) {
        core.stopAgent(c.id);
        threads.delete(c.id);
      }
      stop(t);
      threads.delete(threadId);
    },

    closeAll() {
      for (const id of [...threads.keys()]) core.closeThread(id);
      for (const p of registry.all()) p.close?.();
    },

    runHeadless: ({ provider, ...opts }) => registry.get(provider).runHeadless({ tools: toolsFor(`headless-${randomUUID()}`), ...opts }),
    mcpStatus: () => registry.get('claude').mcpStatus(),
    mcpReconnect: (name) => registry.get('claude').mcpReconnect(name),

    // ---------- small completions (Claude Haiku, whatever agent the chat uses) ----------

    quickText: (opts) => registry.get('claude').quickText(opts),

    /** Names a new chat with a quick completion and stores it as the session's title. */
    async autoTitle({ sessionId, cwd, text, provider }) {
      const out = await core.quickText({
        prompt:
          "Write a short title (2–5 words) for a chat based on the user's first message. " +
          'Write it in the language of the message. Reply with the title only — no quotes, emoji or trailing period.\n\n' +
          `Message:\n${String(text).slice(0, 2000)}`,
        system: 'You name chat conversations. Reply with the title only.',
        timeoutMs: 45000,
      });
      const title = out
        .split('\n')[0]
        .replace(/^[\s"'«»“”#*]+|[\s"'«»“”.*]+$/g, '')
        .slice(0, 80);
      if (!title) return null;
      await registry.get(provider).renameSession(sessionId, title, cwd);
      return title;
    },

    /** Drafts a conventional one-line commit message for the given diff. */
    async commitMessage(diff) {
      const out = await core.quickText({
        prompt:
          'Write a git commit message for this diff. One subject line in English, imperative mood, at most 72 characters, ' +
          'optionally followed by a blank line and up to 3 short bullet lines. Output only the message. ' +
          'Never mention AI, assistants, Claude or co-authors.\n\n' +
          String(diff).slice(0, 24000),
        system: 'You write concise git commit messages.',
        timeoutMs: 120000,
      });
      return out
        .replace(/^```\w*\n?|```$/g, '')
        .split('\n')
        .filter((l) => !/co-authored-by|generated with/i.test(l))
        .join('\n')
        .trim();
    },
  };
  return core;
}

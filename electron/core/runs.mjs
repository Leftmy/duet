// The core: UI threads → provider runs. Routes desk events to the renderer and main-process
// observers (Telegram), brokers permission requests, and exposes provider-neutral session ops.
// IPC channels: agent:event { threadId, ev }, agent:permission, agent:permission-cancel, agent:closed.
import { randomUUID } from 'node:crypto';
import { t as tr } from '../i18n.mjs';

/**
 * toolsFor(key) → desk toolsets (core/tools.mjs) a run gets; key is the thread id (it scopes per-chat
 * state such as the browser page).
 */
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
        tools: toolsFor(t.id),
      },
      {
        event(ev) {
          if (t.run !== run) return;
          if (ev.type === 'session') t.sessionId = ev.sessionId;
          if (ev.type === 'turn.end') t.running = false;
          out('agent:event', { threadId: t.id, ev });
        },
        approval: (req) => askPermission(t, req),
        closed({ error, stderr } = {}) {
          if (t.run === run) {
            t.run = null;
            t.resume = t.sessionId || t.resume;
          }
          for (const p of [...t.pending.values()]) p.resolve({ decision: 'deny', message: 'Session closed' });
          t.pending.clear();
          t.running = false;
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

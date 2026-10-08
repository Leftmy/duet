import { create } from 'zustand';
import type {
  Account,
  Approval,
  Effort,
  ImageAttachment,
  ModelInfo,
  PermMode,
  Project,
  SessionInfo,
  SlashCommand,
  ThemePref,
  Thread,
  WorktreeInfo,
  UsageSummary,
  ProviderId,
} from './types';
import type { ProviderProbe } from './desk';
import { applyAgentTranscripts, applyEvent, fromHistory } from './lib/reduce';
import { basename, normalizePct, uid } from './lib/format';
import { askConfirm } from './lib/dialog';
import { setLang, t as tr, type Lang } from './i18n';
import { isDetachedWindow } from './features/detach/mode';

interface Settings {
  language: Lang;
  theme: ThemePref;
  /** Agent of new chats. */
  provider: ProviderId;
  model: string;
  effort: Effort;
  permissionMode: PermMode;
  cwd: string;
  recentProjects: string[];
  sidebarOpen: boolean;
  collapsedProjects: string[];
  changesOpen: boolean;
  autoTitles: boolean;
  workMode: 'local' | 'worktree';
  notifications: boolean;
  chrome: boolean;
  followUp: 'steer' | 'queue';
  projects: Project[];
  /** Chat (session id, or thread id before it has one) → project id; '-' = explicitly outside any project. */
  chatProject: Record<string, string>;
  /** Archived chats (session ids). */
  archived: string[];
  /** Pinned chats (session ids), shown above projects. */
  pinned: string[];
}

export type PanelTab = 'chat' | 'git' | 'agents' | 'browser' | 'files' | 'terminal';

export interface ReviewComment {
  id: string;
  file: string;
  line: string;
  sign: '+' | '-' | ' ';
  text: string;
}

interface Toast {
  id: string;
  text: string;
  tone: 'info' | 'error';
}

interface State {
  ready: boolean;
  probeError?: string;
  account: Account;
  /** Every registered agent provider: availability, models, capabilities. */
  providers: Record<string, ProviderProbe>;
  models: ModelInfo[];
  commands: SlashCommand[];
  mcp: { name: string; status: string; scope?: string; tools: number }[];
  settingsOpen: boolean;
  zoomImage: string | null;
  /** Split view: two thread ids shown side by side (active one is focused). */
  split: string[] | null;
  /** Session ids open in detached windows (main window only). */
  detached: string[];
  editorFiles: string[];
  editorActive: string | null;
  review: Record<string, ReviewComment[]>;
  composerInsert: { seq: number; text: string } | null;
  updateAvailable: boolean;
  /** Number of open popovers/menus; native views (browser) hide while > 0. */
  overlays: number;
  openFile(path: string): void;
  closeFile(path: string): void;
  addReview(threadId: string, c: Omit<ReviewComment, 'id'>): void;
  removeReview(threadId: string, id: string): void;
  clearReview(threadId: string): void;
  sendReview(threadId: string): void;
  insertToComposer(text: string): void;
  startTaskChat(prompt: string, cwd?: string): void;
  usage: UsageSummary;
  sessions: SessionInfo[];
  sessionsLoaded: boolean;
  threads: Record<string, Thread>;
  activeId: string;
  settings: Settings;
  resolvedTheme: 'dark' | 'light';
  toasts: Toast[];
  search: string;
  panelTab: PanelTab;
  worktrees: Record<string, WorktreeInfo>;
  focusAgent?: string;

  init(): Promise<void>;
  setSettings(patch: Partial<Settings>): void;
  newThread(cwd?: string): string;
  openSession(s: SessionInfo, chain?: SessionInfo[]): void;
  loadEarlierPart(id: string, all?: boolean): Promise<void>;
  activate(id: string): void;
  /** Runs an "open" action and shows its result next to the current chat. */
  openSplit(open?: () => void): void;
  closeSplit(): void;
  send(id: string, text: string, images: ImageAttachment[]): void;
  interrupt(id: string): void;
  setModel(id: string, model: string): void;
  setEffort(id: string, effort: Effort): void;
  setPermissionMode(id: string, mode: PermMode): void;
  setCwd(id: string, cwd: string): void;
  /** Project modal: null = closed, {} = create, { id } = edit. */
  projectModal: { id?: string } | null;
  saveProject(p: { id?: string; name: string; folders: string[]; defaults?: Project['defaults'] }): string;
  pinChats(keys: string[], pinned: boolean): void;
  deleteProject(id: string): void;
  moveChat(key: string, projectId: string | null): void;
  archiveChats(keys: string[], archived: boolean): void;
  newThreadInProject(projectId: string): void;
  setThreadProject(id: string, projectId: string | null): void;
  setDraft(id: string, draft: string): void;
  setDraftImages(id: string, images: ImageAttachment[]): void;
  removeQueued(id: string, qid: string): void;
  stopTask(id: string, taskId: string): void;
  backgroundTask(id: string, toolUseId: string): void;
  dismissTask(id: string, taskId: string): void;
  respond(id: string, approval: Approval, decision: 'allow' | 'always' | 'deny', extra?: { updatedInput?: any; message?: string }): void;
  renameThread(id: string, title: string): void;
  deleteThread(id: string): void;
  refreshSessions(): Promise<void>;
  refreshUsage(): Promise<void>;
  toast(text: string, tone?: 'info' | 'error'): void;
  setSearch(q: string): void;
  setPanelTab(tab: PanelTab): void;
  openBrowser(): void;
  openAgent(agentId?: string): void;
  loadAgentTranscripts(id: string): void;
  openRewind(threadId: string, entryId: string): void;
  performRewind(threadId: string, entryId: string, mode: 'both' | 'conversation' | 'code'): Promise<void>;
  rewindDialog: { threadId: string; entryId: string } | null;
  setWorkMode(id: string, mode: 'local' | 'worktree'): void;
  worktreeApply(id: string): Promise<void>;
  worktreeRemove(id: string): Promise<void>;
  forkFrom(id: string, uuid?: string): Promise<void>;
}

const DEFAULT_SETTINGS: Settings = {
  language: 'en',
  theme: 'system',
  provider: 'claude',
  model: 'default',
  effort: 'high',
  permissionMode: 'default',
  cwd: '',
  recentProjects: [],
  sidebarOpen: true,
  collapsedProjects: [],
  changesOpen: false,
  autoTitles: true,
  workMode: 'local',
  notifications: true,
  chrome: true,
  followUp: 'steer',
  projects: [],
  chatProject: {},
  archived: [],
  pinned: [],
};

const normDir = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
const sameDir = (a: string, b: string) => normDir(a) === normDir(b);

/** Which project a chat belongs to: explicit assignment first, else the project that owns its folder. */
export function projectOf(s: { projects: Project[]; chatProject: Record<string, string> }, key: string | undefined, cwd: string) {
  const explicit = key ? s.chatProject[key] : undefined;
  if (explicit === '-') return undefined;
  if (explicit) {
    const p = s.projects.find((x) => x.id === explicit);
    if (p) return p;
  }
  return cwd ? s.projects.find((p) => p.folders.some((f) => sameDir(f, cwd))) : undefined;
}

// Stored titles were written under whatever UI language was active, so the default title is matched in every locale.
const commonDicts = import.meta.glob('./i18n/locales/*/common.json', { eager: true, import: 'default' }) as Record<string, Record<string, string>>;
const DEFAULT_TITLES = new Set(Object.values(commonDicts).map((d) => d.newChat).filter(Boolean));
const isDefaultTitle = (title: string) => DEFAULT_TITLES.has(title) || title === tr('common.newChat');

function blankThread(s: Settings, cwd?: string, projectId?: string): Thread {
  const project = projectId ? s.projects.find((p) => p.id === projectId) : undefined;
  const d = project?.defaults ?? {};
  return {
    id: 'new-' + uid(),
    provider: d.provider ?? s.provider ?? 'claude',
    title: tr('common.newChat'),
    cwd: cwd ?? project?.folders[0] ?? s.cwd,
    ...(project ? { projectId: project.id } : {}),
    model: d.model ?? s.model,
    effort: d.effort ?? s.effort,
    permissionMode: d.permissionMode ?? s.permissionMode,
    workMode: d.workMode ?? s.workMode,
    entries: [],
    status: 'idle',
    loaded: true,
    approvals: [],
    queue: [],
    tasks: {},
    agents: {},
    draft: '',
    draftImages: [],
  };
}

function usageFromProbe(u: any): UsageSummary {
  if (!u?.rate_limits_available || !u.rate_limits) return { plan: u?.subscription_type ?? null };
  const rl = u.rate_limits;
  return {
    plan: u.subscription_type,
    session: rl.five_hour ? { pct: normalizePct(rl.five_hour.utilization), resetsAt: rl.five_hour.resets_at } : undefined,
    weekly: rl.seven_day ? { pct: normalizePct(rl.seven_day.utilization), resetsAt: rl.seven_day.resets_at } : undefined,
  };
}

let sessionsTimer: ReturnType<typeof setTimeout> | undefined;
let lastUsageAt = 0;

export const useStore = create<State>()((set, get) => {
  /** Adds earlier in-file segments (context compactions) of every chain file as previous parts. */
  const expandChain = async (id: string) => {
    const t = get().threads[id];
    if (!t?.sessionId || t.chainExpanded || (t.chainLoaded ?? 0) > 0) return;
    const files: SessionInfo[] = [
      { sessionId: t.sessionId, provider: t.provider, title: t.title, cwd: t.cwd, lastModified: Date.now() },
      ...(t.chain ?? []).filter((p) => p.segment == null),
    ];
    const lists = await Promise.all(files.map((f) => window.desk.segments(f.sessionId, f.cwd, f.provider).catch(() => [])));
    const chain: SessionInfo[] = [];
    files.forEach((f, i) => {
      if (i > 0) chain.push(f);
      for (const s of lists[i]) chain.push({ ...f, segment: s.segment, lastModified: Date.parse(s.ts) || f.lastModified });
    });
    update(id, (x) =>
      (x.chainLoaded ?? 0) > 0 || x.chainExpanded ? x : { ...x, chainExpanded: true, ...(chain.length ? { chain, chainLoaded: 0 } : {}) },
    );
  };

  const update = (id: string, fn: (t: Thread) => Thread) =>
    set((s) => (s.threads[id] ? { threads: { ...s.threads, [id]: fn(s.threads[id]) } } : s));

  const persist = (patch: Partial<Settings>) => {
    const settings = { ...get().settings, ...patch };
    if (patch.language) setLang(patch.language);
    set({ settings });
    // Send only the patch: main merges it, so another window's stale copy can't overwrite newer settings.
    window.desk.setSettings(patch);
  };

  const effortFor = (t: Thread) => {
    const m = get().models.find((x) => x.value === t.model);
    if (m && !m.supportedEffortLevels?.length) return undefined;
    return t.effort;
  };

  const dispatch = async (id: string, text: string, images: ImageAttachment[]) => {
    const t = get().threads[id];
    if (!t) return;
    const now = Date.now();
    const uuid = crypto.randomUUID();
    update(id, (x) => ({
      ...x,
      title: x.entries.length === 0 && isDefaultTitle(x.title) ? text.split('\n')[0].slice(0, 80) || tr('store.image') : x.title,
      entries: [
        ...x.entries,
        { kind: 'user', id: uid(), uuid, text, images, ts: now },
        { kind: 'turn', id: uid(), items: [], startedAt: now, done: false },
      ],
      status: 'running',
      activity: undefined,
    }));
    if (t.cwd) {
      const recent = [t.cwd, ...get().settings.recentProjects.filter((p) => p !== t.cwd)].slice(0, 12);
      persist({ recentProjects: recent, cwd: t.cwd });
    }
    let cwd = t.cwd;
    if (t.workMode === 'worktree' && !t.worktree && t.cwd) {
      try {
        update(id, (x) => ({ ...x, activity: tr('store.creatingWorktree') }));
        const wt = await window.desk.wtCreate(t.cwd);
        cwd = wt.path;
        set((s) => ({ worktrees: { ...s.worktrees, [wt.path.toLowerCase()]: wt } }));
        update(id, (x) => ({ ...x, cwd, worktree: wt, activity: undefined }));
      } catch (e: any) {
        get().toast(tr('store.worktreeFailed', { error: e?.message ?? e }), 'error');
        update(id, (x) => ({ ...x, status: 'idle', activity: undefined, workMode: 'local' }));
        return;
      }
    }
    try {
      const project = t.projectId
        ? get().settings.projects.find((p) => p.id === t.projectId)
        : projectOf(get().settings, t.sessionId, t.worktree?.base ?? t.cwd);
      await window.desk.send({
        threadId: id,
        provider: t.provider,
        cwd,
        dirs: project?.folders.filter((f) => !sameDir(f, cwd)),
        model: t.model,
        effort: effortFor(t),
        permissionMode: t.permissionMode,
        resume: t.sessionId,
        text,
        images,
        uuid,
        chrome: get().settings.chrome,
      });
    } catch (e: any) {
      get().toast(tr('store.sendFailed', { error: e?.message ?? e }), 'error');
      update(id, (x) => ({ ...x, status: 'idle' }));
    }
  };

  const onResult = (id: string) => {
    clearTimeout(sessionsTimer);
    sessionsTimer = setTimeout(() => get().refreshSessions(), 1200);
    if (Date.now() - lastUsageAt > 45000) get().refreshUsage();
    const t = get().threads[id];
    if (!t) return;
    window.desk
      .contextUsage(id)
      .then((context) => context && update(id, (x) => ({ ...x, context })))
      .catch(() => {});
    const users = t.entries.filter((e) => e.kind === 'user');
    if (get().settings.autoTitles && !t.autoTitled && t.sessionId && users.length === 1 && users[0].kind === 'user' && users[0].text) {
      update(id, (x) => ({ ...x, autoTitled: true }));
      window.desk
        .autoTitle({ sessionId: t.sessionId, cwd: t.cwd, text: users[0].text, provider: t.provider })
        .then((title) => {
          if (!title) return;
          update(id, (x) => ({ ...x, title }));
          get().refreshSessions();
        })
        .catch(() => {});
    }
    if (get().settings.notifications && (document.hidden || get().activeId !== id)) {
      try {
        new Notification(get().providers[t.provider]?.label ?? 'Duet', { body: tr('store.notifyDone', { title: t.title }), silent: false });
      } catch {}
    }
    if (t.queue.length) {
      const [next, ...rest] = t.queue;
      update(id, (x) => ({ ...x, queue: rest }));
      dispatch(id, next.text, next.images);
    }
  };

  return {
    ready: false,
    account: {},
    providers: {},
    models: [],
    commands: [],
    mcp: [],
    settingsOpen: false,
    zoomImage: null,
    split: null,
    detached: [],
    projectModal: null,
    editorFiles: [],
    editorActive: null,
    review: {},
    composerInsert: null,
    updateAvailable: false,
    overlays: 0,
    rewindDialog: null,
    usage: {},
    sessions: [],
    sessionsLoaded: false,
    threads: {},
    activeId: '',
    settings: DEFAULT_SETTINGS,
    resolvedTheme: 'dark',
    toasts: [],
    search: '',
    panelTab: 'chat',
    worktrees: {},

    async init() {
      const saved = await window.desk.getSettings();
      const settings: Settings = { ...DEFAULT_SETTINGS, ...saved };
      setLang(settings.language);
      const first = blankThread(settings);
      set({ settings, threads: { [first.id]: first }, activeId: first.id });

      window.desk.onEvent(({ threadId, ev }) => {
        if (ev.type === 'limits') {
          const win = (w?: { pct: number; resetsAt?: any }) => (w ? { pct: normalizePct(w.pct), resetsAt: w.resetsAt } : undefined);
          if (ev.session) set((s) => ({ usage: { ...s.usage, session: win(ev.session) } }));
          if (ev.weekly) set((s) => ({ usage: { ...s.usage, weekly: win(ev.weekly) } }));
          if (ev.rejected) get().toast(tr('store.limitReached'), 'error');
          return;
        }
        const t = get().threads[threadId];
        if (!t) return;
        set((s) => ({ threads: { ...s.threads, [threadId]: applyEvent(s.threads[threadId], ev) } }));
        if (ev.type === 'turn.end') onResult(threadId);
        if (ev.type === 'task' && ev.op === 'end') {
          const task = get().threads[threadId]?.tasks[ev.id];
          if (task?.background) {
            const ok = ev.status === 'completed';
            get().toast(tr(ok ? 'store.taskDone' : 'store.taskStopped', { name: task.description }), ok ? 'info' : 'error');
            if (document.hidden && get().settings.notifications) {
              try {
                new Notification(tr('store.bgTask'), { body: task.description });
              } catch {}
            }
          }
        }
      });
      // Only the chat you're looking at may pop its browser open.
      window.desk.onBrowserShow(({ key }) => !isDetachedWindow() && key === get().activeId && get().openBrowser());
      window.desk.onPermission((p) => {
        const { threadId, ...approval } = p;
        update(threadId, (t) => ({ ...t, approvals: [...t.approvals, approval as Approval] }));
      });
      window.desk.onPermissionCancel(({ threadId, reqId }) => {
        update(threadId, (t) => ({ ...t, approvals: t.approvals.filter((a) => a.reqId !== reqId) }));
      });
      window.desk.onClosed(({ threadId, error }) => {
        update(threadId, (t) => {
          const entries = [...t.entries];
          const last = entries[entries.length - 1];
          if (last?.kind === 'turn' && !last.done) {
            entries[entries.length - 1] = {
              ...last,
              done: true,
              endedAt: Date.now(),
              durationMs: Date.now() - last.startedAt,
              error: error ? tr('store.claudeExited', { error }) : undefined,
              interrupted: t.stopRequested,
            };
          }
          const tasks = Object.fromEntries(
            Object.entries(t.tasks).map(([k, v]) => [k, v.status === 'running' || v.status === 'pending' ? { ...v, status: 'killed' as const, endedAt: Date.now() } : v]),
          );
          const agents = Object.fromEntries(
            Object.entries(t.agents).map(([k, v]) => [k, v.status === 'running' ? { ...v, status: 'stopped' as const, endedAt: Date.now() } : v]),
          );
          return { ...t, entries, tasks, agents, status: 'idle', approvals: [], activity: undefined, stopRequested: false };
        });
        if (error && get().threads[threadId]) get().toast(tr('store.sessionAborted', { error }), 'error');
      });

      if (!isDetachedWindow()) {
        // A prompt from outside the window (Telegram bot): run it as a regular chat so it's visible here.
        window.desk.subscribe<{
          threadId: string;
          prompt: string;
          cwd?: string;
          provider?: ProviderId;
          model?: string;
          effort?: Effort;
          permissionMode?: PermMode;
          resume?: string;
          projectId?: string;
        }>('desk:external-run', async (r) => {
          let s = get();
          let thread =
            s.threads[r.threadId] ?? (r.resume ? Object.values(s.threads).find((x) => x.sessionId === r.resume) : undefined);
          if (!thread && r.resume) {
            const info = s.sessions.find((x) => x.sessionId === r.resume) ?? { sessionId: r.resume, title: tr('common.untitled'), cwd: r.cwd ?? '', lastModified: Date.now() };
            const active = s.activeId;
            get().openSession(info);
            // Opening selects the chat; keep the user's current chat in front.
            if (s.threads[active]) set({ activeId: active });
            for (let i = 0; i < 200 && !(get().threads[r.resume]?.loaded); i++) await new Promise((res) => setTimeout(res, 50));
            thread = get().threads[r.resume];
          }
          if (!thread) {
            s = get();
            const blank = blankThread(s.settings, r.cwd, r.projectId);
            thread = { ...blank, id: r.threadId, ...(r.provider ? { provider: r.provider } : {}) };
            set({ threads: { ...s.threads, [thread.id]: thread } });
          }
          const id = thread.id;
          update(id, (x) => ({
            ...x,
            ...(r.model ? { model: r.model } : {}),
            ...(r.effort ? { effort: r.effort } : {}),
            ...(r.permissionMode ? { permissionMode: r.permissionMode } : {}),
            ...(r.projectId ? { projectId: r.projectId } : {}),
          }));
          get().send(id, r.prompt, []);
        });

        window.desk.call<{ key: string }[]>('win:list').then((l) => set({ detached: l.map((w) => w.key) })).catch(() => {});
        window.desk.subscribe<{ threadId: string; sessionId?: string }>('win:detached', ({ threadId, sessionId }) => {
          const s = get();
          const gone = Object.values(s.threads).filter((t) => t.id === threadId || (sessionId && t.sessionId === sessionId));
          const threads = { ...s.threads };
          // Only drop it from this window; the session itself lives on in the detached one.
          for (const t of gone) delete threads[t.id];
          const key = sessionId ?? threadId;
          set({
            threads,
            detached: s.detached.includes(key) ? s.detached : [...s.detached, key],
            split: s.split?.some((x) => !threads[x]) ? null : s.split,
          });
          if (!threads[get().activeId]) get().newThread(gone[0]?.cwd);
        });
        window.desk.subscribe<{ threadId: string; sessionId?: string; open?: boolean }>('win:reattached', ({ threadId, sessionId, open }) => {
          const key = sessionId ?? threadId;
          set((s) => ({ detached: s.detached.filter((x) => x !== key) }));
          get()
            .refreshSessions()
            .then(() => {
              const info = sessionId && get().sessions.find((x) => x.sessionId === sessionId);
              if (open && info) get().openSession(info);
            });
        });
        window.desk.subscribe<SessionInfo>('win:open', (info) => get().openSession(info));
      }

      get().refreshSessions();
      try {
        const p = await window.desk.probe();
        set({
          ready: true,
          providers: p.providers ?? {},
          models: p.models,
          account: p.account ?? {},
          commands: p.commands ?? [],
          mcp: (p as any).mcp ?? [],
          usage: usageFromProbe(p.usage),
        });
        lastUsageAt = Date.now();
      } catch (e: any) {
        set({ ready: true, probeError: String(e?.message ?? e) });
      }
    },

    setSettings(patch) {
      persist(patch);
    },

    newThread(cwd) {
      const s = get();
      const current = s.threads[s.activeId];
      if (current && current.entries.length === 0 && (!cwd || current.cwd === cwd)) {
        set({ activeId: current.id });
        return current.id;
      }
      // A new chat started from inside a project stays in that project.
      const t = blankThread(s.settings, cwd ?? current?.cwd, cwd ? undefined : current?.projectId);
      set({ threads: { ...s.threads, [t.id]: t }, activeId: t.id });
      return t.id;
    },

    openSession(info, chain) {
      const s = get();
      if (!isDetachedWindow() && s.detached.includes(info.sessionId)) {
        window.desk.call('win:focus', info.sessionId).catch(() => {});
        return;
      }
      const existing = Object.values(s.threads).find((t) => t.sessionId === info.sessionId || t.id === info.sessionId);
      if (existing) {
        set({ activeId: existing.id });
        if (chain?.length && !existing.chain) update(existing.id, (x) => ({ ...x, chain, chainLoaded: 0 }));
        if (existing.loaded && !existing.loading) expandChain(existing.id);
        return;
      }
      const t: Thread = {
        ...blankThread(s.settings, info.cwd),
        provider: info.provider ?? 'claude',
        id: info.sessionId,
        sessionId: info.sessionId,
        title: info.title,
        ...(chain?.length ? { chain, chainLoaded: 0 } : {}),
        loaded: false,
        loading: true,
        ...(s.worktrees[info.cwd.toLowerCase()] ? { workMode: 'worktree' as const, worktree: s.worktrees[info.cwd.toLowerCase()] } : {}),
      };
      set({ threads: { ...s.threads, [t.id]: t }, activeId: t.id });
      window.desk
        .loadSession(info.sessionId, info.cwd, undefined, t.provider)
        .then((events) => {
          const { entries, agents } = fromHistory(events);
          update(t.id, (x) => ({ ...x, entries, agents, loaded: true, loading: false }));
          expandChain(t.id);
        })
        .catch((e) => {
          update(t.id, (x) => ({ ...x, loaded: true, loading: false }));
          get().toast(tr('store.historyFailed', { error: e?.message ?? e }), 'error');
        });
    },

    async loadEarlierPart(id, all) {
      const t = get().threads[id];
      if (!t?.chain || (t.chainLoaded ?? 0) >= t.chain.length || t.loading) return;
      update(id, (x) => ({ ...x, loading: true }));
      try {
        const start = t.chainLoaded ?? 0;
        const parts = all ? t.chain.slice(start) : [t.chain[start]];
        // Older parts first, so the conversation reads top to bottom.
        const loaded = await Promise.all(parts.map((p) => window.desk.loadSession(p.sessionId, p.cwd, p.segment, p.provider)));
        const earlier = loaded.reverse().map((events) => fromHistory(events));
        update(id, (x) => ({
          ...x,
          entries: [...earlier.flatMap((h) => h.entries), ...x.entries],
          agents: { ...Object.assign({}, ...earlier.map((h) => h.agents)), ...x.agents },
          chainLoaded: start + parts.length,
          loading: false,
        }));
      } catch (e: any) {
        update(id, (x) => ({ ...x, loading: false }));
        get().toast(tr('store.partFailed', { error: e?.message ?? e }), 'error');
      }
    },

    activate(id) {
      set({ activeId: id });
    },

    openSplit(open) {
      const keep = get().activeId;
      set({ split: null });
      if (open) open();
      else {
        const t = blankThread(get().settings, get().threads[keep]?.cwd);
        set((s) => ({ threads: { ...s.threads, [t.id]: t }, activeId: t.id }));
      }
      const next = get().activeId;
      if (next && next !== keep) set({ split: [keep, next] });
    },

    closeSplit() {
      set({ split: null });
    },

    send(id, text, images) {
      const t = get().threads[id];
      if (!t || (!text.trim() && !images.length)) return;
      if (t.worktree?.removed) {
        get().toast(tr('store.worktreeGone'), 'error');
        return;
      }
      update(id, (x) => ({ ...x, draft: '', draftImages: [] }));
      if (t.status === 'running') {
        if (get().settings.followUp === 'steer') {
          // Fold into the running turn: Claude picks it up at the next step without stopping.
          const uuid = crypto.randomUUID();
          update(id, (x) => {
            const entries = [...x.entries];
            const last = entries[entries.length - 1];
            if (last?.kind === 'turn') {
              entries[entries.length - 1] = { ...last, items: [...last.items, { kind: 'steer', id: uid(), text, images, delivered: false }] };
            }
            return { ...x, entries };
          });
          window.desk
            .send({ threadId: id, provider: t.provider, cwd: t.cwd, model: t.model, effort: effortFor(t), permissionMode: t.permissionMode, resume: t.sessionId, text, images, uuid, priority: 'next' })
            .catch((e: any) => get().toast(tr('store.sendFailed', { error: e?.message ?? e }), 'error'));
          return;
        }
        update(id, (x) => ({ ...x, queue: [...x.queue, { id: uid(), text, images }] }));
        return;
      }
      dispatch(id, text.trim(), images);
    },

    interrupt(id) {
      update(id, (t) => ({ ...t, stopRequested: true, queue: [] }));
      window.desk.interrupt(id).catch(() => {});
    },

    setModel(id, model) {
      update(id, (t) => ({ ...t, model }));
      persist({ model });
      window.desk.configure({ threadId: id, model }).catch((e) => get().toast(String(e?.message ?? e), 'error'));
    },

    setEffort(id, effort) {
      update(id, (t) => ({ ...t, effort }));
      persist({ effort });
      window.desk.configure({ threadId: id, effort }).catch((e) => get().toast(String(e?.message ?? e), 'error'));
    },

    setPermissionMode(id, permissionMode) {
      update(id, (t) => ({ ...t, permissionMode }));
      persist({ permissionMode });
      window.desk.configure({ threadId: id, permissionMode }).catch((e) => get().toast(String(e?.message ?? e), 'error'));
    },

    setCwd(id, cwd) {
      update(id, (t) => ({ ...t, cwd }));
      persist({ cwd });
    },

    pinChats(keys, pinned) {
      const cur = get().settings.pinned.filter((k) => !keys.includes(k));
      persist({ pinned: pinned ? [...keys, ...cur] : cur });
    },

    saveProject({ id, name, folders, defaults }) {
      const projects = get().settings.projects;
      const clean = folders.filter((f, i) => f && folders.findIndex((x) => sameDir(x, f)) === i);
      if (id) {
        persist({ projects: projects.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name, folders: clean, defaults } : p)) });
        return id;
      }
      const p: Project = { id: 'p-' + uid(), name: name.trim() || basename(clean[0] ?? '') || tr('store.project'), folders: clean, createdAt: Date.now(), defaults };
      persist({ projects: [p, ...projects] });
      return p.id;
    },

    deleteProject(id) {
      const s = get().settings;
      const chatProject = Object.fromEntries(Object.entries(s.chatProject).filter(([, v]) => v !== id));
      persist({ projects: s.projects.filter((p) => p.id !== id), chatProject });
    },

    moveChat(key, projectId) {
      const s = get().settings;
      persist({ chatProject: { ...s.chatProject, [key]: projectId ?? '-' } });
      const t = Object.values(get().threads).find((x) => x.id === key || x.sessionId === key);
      if (t) update(t.id, (x) => ({ ...x, projectId: projectId ?? undefined }));
    },

    archiveChats(keys, archived) {
      const cur = get().settings.archived.filter((k) => !keys.includes(k));
      persist({ archived: archived ? [...cur, ...keys] : cur });
    },

    setThreadProject(id, projectId) {
      const p = projectId ? get().settings.projects.find((x) => x.id === projectId) : undefined;
      const d = p?.defaults ?? {};
      // A chat that hasn't started yet also takes the project's default model/mode.
      update(id, (t) => ({
        ...t,
        projectId: p?.id,
        cwd: p?.folders[0] ?? t.cwd,
        ...(t.entries.length === 0 ? Object.fromEntries(Object.entries(d).filter(([, v]) => v != null)) : {}),
      }));
      if (p?.folders[0]) persist({ cwd: p.folders[0] });
    },

    newThreadInProject(projectId) {
      const s = get();
      const t = blankThread(s.settings, undefined, projectId);
      const current = s.threads[s.activeId];
      // Reuse an untouched blank chat instead of piling them up.
      if (current && current.entries.length === 0 && !current.sessionId) {
        update(current.id, (x) => ({ ...x, cwd: t.cwd, projectId, model: t.model, effort: t.effort, permissionMode: t.permissionMode, workMode: t.workMode }));
        return;
      }
      set({ threads: { ...s.threads, [t.id]: t }, activeId: t.id });
    },

    setDraft(id, draft) {
      update(id, (t) => ({ ...t, draft }));
    },

    setDraftImages(id, draftImages) {
      update(id, (t) => ({ ...t, draftImages }));
    },

    removeQueued(id, qid) {
      update(id, (t) => ({ ...t, queue: t.queue.filter((q) => q.id !== qid) }));
    },

    stopTask(id, taskId) {
      window.desk.stopTask(id, taskId).catch((e) => get().toast(tr('store.stopFailed', { error: e?.message ?? e }), 'error'));
    },

    backgroundTask(id, toolUseId) {
      window.desk
        .backgroundTask(id, toolUseId)
        .then((ok) => !ok && get().toast(tr('store.cantBackground'), 'error'))
        .catch((e) => get().toast(String(e?.message ?? e), 'error'));
    },

    dismissTask(id, taskId) {
      update(id, (t) => (t.tasks[taskId] ? { ...t, tasks: { ...t.tasks, [taskId]: { ...t.tasks[taskId], dismissed: true } } } : t));
    },

    respond(id, approval, decision, extra) {
      update(id, (t) => ({ ...t, approvals: t.approvals.filter((a) => a.reqId !== approval.reqId) }));
      window.desk
        .respondPermission({ threadId: id, reqId: approval.reqId, decision, ...extra })
        .catch((e) => get().toast(String(e?.message ?? e), 'error'));
    },

    renameThread(id, title) {
      const t = get().threads[id];
      if (!t || !title.trim()) return;
      update(id, (x) => ({ ...x, title: title.trim() }));
      if (t.sessionId) {
        window.desk
          .renameSession(t.sessionId, title.trim(), t.cwd, t.provider)
          .then(() => get().refreshSessions())
          .catch((e) => get().toast(String(e?.message ?? e), 'error'));
      }
    },

    deleteThread(id) {
      const s = get();
      const t = s.threads[id];
      if (!t) return;
      window.desk.closeThread(id);
      const threads = { ...s.threads };
      delete threads[id];
      set({ threads, sessions: s.sessions.filter((x) => x.sessionId !== t.sessionId) });
      if (s.activeId === id) get().newThread(t.cwd);
      if (t.sessionId) {
        window.desk.deleteSession(t.sessionId, t.cwd, t.provider).catch((e) => get().toast(String(e?.message ?? e), 'error'));
      }
    },

    async refreshSessions() {
      try {
        const [sessions, worktrees] = await Promise.all([window.desk.listSessions(), window.desk.wtAll().catch(() => ({}))]);
        set({ worktrees });
        set((s) => {
          const threads = { ...s.threads };
          for (const t of Object.values(threads)) {
            const info = t.sessionId && sessions.find((x) => x.sessionId === t.sessionId);
            if (info && info.title && info.title !== t.title && t.entries.length > 0) {
              threads[t.id] = { ...t, title: info.title };
            }
          }
          return { sessions, sessionsLoaded: true, threads };
        });
      } catch (e: any) {
        set({ sessionsLoaded: true });
        get().toast(tr('store.sessionsFailed', { error: e?.message ?? e }), 'error');
      }
    },

    async refreshUsage() {
      lastUsageAt = Date.now();
      try {
        const u = await window.desk.usage();
        if (u) set({ usage: usageFromProbe(u) });
      } catch {}
    },

    toast(text, tone = 'info') {
      const id = uid();
      set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 7000 : 3500);
    },

    setWorkMode(id, workMode) {
      update(id, (t) => (t.entries.length ? t : { ...t, workMode }));
      persist({ workMode });
    },

    async worktreeApply(id) {
      const t = get().threads[id];
      if (!t?.worktree || t.worktree.removed) return;
      if (t.status === 'running') return get().toast(tr('store.waitForClaude'), 'error');
      if (!(await askConfirm({ title: tr('store.applyTitle'), message: tr('store.applyMessage'), details: [t.worktree.base], confirmLabel: tr('store.apply') }))) return;
      try {
        const r = await window.desk.wtApply(t.worktree.path);
        get().toast(r.applied ? tr('store.applied', { count: r.files }) : tr('store.nothingToApply'));
      } catch (e: any) {
        get().toast(tr('store.applyFailed', { error: e?.message ?? e }), 'error');
      }
    },

    async worktreeRemove(id) {
      const t = get().threads[id];
      if (!t?.worktree) return;
      if (!(await askConfirm({ title: tr('store.removeWorktreeTitle'), message: tr('store.removeWorktreeMessage', { branch: t.worktree.branch }), confirmLabel: tr('common.delete'), danger: true }))) return;
      try {
        window.desk.closeThread(id);
        await window.desk.wtRemove(t.worktree.path);
        const wt = t.worktree;
        set((s) => ({ worktrees: { ...s.worktrees, [wt.path.toLowerCase()]: { ...wt, removed: true } } }));
        update(id, (x) => ({ ...x, worktree: { ...wt, removed: true } }));
        get().toast(tr('store.worktreeRemoved'));
      } catch (e: any) {
        get().toast(tr('store.removeFailed', { error: e?.message ?? e }), 'error');
      }
    },

    openRewind(threadId, entryId) {
      set({ rewindDialog: { threadId, entryId } });
    },

    async performRewind(id, entryId, mode) {
      const t = get().threads[id];
      if (!t) return;
      const idx = t.entries.findIndex((e) => e.id === entryId);
      const entry = t.entries[idx];
      if (!entry || entry.kind !== 'user') return;
      const prevTurn = [...t.entries.slice(0, idx)].reverse().find((e) => e.kind === 'turn');
      const config = { provider: t.provider, cwd: t.cwd, model: t.model, effort: effortFor(t), permissionMode: t.permissionMode, resume: t.sessionId };
      const done: string[] = [];
      try {
        if (t.status === 'running') {
          update(id, (x) => ({ ...x, stopRequested: true, queue: [] }));
          await window.desk.interrupt(id).catch(() => {});
        }
        if ((mode === 'both' || mode === 'code') && entry.uuid) {
          const res = await window.desk.rewind({ threadId: id, uuid: entry.uuid, config });
          if (!res.canRewind) throw new Error(res.error ?? tr('store.noSnapshot'));
          done.push(res.filesChanged?.length ? tr('store.rewoundCodeFiles', { count: res.filesChanged.length }) : tr('store.rewoundCode'));
        }
        if (mode === 'both' || mode === 'conversation') {
          const resumeAt = prevTurn && prevTurn.kind === 'turn' ? prevTurn.lastUuid ?? null : null;
          if (idx > 0 && !resumeAt) throw new Error(tr('store.noResumePoint'));
          await window.desk.rewindConversation({ threadId: id, resumeAt });
          update(id, (x) => ({
            ...x,
            entries: x.entries.slice(0, idx),
            ...(resumeAt ? {} : { sessionId: undefined }),
            status: 'idle',
            approvals: [],
            queue: [],
            activity: undefined,
            stopRequested: false,
          }));
          get().insertToComposer(entry.text);
          done.push(tr('store.rewoundConversation'));
        }
        get().toast(tr('store.rewound', { what: done.join(', ') }));
      } catch (e: any) {
        get().toast(tr('store.rewindFailed', { error: e?.message ?? e }), 'error');
      }
    },
    async forkFrom(id, uuid) {
      const t = get().threads[id];
      if (!t?.sessionId) return;
      try {
        const sessionId = await window.desk.fork({ sessionId: t.sessionId, cwd: t.cwd, uuid, provider: t.provider });
        await get().refreshSessions();
        const info = get().sessions.find((s) => s.sessionId === sessionId) ?? {
          sessionId,
          provider: t.provider,
          title: `${t.title} (${tr('store.forkWord')})`,
          cwd: t.cwd,
          lastModified: Date.now(),
        };
        get().openSession(info);
        get().toast(tr('store.forked'));
      } catch (e: any) {
        get().toast(tr('store.forkFailed', { error: e?.message ?? e }), 'error');
      }
    },

    openFile(path) {
      const files = get().editorFiles;
      set({ editorFiles: files.includes(path) ? files : [...files, path], editorActive: path, panelTab: 'files' });
      persist({ changesOpen: true });
    },

    closeFile(path) {
      const files = get().editorFiles.filter((f) => f !== path);
      const active = get().editorActive === path ? files[files.length - 1] ?? null : get().editorActive;
      set({ editorFiles: files, editorActive: active });
    },

    addReview(threadId, c) {
      set((s) => ({ review: { ...s.review, [threadId]: [...(s.review[threadId] ?? []), { ...c, id: uid() }] } }));
    },

    removeReview(threadId, id) {
      set((s) => ({ review: { ...s.review, [threadId]: (s.review[threadId] ?? []).filter((x) => x.id !== id) } }));
    },

    clearReview(threadId) {
      set((s) => ({ review: { ...s.review, [threadId]: [] } }));
    },

    sendReview(threadId) {
      const list = get().review[threadId] ?? [];
      if (!list.length) return;
      const t = get().threads[threadId];
      const body = list
        .map((c, i) => {
          const rel = t?.cwd && c.file.toLowerCase().startsWith(t.cwd.toLowerCase()) ? c.file.slice(t.cwd.length).replace(/^[\\/]/, '') : c.file;
          const fence = '`';
          return `${i + 1}. \`${rel}\`\n${fence}diff\n${c.sign}${c.line}\n${fence}\n   ${c.text}`;
        })
        .join('\n\n');
      get().send(threadId, `${tr('store.reviewPrompt')}\n\n${body}`, []);
      get().clearReview(threadId);
    },

    insertToComposer(text) {
      set((s) => ({ composerInsert: { seq: (s.composerInsert?.seq ?? 0) + 1, text } }));
    },

    startTaskChat(prompt, cwd) {
      const id = get().newThread(cwd);
      setTimeout(() => get().send(id, prompt, []), 50);
    },

    openBrowser() {
      set({ panelTab: 'browser' });
      persist({ changesOpen: true });
    },

    setPanelTab(panelTab) {
      set({ panelTab });
    },

    openAgent(agentId) {
      set({ panelTab: 'agents', focusAgent: agentId ?? get().focusAgent });
      persist({ changesOpen: true });
      const t = get().threads[get().activeId];
      if (t && agentId && t.agents[agentId]?.historical && !t.agents[agentId].transcriptLoaded) get().loadAgentTranscripts(t.id);
    },

    loadAgentTranscripts(id) {
      const t = get().threads[id];
      if (!t?.sessionId) return;
      update(id, (x) => ({ ...x, agents: Object.fromEntries(Object.entries(x.agents).map(([k, a]) => [k, { ...a, transcriptLoaded: true }])) }));
      window.desk
        .loadSubagents(t.sessionId, t.cwd, t.provider)
        .then((events) => update(id, (x) => ({ ...x, agents: applyAgentTranscripts(x.agents, events) })))
        .catch((e) => get().toast(tr('store.agentsFailed', { error: e?.message ?? e }), 'error'));
    },

    setSearch(search) {
      set({ search });
    },
  };
});

// A new chat created inside a project keeps that project once Claude Code gives it a session id.
useStore.subscribe((s, prev) => {
  if (s.threads === prev.threads) return;
  const map = s.settings.chatProject;
  const missing = Object.values(s.threads).filter((t) => t.projectId && t.sessionId && !map[t.sessionId]);
  if (missing.length) {
    const next = { ...map };
    for (const t of missing) next[t.sessionId!] = t.projectId!;
    s.setSettings({ chatProject: next });
  }
});

// In split view, opening another chat replaces the focused pane; deleted chats close the split.
useStore.subscribe((s, prev) => {
  const split = s.split;
  if (!split || (s.activeId === prev.activeId && s.threads === prev.threads)) return;
  if (split.some((id) => !s.threads[id])) return useStore.setState({ split: null });
  if (!split.includes(s.activeId) && prev.split === split) {
    const slot = split.indexOf(prev.activeId);
    const next = [...split];
    next[slot < 0 ? 1 : slot] = s.activeId;
    useStore.setState({ split: next[0] === next[1] ? null : next });
  }
});

export const projectName = (cwd: string) => basename(cwd) || cwd || tr('common.noProject');

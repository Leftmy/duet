import { providerEntries, providerEnabled } from './lib/providers';
import { create } from 'zustand';
import type {
  Account,
  Approval,
  Effort,
  Entry,
  ImageAttachment,
  PastedTextFile,
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
import { pastedLineCount, withPastedText } from './lib/pasted-text';
import type { ProviderProbe } from './desk';
import type { DeskEvent } from './events';
import { applyAgentTranscripts, applyEvent, fromHistory } from './lib/reduce';
import { buildHandoff, unseenEntries } from './lib/handoff';
import { linkedSessionIds, threadSessionIds } from './lib/chat-sessions';
import { basename, uid } from './lib/format';
import { askConfirm } from './lib/dialog';
import { setLang, t as tr, type Lang } from './i18n';
import { isDetachedWindow } from './features/detach/mode';

async function historyPage(part: SessionInfo) {
  if (window.desk.nativeHistoryPaging === true && window.desk.loadSessionPage) return window.desk.loadSessionPage(part.sessionId, part.cwd, part.segment, part.provider, { before: part.cursor, limit: 40 });
  return { events: await window.desk.loadSession(part.sessionId, part.cwd, part.segment, part.provider), previous: null, totalTurns: 0 };
}
const byEntryTime = (a: Entry, b: Entry) => (a.kind === 'user' ? a.ts : a.startedAt) - (b.kind === 'user' ? b.ts : b.startedAt);

interface Settings {
  layoutSizes?: Record<string, number>;
  language: Lang;
  theme: ThemePref;
  /** Agent of new chats. */
  provider: ProviderId;
  /** Model and effort last used with each agent (Claude's live in model/effort). */
  providerModels: Partial<Record<ProviderId, { model: string; effort: Effort }>>;
  /** Chats that moved between agents: session id → the session it continues (another agent's). */
  links: Record<string, string>;
  /** Selected provider of a logical chat, including switches made before sending a message. */
  chatProviders: Record<string, ProviderId>;
  /** Sessions of agents that worked for another chat (run_agent); shown under that chat, not as chats. */
  subSessions: string[];
  /** Agents panel shows only the list of agents (their conversations hidden). */
  agentsCollapsed: boolean;
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
  idleAgentMinutes: number;
  browserIdleMinutes: number;
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

export type PanelTab = 'chat' | 'git' | 'agents' | 'tasks' | 'browser' | 'files' | 'terminal';

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
  /** Plan limits per agent (usage is Claude's). */
  usageBy: Partial<Record<ProviderId, UsageSummary>>;
  models: ModelInfo[];
  commands: SlashCommand[];
  mcp: { name: string; status: string; scope?: string; tools: number }[];
  settingsOpen: boolean;
  settingsSection?: string;
  zoomImage: string | null;
  /** Split view: two thread ids shown side by side (active one is focused). */
  split: string[] | null;
  /** Session ids open in detached windows (main window only). */
  detached: string[];
  editorFiles: string[];
  editorActive: string | null;
  editorLocation?: {path:string;line?:number;column?:number;endLine?:number;seq:number};
  kimiPanel?:{threadId:string;tab:string;seq:number};
  kimiAction(id:string,action:string,params?:Record<string,any>):Promise<any>;
  codexPanel?:{threadId:string;tab:string;seq:number};
  review: Record<string, ReviewComment[]>;
  composerInsert: { seq: number; text: string } | null;
  updateAvailable: boolean;
  /** Number of open popovers/menus; native views (browser) hide while > 0. */
  overlays: number;
  openFile(path: string, location?: {line?:number;column?:number;endLine?:number}): void;
  codexAction(id:string,action:string,params?:Record<string,any>):Promise<any>;
  setServiceTier(id:string,tier:string):void;
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
  retrySteer(id:string,messageId:string):void;
  interrupt(id: string): void;
  setModel(id: string, model: string): void;
  /** Moves a chat to another agent; the conversation so far goes with the next message. */
  switchProvider(id: string, provider: ProviderId): void;
  /** Pulls in what was added to the chat's session elsewhere (another window, the agent's CLI or app). */
  syncThread(id: string, manual?: boolean): Promise<void>;
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
  pasteText(id: string, text: string, retryId?: string): Promise<void>;
  removePastedText(id: string, fileId: string): void;
  removeQueued(id: string, qid: string): void;
  stopTask(id: string, taskId: string): void;
  messageAgent(id:string,runId:string,text:string):Promise<void>;
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
  loadAgentTranscripts(id: string, agentId?: string, before?: number): void;
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
  providerModels: {},
  links: {},
  chatProviders: {},
  subSessions: [],
  agentsCollapsed: false,
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
  idleAgentMinutes: 5,
  browserIdleMinutes: 5,
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

/** Model and effort a chat starts with on an agent. */
function agentDefaults(s: Settings, provider: ProviderId) {
  if (provider === 'claude') return { model: s.model, effort: s.effort };
  return s.providerModels[provider] ?? { model: 'default', effort: 'high' as Effort };
}

function blankThread(s: Settings, cwd?: string, projectId?: string): Thread {
  const project = projectId ? s.projects.find((p) => p.id === projectId) : undefined;
  const d = project?.defaults ?? {};
  const preferred = d.provider ?? s.provider ?? 'claude';
  const provider = providerEnabled(preferred) ? preferred : 'claude';
  const def = agentDefaults(s, provider);
  return {
    id: 'new-' + uid(),
    provider,
    title: tr('common.newChat'),
    cwd: cwd ?? project?.folders[0] ?? s.cwd,
    ...(project ? { projectId: project.id } : {}),
    // A project's default model belongs to its default agent (Claude when unset).
    model: (d.provider ?? 'claude') === provider ? d.model ?? def.model : def.model,
    effort: d.effort ?? def.effort,
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

/** Plan limits as providers report them: { plan, session, weekly, groups }, pct 0–100, resetsAt in ms. */
function toUsage(u: any): UsageSummary {
  const win = (w: any) =>
    w && typeof w.pct === 'number'
      ? { pct: w.pct, resetsAt: w.resetsAt ?? null, ...(w.label ? { label: String(w.label) } : {}) }
      : undefined;
  const groups = Array.isArray(u?.groups)
    ? u.groups
        .map((g: any) => ({
          name: String(g?.name ?? 'Models'),
          ...(g?.description ? { description: String(g.description) } : {}),
          ...(win(g?.session) ? { session: win(g.session) } : {}),
          ...(win(g?.weekly) ? { weekly: win(g.weekly) } : {}),
        }))
        .filter((g: any) => g.session || g.weekly)
    : undefined;
  return {
    plan: u?.plan ?? null,
    ...(u?.email ? { email: String(u.email) } : {}),
    session: win(u?.session),
    weekly: win(u?.weekly),
    ...(groups?.length ? { groups } : {}),
  };
}


// Zustand selectors must return the same reference until the models actually change.
// A new [] while a provider is loading causes React to loop and unmount the app.
const NO_MODELS: ModelInfo[] = [];

/** Models of an agent (Claude's come from the main probe). */
export const modelsOf = (s: { models: ModelInfo[]; providers: Record<string, ProviderProbe> }, provider: ProviderId): ModelInfo[] =>
  provider === 'claude' ? s.models : (s.providers[provider]?.models as ModelInfo[]) ?? NO_MODELS;

/**
 * Merges a freshly read session into the feed: everything after the last user message both have is
 * taken from disk. null when the disk has nothing new; reset = the feed had to be replaced as a whole.
 */
function mergeFromDisk(cur: Entry[], fresh: Entry[], allowReset: boolean): { entries: Entry[]; reset?: boolean } | null {
  const lastText = (list: Entry[], from = list.length - 1) => {
    for (let i = from; i >= 0; i--) {
      const e = list[i];
      if (e.kind === 'user' && e.text.trim()) return i;
    }
    return -1;
  };
  const iu = lastText(cur);
  const text = iu >= 0 ? (cur[iu] as Extract<Entry, { kind: 'user' }>).text.trim() : null;
  let ju = -1;
  if (text != null) for (let i = fresh.length - 1; i >= 0 && ju < 0; i--) if (fresh[i].kind === 'user' && (fresh[i] as any).text.trim() === text) ju = i;
  if (ju < 0) {
    const users = (l: Entry[]) => l.filter((e) => e.kind === 'user').length;
    return allowReset && users(fresh) > 0 && JSON.stringify(fresh.map((e) => e.kind)) !== JSON.stringify(cur.map((e) => e.kind)) ? { entries: fresh, reset: true } : null;
  }
  const curTail = cur.slice(iu + 1);
  const freshTail = fresh.slice(ju + 1);
  const size = (l: Entry[]) => l.reduce((n, e) => n + (e.kind === 'turn' ? e.items.filter((x) => x.kind !== 'notice').length : 1), 0);
  if (!freshTail.some((e) => e.kind === 'user') && size(freshTail) <= size(curTail)) return null;
  return { entries: [...cur.slice(0, iu + 1), ...freshTail] };
}

let sessionsTimer: ReturnType<typeof setTimeout> | undefined;
let lastUsageAt = 0;

let initPromise: Promise<void> | undefined;

export const useStore = create<State>()((set, get) => {
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
    const m = modelsOf(get(), t.provider).find((x) => x.value === t.model);
    if (m && !m.supportedEffortLevels?.length) return t.provider==='codex'?null:undefined;
    const levels=m?.supportedEffortLevels;
    return !levels||levels.includes(t.effort)?t.effort:levels.includes('high')?'high':levels.at(-1);
  };

  /** Remembers the model and effort picked for an agent; new chats on it start with them. */
  const rememberModel = (provider: ProviderId, v: { model: string; effort: Effort }) => {
    if (provider === 'claude') persist({ model: v.model, effort: v.effort });
    else persist({ providerModels: { ...get().settings.providerModels, [provider]: v } });
  };

  /** A chat got a new session: its first message, or its first one on another agent after a switch. */
  const onNewSession = (id: string, before: Thread, sessionId: string, replacement?: string) => {
    const t = get().threads[id];
    if (!t) return;
    update(id, (x) => ({ ...x, sessions: { ...(x.sessions ?? {}), [x.provider]: sessionId } }));
    // Continues another agent's session: link the two so the sidebar shows one chat with one title.
    const prev = replacement || Object.entries(before.sessions ?? {}).find(([provider, sid]) => provider !== t.provider && sid !== sessionId)?.[1];
    const s = get().settings;
    if (!prev) return;
    persist({
      links: linkedSessionIds(sessionId, s.links).has(prev) ? s.links : { ...s.links, [sessionId]: prev },
      chatProviders: { ...s.chatProviders, [sessionId]: t.provider },
      ...(s.chatProject[prev] ? { chatProject: { ...s.chatProject, [sessionId]: s.chatProject[prev] } } : {}),
    });
    // The new session keeps the chat's title; set once the turn ends (its file may not exist yet).
    if (!isDefaultTitle(t.title)) update(id, (x) => ({ ...x, retitle: true }));
  };

  const preparing = new Map<string,Promise<boolean>>();
  const dispatchImpl = async (id: string, text: string, images: ImageAttachment[]) => {
    const t = get().threads[id];
    if (!t) return false;
    const now = Date.now();
    const uuid = crypto.randomUUID();
    update(id, (x) => ({
      ...x,
      title: x.entries.length === 0 && isDefaultTitle(x.title) ? text.split('\n')[0].slice(0, 80) || tr('store.image') : x.title,
      entries: [
        ...x.entries,
        { kind: 'user', id: uid(), uuid, text, images, ts: now },
        { kind: 'turn', id: uid(), items: [], startedAt: now, done: false, provider: x.provider },
      ],
      status: 'running',
      activity: undefined,
    }));
    // The chat just moved to this agent: hand it the conversation it hasn't seen.
    let instructions: string | undefined;
    const contextHistory=[...Object.entries(t.sessions??{}).map(([provider,sessionId])=>({provider,sessionId,cwd:t.cwd})),...(t.chain??[]).map(part=>({...part,provider:part.provider??'claude',cwd:t.cwd}))];
    let nativeContext:{managed:boolean}|null=null;
    try{if(window.desk.nativeContext===true)nativeContext=await window.desk.call('desk:context',{action:'prepare',threadId:id,provider:t.provider,resume:t.sessionId,cwd:t.cwd,contextHistory,handoff:!!t.handoff});}
    catch(error:any){get().toast(tr('store.sendFailed',{error:String(error?.message??error)}),'error');update(id,x=>({...x,entries:t.entries,status:'idle',draft:text,draftImages:images}));return false;}
    if (t.handoff && !nativeContext?.managed) {
      update(id, (x) => ({ ...x, activity: tr('store.handingOver') }));
      try {
        const label = (p?: ProviderId) => get().providers[p ?? 'claude']?.label ?? p ?? 'Agent';
        const status = t.cwd ? await window.desk.gitStatus(t.cwd).catch(() => null) : null;
        const pendingHistory=(t.chain??[]).slice(t.chainLoaded??0);
        const earlier=window.desk.nativeHistoryPaging===true&&pendingHistory.length
          ? await window.desk.call<string>('desk:history-context',pendingHistory) : undefined;
        instructions =
          (await buildHandoff({
            entries: t.entries,
            from: t.handoff.from,
            to: t.provider,
            resume: t.handoff.resume ?? Boolean(t.sessionId),
            cwd: t.cwd,
            label,
            earlier,
            changes: status?.files.map((f) => `${f.status[0].toUpperCase()} ${f.path}`),
            agents: Object.values(t.agents),
            tasks: Object.values(t.tasks),
            summarize: (text) => window.desk.call<string>('desk:summarize', text),
          })) ?? undefined;
      } catch (error: any) {
        get().toast(tr('store.sendFailed', { error: error?.message ?? error }), 'error');
        // Keep the handoff pending and the message editable if disk history cannot be read.
        update(id, (x) => ({ ...x, entries: t.entries, status: 'idle', activity: undefined, draft: text, draftImages: images }));
        return false;
      }
      update(id, (x) => ({ ...x, handoff: undefined, activity: undefined }));
    }
    if(t.handoff&&nativeContext?.managed)update(id,x=>({...x,handoff:undefined,activity:undefined}));
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
        return false;
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
          ...(t.recoveryTicket?{_recoveryTicket:t.recoveryTicket}:{}),
        chrome: get().settings.chrome,
        ...(window.desk.nativeContext===true?{contextHistory}:{}),
        serviceTier: t.serviceTier,
        ...(instructions ? { instructions } : {}),
      });
      return true;
    } catch (e: any) {
      get().toast(tr('store.sendFailed', { error: e?.message ?? e }), 'error');
      update(id, (x) => ({ ...x, status: 'idle' }));
      return false;
    }
  };

  const dispatch=(id:string,text:string,images:ImageAttachment[])=>{const pending=dispatchImpl(id,text,images);preparing.set(id,pending);const clear=()=>{if(preparing.get(id)===pending)preparing.delete(id);};void pending.then(clear,clear);return pending;};

  const onResult = (id: string) => {
    clearTimeout(sessionsTimer);
    sessionsTimer = setTimeout(() => get().refreshSessions(), 1200);
    if (Date.now() - lastUsageAt > 45000) get().refreshUsage();
    const t = get().threads[id];
    if (!t) return;
    // The first answer after a rewind has written its branch: the session on disk matches the chat again.
    if (t.rewound) update(id, (x) => ({ ...x, rewound: false }));
    if (t.retitle && t.sessionId) {
      update(id, (x) => ({ ...x, retitle: false }));
      window.desk.renameSession(t.sessionId, t.title, t.cwd, t.provider).catch(() => {});
    }
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
    usageBy: {},
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

    init() {
      // Remounting a failed view must retain active chats and their one set of listeners.
      return initPromise ??= (async () => {
      const saved = await window.desk.getSettings();
      const settings: Settings = { ...DEFAULT_SETTINGS, ...saved };
      if (!providerEnabled(settings.provider)) settings.provider = 'claude';
      setLang(settings.language);
      const first = blankThread(settings);
      set({ settings, threads: { [first.id]: first }, activeId: first.id });

      const onEvent = ({ threadId, ev }: { threadId: string; ev: DeskEvent }) => {
        if (ev.type === 'limits') {
          const provider = ev.provider ?? get().threads[threadId]?.provider ?? 'claude';
          const patch = toUsage(ev);
          const merge = (u: UsageSummary = {}) => ({
            ...u,
            ...(patch.session ? { session: patch.session } : {}),
            ...(patch.weekly ? { weekly: patch.weekly } : {}),
            ...(patch.groups ? { groups: patch.groups } : {}),
          });
          set((s) => ({
            usageBy: { ...s.usageBy, [provider]: merge(s.usageBy[provider]) },
            ...(provider === 'claude' ? { usage: merge(s.usage) } : {}),
          }));
          if (ev.rejected) get().toast(tr('store.limitReached'), 'error');
          return;
        }
        const t = get().threads[threadId];
        if (!t) return;
        set((s) => ({ threads: { ...s.threads, [threadId]: applyEvent(s.threads[threadId], ev) } }));
        if (ev.type === 'session' && ev.sessionId !== t.sessionId) onNewSession(threadId, t, ev.sessionId, ev.contextReplacement ? ev.previousSessionId : undefined);
        if (ev.type === 'agent' && ev.sessionId && !get().settings.subSessions.includes(ev.sessionId)) {
          persist({ subSessions: [ev.sessionId, ...get().settings.subSessions].slice(0, 1000) });
        }
        if(ev.type==='message.receipt'&&ev.status==='failed'&&!ev.agent)get().toast(tr('store.sendFailed',{error:ev.error??''}),'error');
        if (ev.type === 'turn.end'&&!ev.agent&&!ev.contextCheckpoint&&!ev.waitingAgents) onResult(threadId);
        if (ev.type === 'task' && ev.op === 'end'&&!ev.agent) {
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
      };
      if (window.desk.onEvents) window.desk.onEvents((batch) => {
        let pending: { threadId: string; ev: DeskEvent }[] = [];
        const flush = () => {
          if (!pending.length) return;
          set((s) => {
            let threads = s.threads;
            for (const { threadId, ev } of pending) {
              const t = threads[threadId];
              if (!t) continue;
              const next = applyEvent(t, ev);
              if (next === t) continue;
              if (threads === s.threads) threads = { ...threads };
              threads[threadId] = next;
            }
            return threads === s.threads ? s : { threads };
          });
          pending = [];
        };
        for (const payload of batch) {
          const ev = payload.ev;
          // Side effects must observe exactly the preceding events in the stream.
          if (ev.type === 'session' || ev.type === 'limits' || ev.type === 'turn.end'
            || (ev.type === 'agent' && ev.sessionId) || (ev.type === 'task' && ev.op === 'end')) {
            flush();
            onEvent(payload);
          } else pending.push(payload);
        }
        flush();
      });
      else window.desk.onEvent(onEvent);
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
          for(let index=0;index<entries.length;index++){const entry=entries[index];if(entry.kind==='turn')entries[index]={...entry,items:entry.items.map(item=>item.kind==='steer'&&item.delivery&&['sending','accepted'].includes(item.delivery)?{...item,delivery:'failed',delivered:false,error:error??tr('turn.steerCancelled')}:item)};}
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
            // Remote callers (Telegram) pick Claude models.
            ...(r.model && x.provider === 'claude' ? { model: r.model } : {}),
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
      // A session this window shows was continued elsewhere.
      window.desk.subscribe<{ threadId: string; sessionId: string }>('desk:session-changed', ({ threadId, sessionId }) => {
        const t = get().threads[threadId] ?? Object.values(get().threads).find((x) => x.sessionId === sessionId);
        if (t) get().syncThread(t.id);
      });

      get().refreshSessions();
      try {
        const p = await window.desk.probe();
        set((s) => ({
          usageBy: { ...s.usageBy, ...Object.fromEntries(Object.entries(p.providers ?? {}).filter(([, v]) => v.usage).map(([k, v]) => [k, toUsage(v.usage)])) },
        }));
        // Limits move with time (and reset): keep them fresh while the app is open.
        setInterval(() => get().refreshUsage(), 5 * 60_000);
        window.addEventListener('focus', () => Date.now() - lastUsageAt > 60_000 && get().refreshUsage());
        set({
          ready: true,
          providers: Object.fromEntries(providerEntries(p.providers ?? {})),
          models: p.models,
          account: p.account ?? {},
          commands: p.commands ?? [],
          mcp: (p as any).mcp ?? [],
          usage: toUsage(p.providers?.claude?.usage ?? p.usage),
        });
        lastUsageAt = Date.now();
      } catch (e: any) {
        set({ ready: true, probeError: String(e?.message ?? e) });
      }
      })().catch((error) => { initPromise = undefined; throw error; });
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

    openSession(info) {
      const s = get();
      const aliases = linkedSessionIds(info.sessionId, s.settings.links);
      const existing = Object.values(s.threads).find((t) => threadSessionIds(t).some((id) => aliases.has(id)));
      if (existing) {
        set({ activeId: existing.id });
        return;
      }
      const detached = s.detached.find((id) => aliases.has(id));
      if (!isDetachedWindow() && detached) {
        window.desk.call('win:focus', detached).catch(() => {});
        return;
      }
      const members = [...new Map([info, ...s.sessions.filter((x) => aliases.has(x.sessionId))].map((x) => [x.sessionId, x])).values()]
        .sort((a, b) => b.lastModified - a.lastModified);
      const latest = members[0];
      const provider = s.settings.chatProviders[latest.sessionId] ?? latest.provider ?? 'claude';
      const sessions: Partial<Record<ProviderId, string>> = {};
      for (const part of [...members].reverse()) sessions[part.provider ?? 'claude'] = part.sessionId;
      const t: Thread = {
        ...blankThread(s.settings, latest.cwd),
        ...agentDefaults(s.settings, provider),
        provider, sessions, id: latest.sessionId, sessionId: sessions[provider], title: latest.title,
        loaded: false, loading: true,
        ...(s.worktrees[latest.cwd.toLowerCase()] ? { workMode: 'worktree' as const, worktree: s.worktrees[latest.cwd.toLowerCase()] } : {}),
      };
      set({ threads: { ...s.threads, [t.id]: t }, activeId: t.id });
      Promise.all(members.map(async (part) => {
        const page = await historyPage(part);
        return { ...fromHistory(page.events, part.provider ?? 'claude'), part, previous: page.previous };
      })).then((histories) => {
        const entries = histories.flatMap((h) => h.entries).sort((a, b) =>
          (a.kind === 'user' ? a.ts : a.startedAt) - (b.kind === 'user' ? b.ts : b.startedAt));
        const agents = Object.assign({}, ...histories.map((h) => h.agents));
        const last = [...entries].reverse().find((e) => e.kind === 'turn');
        update(t.id, (x) => ({
          ...x, entries, agents, loaded: true, loading: false,
          ...(last?.kind === 'turn' && last.provider && last.provider !== provider ? { handoff: { from: last.provider } } : {}),
        }));
        // Compactions are earlier history inside a session, not separate chat branches.
        const pages = histories.flatMap(h => h.previous === null ? [] : [{ ...h.part, cursor: h.previous }]);
        Promise.all(members.map(async (part) => (await window.desk.segments(part.sessionId, part.cwd, part.provider).catch(() => []))
          .map((segment) => ({ ...part, segment: segment.segment, lastModified: Date.parse(segment.ts) || part.lastModified }))
        )).then((parts) => update(t.id, (x) => ({ ...x, chain: [...pages, ...parts.flat()].sort((a, b) => b.lastModified - a.lastModified), chainLoaded: 0, chainExpanded: true })));
      }).catch((e) => {
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
        const loaded = await Promise.all(parts.map(historyPage));
        const earlier = parts
          .map((p, i) => fromHistory(loaded[i].events, p.provider ?? 'claude'))
          .reverse();
        update(id, (x) => ({
          ...x,
          entries: [...earlier.flatMap((h) => h.entries), ...x.entries].sort(byEntryTime),
          chain: [...x.chain!.slice(0, start + parts.length), ...parts.flatMap((p,i) => loaded[i].previous === null ? [] : [{...p,cursor:loaded[i].previous!}]), ...x.chain!.slice(start + parts.length)],
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
      if (t?.draftTextFiles?.some(file => file.pending || file.error)) return;
      text = withPastedText(text, t?.draftTextFiles ?? []);
      if (!t || t.loading || (!text.trim() && !images.length)) return;
      if (!providerEnabled(t.provider)) return get().toast(tr('store.providerDisabled'), 'error');
      if(t.provider==='codex'&&t.codex?.questions)update(id,x=>({...x,codex:{...x.codex,questions:null}}));
      if(t.provider==='kimi'&&!images.length&&!t.draftTextFiles?.length){
        const command=/^\/(status|help|login|compact|model|permissions|goal|swarm|tower|btw|tasks|agents|skills|mcp|plugins|hooks|new|clear|fork)(?:\s+([\s\S]*))?$/.exec(text.trim());
        if(command){const name=command[1],argument=command[2]?.trim()??'';const panel=(tab:string)=>set({kimiPanel:{threadId:id,tab,seq:(get().kimiPanel?.seq??0)+1}});update(id,x=>({...x,draft:'',draftImages:[]}));
          if(name==='new'||name==='clear'){const fresh=get().newThread(t.cwd);get().switchProvider(fresh,'kimi');return;}
          if(name==='fork'){if(t.status==='running'){update(id,x=>({...x,draft:text}));return;}void get().forkFrom(id);return;}
          if(name==='model'&&argument){get().setModel(id,argument);return;}
          if(name==='permissions'&&['default','acceptEdits','auto','plan'].includes(argument)){get().setPermissionMode(id,argument as PermMode);return;}
          if(name==='compact'){void get().kimiAction(id,'compact',argument?{instruction:argument}:{}).catch(()=>{});return;}
          if(name==='btw'&&argument){void get().kimiAction(id,'btw',{text:argument}).catch(()=>{});panel('agents');return;}
          if(name==='goal'&&argument){void get().kimiAction(id,['pause','resume','cancel'].includes(argument)?'goal/'+argument:'goal/set',{objective:argument}).catch(()=>{});panel('goal');return;}
          if((name==='swarm'||name==='tower')&&['on','off'].includes(argument)){void get().kimiAction(id,name,{enabled:argument==='on'}).catch(()=>{});panel('status');return;}
          panel(name==='login'?'account':['status','help','model','permissions','swarm','tower'].includes(name)?'status':name);return;
        }
      }
      if(t.provider==='codex'&&!images.length&&!t.draftTextFiles?.length){
        const command=/^\/(status|help|mcp|skills|goal|model|permissions|diff|new|clear|fork)(?:\s+([\s\S]*))?$/.exec(text.trim());
        if(command){
          const name=command[1],argument=command[2]?.trim()??'';
          const panel=(tab:string)=>set({codexPanel:{threadId:id,tab,seq:(get().codexPanel?.seq??0)+1}});
          update(id,x=>({...x,draft:'',draftImages:[]}));
          if(name==='new'||name==='clear'){const fresh=get().newThread(t.cwd);get().switchProvider(fresh,'codex');return;}
          if(name==='fork'){if(t.status==='running'){update(id,x=>({...x,draft:text}));return;}void get().forkFrom(id);return;}
          if(name==='diff'){get().activate(id);get().setPanelTab('git');get().setSettings({changesOpen:true});return;}
          if(name==='model'&&argument){const model=modelsOf(get(),'codex').find(m=>m.value===argument);if(model)get().setModel(id,model.value);else{update(id,x=>({...x,draft:text}));panel('status');}return;}
          if(name==='permissions'&&['default','acceptEdits','auto','plan','bypassPermissions'].includes(argument)){get().setPermissionMode(id,argument as PermMode);return;}
          if(name==='goal'&&argument){
            if(argument==='pause'||argument==='resume'||argument==='clear')void get().codexAction(id,argument==='clear'?'goal/clear':'goal/set',argument==='clear'?{}:{status:argument==='pause'?'paused':'active'}).catch(()=>{});
            else void get().codexAction(id,'goal/set',{objective:argument,status:'active'}).catch(()=>{});
            panel('goal');return;
          }
          panel(name==='mcp'||name==='skills'||name==='goal'?name:'status');return;
        }
        const match=/^\/(compact|review)(?:\s+([\s\S]*))?$/.exec(text.trim());
        if(match){if(t.status==='running')return;update(id,x=>({...x,draft:'',draftImages:[]}));void get().codexAction(id,match[1],match[1]==='review'&&match[2]?{target:{type:'custom',instructions:match[2]}}:{}).catch(()=>{});return;}
      }
      if (images.length && get().providers[t.provider]?.caps?.images === false) {
        get().toast(tr('composer.imagesUnsupported', { name: get().providers[t.provider]?.label ?? t.provider }), 'error');
        return;
      }
      if (t.worktree?.removed) {
        get().toast(tr('store.worktreeGone'), 'error');
        return;
      }
      update(id, (x) => ({ ...x, draft: '', draftImages: [], draftTextFiles: [] }));
      if (t.status === 'running') {
        if (get().settings.followUp === 'steer' && get().providers[t.provider]?.caps?.steer !== false) {
          const uuid=crypto.randomUUID();
          const item={kind:'steer' as const,id:uuid,text,images,delivered:false,delivery:'sending' as const};
          const place=(x:Thread)=>{
            const entries=[...x.entries],last=entries.at(-1);
            if(last?.kind==='turn'&&!last.done)entries[entries.length-1]={...last,items:[...last.items,item]};
            else entries.push({kind:'turn',id:uid(),provider:t.provider,items:[item],startedAt:Date.now(),done:x.status!=='running'});
            return{...x,entries};
          };
          update(id,place);
          void (preparing.get(id)??Promise.resolve(true)).then(async ready=>{
            if(!ready)throw Error(tr('turn.steerInitialFailed'));
            const current=get().threads[id];
            if(!current||current.provider!==t.provider||current.stopRequested)throw Error(tr('turn.steerCancelled'));
            await window.desk.send({threadId:id,provider:current.provider,cwd:current.cwd,model:current.model,effort:effortFor(current),permissionMode:current.permissionMode,resume:current.sessionId,text,images,uuid,priority:'next'});
            if(window.desk.nativeHistoryPaging!==true)update(id,x=>applyEvent(x,{type:'message.receipt',id:uuid,status:'accepted'}));
          }).catch((error:any)=>{
            const message=String(error?.message??error);
            update(id,x=>{
              const exists=x.entries.some(e=>e.kind==='turn'&&e.items.some(i=>i.id===uuid));
              return applyEvent(exists?x:place(x),{type:'message.receipt',id:uuid,status:'failed',error:message});
            });
            get().toast(tr('store.sendFailed',{error:message}),'error');
          });
          return;
        }
        update(id, (x) => ({ ...x, queue: [...x.queue, { id: uid(), text, images }] }));
        return;
      }
      dispatch(id, text.trim(), images);
    },

    retrySteer(id,messageId){
      const thread=get().threads[id];if(!thread||thread.loading||thread.worktree?.removed)return;
      const item=thread.entries.flatMap(e=>e.kind==='turn'?e.items:[]).find(i=>i.kind==='steer'&&i.id===messageId);
      if(item?.kind!=='steer'||!['failed','cancelled'].includes(item.delivery??'')||(item.images?.length&&get().providers[thread.provider]?.caps?.images===false))return;
      get().send(id,item.text,item.images??[]);
      update(id,x=>({...x,entries:x.entries.map(e=>e.kind==='turn'?{...e,items:e.items.filter(i=>i.id!==messageId)}:e)}));
    },

    interrupt(id) {
      update(id, (t) => ({ ...t, stopRequested: true, queue: [] }));
      window.desk.interrupt(id).catch(() => {});
    },

    setModel(id, model) {
      const t = get().threads[id];
      update(id, (x) => ({ ...x, model }));
      rememberModel(t?.provider ?? 'claude', { model, effort: t?.effort ?? get().settings.effort });
      window.desk.configure({ threadId: id, model }).catch((e) => get().toast(String(e?.message ?? e), 'error'));
    },

    setServiceTier(id,tier){update(id,x=>({...x,serviceTier:tier}));window.desk.configure({threadId:id,serviceTier:tier}).catch(e=>get().toast(String(e),'error'));},
    async kimiAction(id,action,params={}){
      const thread=get().threads[id];if(!thread||thread.provider!=='kimi')return;
      const generates=action==='compact'||action==='skills/activate';if(generates&&thread.status==='running')throw Error(tr('kimi.loading'));
      if(generates)update(id,x=>({...x,status:'running',entries:[...x.entries,{kind:'turn',id:uid(),provider:'kimi',items:[],startedAt:Date.now(),done:false}]}));
      try{return await window.desk.call('desk:kimi',{...params,action,threadId:id,sessionId:thread.sessionId,config:{cwd:thread.cwd,model:thread.model,effort:effortFor(thread),permissionMode:thread.permissionMode,role:thread.role}});}catch(error:any){if(generates)update(id,x=>applyEvent(x,{type:'turn.end',isError:true,error:String(error)}));get().toast(String(error),'error');throw error;}
    },
    async codexAction(id,action,params={}){
      const thread=get().threads[id];if(!thread||thread.provider!=='codex')return;
      const generates=action==='review'||action==='compact';
      if(generates&&thread.status==='running')return;
      if(generates)update(id,x=>({...x,status:'running',entries:[...x.entries,{kind:'turn',id:uid(),provider:'codex',items:[],startedAt:Date.now(),done:false}]}));
      try{
        const result=await window.desk.call('desk:codex',{...params,action,threadId:id,sessionId:thread.sessionId,cwd:thread.cwd,config:{cwd:thread.cwd,model:thread.model,effort:effortFor(thread),permissionMode:thread.permissionMode,serviceTier:thread.serviceTier}});
        if(result&&Object.prototype.hasOwnProperty.call(result,'goal'))update(id,x=>({...x,codex:{...x.codex,goal:result.goal}}));
        if(action==='goal/clear')update(id,x=>({...x,codex:{...x.codex,goal:null}}));
        return result;
      }catch(error:any){
        if(generates)update(id,x=>applyEvent(x,{type:'turn.end',isError:true,error:String(error?.message??error)}));
        get().toast(String(error?.message??error),'error');throw error;
      }
    },
    setEffort(id, effort) {
      const t = get().threads[id];
      update(id, (x) => ({ ...x, effort }));
      rememberModel(t?.provider ?? 'claude', { model: t?.model ?? 'default', effort });
      window.desk.configure({ threadId: id, effort }).catch((e) => get().toast(String(e?.message ?? e), 'error'));
    },

    async syncThread(id, manual = false) {
      const t = get().threads[id];
      if (!t?.sessionId || !t.loaded || t.loading) return;
      // Rewound: the file still has the dropped turns; it catches up with the next message.
      if (t.rewound) {
        if (manual) get().toast(tr('store.syncRewound'));
        return;
      }
      if (t.status === 'running') {
        if (manual) get().toast(tr('store.syncBusy'), 'error');
        return;
      }
      try {
        const page = await historyPage({sessionId:t.sessionId,cwd:t.cwd,provider:t.provider,title:t.title,lastModified:Date.now()});
        const events = page.events;
        const { entries: fresh, agents } = fromHistory(events, t.provider);
        const cur = get().threads[id];
        if (!cur || cur.status === 'running' || cur.sessionId !== t.sessionId) return;
        // A chat that went through several agents only takes additions, never a wholesale replace.
        const multiAgent = cur.entries.some((e) => e.kind === 'turn' && e.provider && e.provider !== cur.provider);
        const merged = mergeFromDisk(cur.entries, fresh, !multiAgent);
        if (!merged) {
          if (manual) get().toast(tr('store.syncNothing'));
          return;
        }
        update(id, (x) => ({ ...x, entries: merged.entries, agents: { ...x.agents, ...agents },
          ...(window.desk.nativeHistoryPaging === true ? {chain:[...(page.previous===null?[]:[{sessionId:t.sessionId!,cwd:t.cwd,provider:t.provider,title:t.title,lastModified:Date.now(),cursor:page.previous}]),...(x.chain??[]).slice(x.chainLoaded??0).filter(p=>p.sessionId!==t.sessionId||p.segment!==undefined)],chainLoaded:0} : merged.reset ? { chainLoaded: 0 } : {}) }));
        // The agent's live process doesn't know these turns: the next message resumes from disk.
        window.desk.call('desk:release', id).catch(() => {});
        get().toast(tr('store.synced'));
      } catch (e: any) {
        if (manual) get().toast(tr('store.historyFailed', { error: e?.message ?? e }), 'error');
      }
    },

    switchProvider(id, provider) {
      if (!providerEnabled(provider)) return;
      const t = get().threads[id];
      if (!t || t.loading || t.provider === provider) return;
      if (t.status === 'running') return get().toast(tr('store.switchWhileRunning'), 'error');
      const def = agentDefaults(get().settings, provider);
      const levels = modelsOf(get(), provider).find((m) => m.value === def.model)?.supportedEffortLevels;
      const effort = !levels?.length || levels.includes(def.effort) ? def.effort : levels.includes('high') ? 'high' : levels[levels.length - 1];
      if (t.entries.length === 0 && !t.sessionId) {
        update(id, (x) => ({ ...x, provider, model: def.model, effort }));
        persist({ provider });
        return;
      }
      const sessions = { ...(t.sessions ?? {}), ...(t.sessionId ? { [t.provider]: t.sessionId } : {}) };
      const label = get().providers[provider]?.label ?? provider;
      update(id, (x) => {
        const entries = [...x.entries];
        const last = entries[entries.length - 1];
        if (last?.kind === 'turn') {
          entries[entries.length - 1] = { ...last, items: [...last.items, { kind: 'notice', id: uid(), text: tr('store.switchedTo', { name: label }), tone: 'info' }] };
        }
        return {
          ...x,
          entries,
          provider,
          model: def.model,
          effort,
          sessions,
          // Back on an agent that already worked here: continue its own session.
          sessionId: sessions[provider],
          handoff: { from: t.handoff?.from ?? t.provider },
          context: undefined,
          activity: undefined,
          // Every session of the chat carries the chat's title.
          retitle: !isDefaultTitle(x.title),
          approvals: [],
        };
      });
      const aliases = threadSessionIds(get().threads[id]).flatMap((key) => [...linkedSessionIds(key, get().settings.links)]);
      persist({ chatProviders: { ...get().settings.chatProviders, ...Object.fromEntries(aliases.map((key) => [key, provider])) } });
      // Release only the provider run; the chat, browser, draft and history retain their identity.
      window.desk.call('desk:switch-provider', { threadId: id, provider, resume: sessions[provider], previousProvider:t.provider,previousSessionId:t.sessionId,cwd:t.cwd,contextHistory:Object.entries(sessions).map(([provider,sessionId])=>({provider,sessionId,cwd:t.cwd})) })
        .catch((e) => {if(get().threads[id]?.provider===provider)update(id,()=>t);get().toast(String(e?.message ?? e), 'error');});
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

    async pasteText(id, text, retryId) {
      if (!get().threads[id]) return;
      const fileId = retryId ?? crypto.randomUUID();
      const pending: PastedTextFile = { id: fileId, name: `pasted-text-${fileId}.txt`, path: '', lines: pastedLineCount(text), bytes: new TextEncoder().encode(text).length, pending: true, source: text };
      update(id, t => ({ ...t, draftTextFiles: retryId ? (t.draftTextFiles ?? []).map(f => f.id === fileId ? pending : f) : [...(t.draftTextFiles ?? []), pending] }));
      try {
        const file = await window.desk.call<{ name: string; path: string; lines: number; bytes: number }>('fs:pasteText', text);
        update(id, t => ({ ...t, draftTextFiles: (t.draftTextFiles ?? []).map(f => f.id === fileId ? { ...file, id: fileId } : f) }));
      } catch (error: any) {
        const message = String(error?.message ?? error);
        update(id, t => ({ ...t, draftTextFiles: (t.draftTextFiles ?? []).map(f => f.id === fileId ? { ...pending, pending: false, error: message } : f) }));
        get().toast(tr('composer.pasteFailed', { error: message }), 'error');
      }
    },

    removePastedText(id, fileId) {
      update(id, t => ({ ...t, draftTextFiles: (t.draftTextFiles ?? []).filter(f => f.id !== fileId) }));
    },

    removeQueued(id, qid) {
      update(id, (t) => ({ ...t, queue: t.queue.filter((q) => q.id !== qid) }));
    },

    stopTask(id, taskId) {
      window.desk.stopTask(id, taskId).catch((e) => get().toast(tr('store.stopFailed', { error: e?.message ?? e }), 'error'));
    },
    async messageAgent(id,runId,text){await window.desk.call('agent:send',{threadId:id,delegate:runId,text});},

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
            // A chat that just moved agents keeps its own title until its new session gets it.
            if (info && info.title && info.title !== t.title && t.entries.length > 0 && !t.retitle) {
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

    /** Plan limits of every available agent. */
    async refreshUsage() {
      lastUsageAt = Date.now();
      const ids = providerEntries(get().providers).map(([id]) => id).filter((id) => get().providers[id].available);
      await Promise.all(
        (ids.length ? ids : (['claude'] as ProviderId[])).map(async (id) => {
          try {
            const u = await window.desk.usage(id);
            if (!u) return;
            const usage = toUsage(u);
            set((s) => ({ usageBy: { ...s.usageBy, [id]: usage }, ...(id === 'claude' ? { usage } : {}) }));
          } catch {}
        }),
      );
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
      if (get().providers[get().threads[threadId]?.provider]?.caps?.rollback === false) return;
      set({ rewindDialog: { threadId, entryId } });
    },

    async performRewind(id, entryId, mode) {
      const t = get().threads[id];
      if (!t) return;
      const idx = t.entries.findIndex((e) => e.id === entryId);
      const entry = t.entries[idx];
      if (!entry || entry.kind !== 'user') return;
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
          const kept = t.entries.slice(0, idx);
          const dropped = t.entries.slice(idx);
          const journalBacked = t.provider === 'antigravity' || t.provider === 'gemini' || t.provider === 'kimi';
          const byTurns = journalBacked || get().providers[t.provider]?.caps?.rollback === 'turns';
          // Agents that drop whole turns: count this agent's turns from the rewound message on.
          const dropTurns = dropped.filter((e) => e.kind === 'turn' && (e.provider ?? t.provider) === t.provider).length;
          const prevOwnTurn = [...kept].reverse().find((e) => e.kind === 'turn' && (e.provider ?? t.provider) === t.provider);
          const keepSession = journalBacked
            ? Boolean(t.sessionId)
            : byTurns
              ? Boolean(prevOwnTurn && t.sessionId)
              : Boolean(prevOwnTurn && prevOwnTurn.kind === 'turn' && prevOwnTurn.lastUuid && t.sessionId);
          const resumeAt = byTurns ? (keepSession ? null : false) : keepSession && prevOwnTurn?.kind === 'turn' ? prevOwnTurn.lastUuid ?? null : null;
          await window.desk.rewindConversation({ threadId: id, resumeAt, dropTurns, sessionId: t.sessionId, provider: t.provider });
          const sessions: Partial<Record<ProviderId, string>> = { ...(t.sessions ?? {}), ...(t.sessionId ? { [t.provider]: t.sessionId } : {}) };
          if (!keepSession) delete sessions[t.provider];
          for (const [pId, sid] of Object.entries(sessions) as [ProviderId, string][]) {
            if (!sid || pId === t.provider) continue;
            const otherDropped = dropped.filter((e) => e.kind === 'turn' && (e.provider ?? t.provider) === pId).length;
            const otherKept = kept.some((e) => e.kind === 'turn' && (e.provider ?? t.provider) === pId);
            const otherJournal = pId === 'antigravity' || pId === 'gemini' || pId === 'kimi';
            const otherByTurns = otherJournal || get().providers[pId]?.caps?.rollback === 'turns';
            if (otherDropped > 0) {
              if (otherByTurns) await window.desk.rewindConversation({ threadId: id, dropTurns: otherDropped, sessionId: sid, provider: pId });
              else delete sessions[pId];
            }
            if (!otherKept && !otherJournal) delete sessions[pId];
          }
          const nativeResumed = keepSession && !(journalBacked && dropTurns > 0) && Boolean(prevOwnTurn);
          const lastKeptTurn = [...kept].reverse().find((e) => e.kind === 'turn');
          const handoffFrom = (lastKeptTurn?.kind === 'turn' ? lastKeptTurn.provider : undefined) ?? t.handoff?.from ?? t.provider;
          const nextHandoff =
            kept.length === 0
              ? undefined
              : !nativeResumed
                ? { from: handoffFrom, resume: false }
                : unseenEntries(kept, t.provider).entries.length > 0
                  ? { from: handoffFrom, resume: true }
                  : undefined;
          update(id, (x) => ({
            ...x,
            entries: kept,
            sessions,
            ...(keepSession ? {} : { sessionId: undefined }),
            handoff: nextHandoff,
            rewound: true,
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
      if (!t?.sessionId || get().providers[t.provider]?.caps?.fork === false) return;
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

    openFile(path, location) {
      const files = get().editorFiles;
      set({ editorFiles: files.includes(path) ? files : [...files, path], editorActive: path, panelTab: 'files',editorLocation:location?{...location,path,seq:(get().editorLocation?.seq??0)+1}:undefined });
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
      if (t && agentId && t.agents[agentId]?.historical && !t.agents[agentId].transcriptLoaded) get().loadAgentTranscripts(t.id,agentId);
    },

    async loadAgentTranscripts(id, agentId, before) {
      const t = get().threads[id];
      if (!t) return;
      const sessions = { ...(t.sessions ?? {}), ...(t.sessionId ? { [t.provider]: t.sessionId } : {}) };
      try {
        if(window.desk.nativeHistoryPaging===true&&window.desk.loadSubagentPage&&agentId){
          const known=t.agents[agentId];if(!known)return;
          const sources=known.transcriptSession?[known.transcriptSession]:Object.entries(sessions).map(([provider,sessionId])=>({provider:provider as ProviderId,sessionId:sessionId!}));
          for(const source of sources){
            const page=await window.desk.loadSubagentPage(source.sessionId,t.cwd,source.provider,agentId,{before,limit:40});
            if(page.found===false)continue;
            update(id,x=>{const current=x.agents[agentId];if(!current)return x;
              const base=before===undefined?{...current,items:current.items.filter(item=>item.kind==='agentmsg'&&item.id===`${agentId}:prompt`)}:{...current,items:[]};
              const loaded=applyAgentTranscripts({...x.agents,[agentId]:base},page.events)[agentId];
              const items=before===undefined?loaded.items:[...loaded.items,...current.items.filter(item=>!loaded.items.some(older=>older.id===item.id))];
              return {...x,agents:{...x.agents,[agentId]:{...loaded,items,transcriptLoaded:true,transcriptCursor:page.previous??undefined,transcriptSession:source}}};});
            return;
          }
          update(id,x=>({...x,agents:{...x.agents,[agentId]:{...x.agents[agentId],transcriptLoaded:true}}}));
          return;
        }
        const batches = await Promise.all(Object.entries(sessions).map(([provider, sessionId]) =>
          window.desk.loadSubagents(sessionId!, t.cwd, provider as ProviderId)));
        update(id, (x) => ({ ...x, agents: Object.fromEntries(Object.entries(batches.reduce((agents, events) => applyAgentTranscripts(agents, events), x.agents)).map(([key,agent])=>[key,{...agent,transcriptLoaded:true}])) }));
      } catch (e: any) {
        get().toast(tr('store.agentsFailed', { error: e?.message ?? e }), 'error');
      }
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

// Tell the main process which sessions this window shows, so it can notice them changing elsewhere.
const WINDOW_KEY = crypto.randomUUID();
let watchedKey = '';
let watchTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.threads === prev.threads) return;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    const list = Object.values(useStore.getState().threads)
      .filter((t) => t.sessionId && t.loaded)
      .map((t) => ({ threadId: t.id, sessionId: t.sessionId!, provider: t.provider, cwd: t.cwd }));
    const key = JSON.stringify(list);
    if (key === watchedKey) return;
    watchedKey = key;
    window.desk.call('desk:watch', WINDOW_KEY, list).catch(() => {});
  }, 600);
});

export const projectName = (cwd: string) => basename(cwd) || cwd || tr('common.noProject');

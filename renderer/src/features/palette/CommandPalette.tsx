import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import {
  Archive,
  Boxes,
  Columns2,
  Command,
  CornerDownLeft,
  FileCode2,
  FileDiff,
  Folder,
  FolderPlus,
  Globe,
  MessageSquare,
  MessageSquarePlus,
  PanelLeft,
  PanelRightClose,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  SquareTerminal,
  SunMoon,
  TextSearch,
} from 'lucide-react';
import { projectName, projectOf, useStore, type PanelTab } from '../../store';
import type { Project, SessionInfo, ThemePref, Thread } from '../../types';
import { basename, relativeTime } from '../../lib/format';
import { spring, useOverlay } from '../../components/Popover';
import { openSearch, useSearchStore } from '../search/SearchModal';
import { fuzzyAny } from './fuzzy';
import { t } from '../../i18n';
import { FORK_SUFFIX } from '../../components/Sidebar';
import './palette.css';

/* ---------- store ---------- */

interface PaletteState {
  open: boolean;
  q: string;
  setOpen(open: boolean): void;
  setQ(q: string): void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  q: '',
  setOpen: (open) => set({ open }),
  setQ: (q) => set({ q }),
}));

/** Opens the palette; `prefix` preselects a mode ('>' actions, '#' projects, '@' chats). */
export const openPalette = (prefix = '') => usePaletteStore.setState({ open: true, q: prefix });
export const closePalette = () => usePaletteStore.setState({ open: false });
export const togglePalette = () => (usePaletteStore.getState().open ? closePalette() : openPalette());

/* ---------- recently used ---------- */

const MRU_KEY = 'desk.palette.mru';
const MRU_MAX = 12;

function readMru(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MRU_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MRU_MAX) : [];
  } catch {
    return [];
  }
}

function pushMru(id: string) {
  try {
    const next = [id, ...readMru().filter((x) => x !== id)].slice(0, MRU_MAX);
    localStorage.setItem(MRU_KEY, JSON.stringify(next));
  } catch {}
}

/* ---------- items ---------- */

type SectionId = 'actions' | 'projects' | 'chats' | 'search';

const sectionLabel = (id: SectionId) => t(`palette.section.${id}`);

interface Item {
  id: string;
  section: SectionId;
  label: string;
  /** Secondary text after the label. */
  sub?: string;
  /** Searchable but not shown (synonyms, English words, paths). */
  keywords?: string;
  icon: ReactNode;
  keys?: string[];
  /** Chats: project name and time on the right. */
  project?: string;
  time?: number;
  running?: boolean;
  current?: boolean;
  /** Remembered in the recently-used list. */
  mru?: boolean;
  run(): void;
  /** Ctrl+Enter: open next to the current chat. */
  split?(): void;
}

interface Scored {
  item: Item;
  pos: number[];
  score: number;
}

// Default titles in every UI language (titles may have been created in another one).
const commonDicts = import.meta.glob('../../i18n/locales/*/common.json', { eager: true, import: 'default' }) as Record<string, Record<string, string>>;
const GENERIC_TITLES = new Set(
  Object.values(commonDicts)
    .flatMap((d) => [d.newChat, d.untitled])
    .filter(Boolean)
    .map((x) => x.trim().toLowerCase()),
);
const baseTitle = (title: string) => {
  const t = title.replace(FORK_SUFFIX, '').trim().toLowerCase();
  return t.length >= 6 && !GENERIC_TITLES.has(t) ? t : '';
};

const normDir = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

const themeLabel = (theme: ThemePref) => t(`palette.theme.${theme}`);
const THEME_NEXT: Record<ThemePref, ThemePref> = { system: 'dark', dark: 'light', light: 'system' };

type Snapshot = ReturnType<typeof useStore.getState>;

function currentProject(s: Snapshot, t: Thread | undefined): Project | undefined {
  if (!t) return undefined;
  return (
    (t.projectId ? s.settings.projects.find((p) => p.id === t.projectId) : undefined) ??
    projectOf(s.settings, t.sessionId ?? t.id, t.worktree?.base ?? t.cwd)
  );
}

function togglePanel(tab: PanelTab) {
  const s = useStore.getState();
  if (s.settings.changesOpen && s.panelTab === tab) s.setSettings({ changesOpen: false });
  else {
    s.setPanelTab(tab);
    s.setSettings({ changesOpen: true });
  }
}

function buildActions(s: Snapshot): Item[] {
  const th = s.threads[s.activeId];
  const started = Boolean(th && th.entries.length > 0);
  const open = s.settings.changesOpen;
  const tab = s.panelTab;
  const project = currentProject(s, th);
  const items: Item[] = [];
  const add = (it: Omit<Item, 'section' | 'mru'>) => items.push({ ...it, section: 'actions', mru: true });

  add({
    id: 'new-chat',
    label: t('common.newChat'),
    keywords: t('palette.newChat.keywords'),
    icon: <SquarePen size={15} />,
    keys: ['Ctrl', 'N'],
    run: () => useStore.getState().newThread(),
  });
  if (project || th?.cwd) {
    add({
      id: 'new-chat-project',
      label: t('palette.newChatProject'),
      sub: project?.name ?? projectName(th!.worktree?.base ?? th!.cwd),
      keywords: t('palette.newChatProject.keywords'),
      icon: <MessageSquarePlus size={15} />,
      run: () => {
        const st = useStore.getState();
        if (project) st.newThreadInProject(project.id);
        else st.newThread(th!.worktree?.base ?? th!.cwd);
      },
    });
  }
  add({
    id: 'create-project',
    label: t('palette.createProject'),
    keywords: t('palette.createProject.keywords'),
    icon: <FolderPlus size={15} />,
    run: () => useStore.setState({ projectModal: {} }),
  });
  add({
    id: 'search',
    label: t('palette.search'),
    keywords: t('palette.search.keywords'),
    icon: <TextSearch size={15} />,
    keys: ['Ctrl', 'Shift', 'F'],
    run: openSearch,
  });

  const filesOn = open && tab === 'files';
  add({
    id: 'files',
    label: t(filesOn ? 'palette.files.close' : 'palette.files.open'),
    keywords: t('palette.files.keywords'),
    icon: <FileCode2 size={15} />,
    keys: ['Ctrl', 'E'],
    run: () => togglePanel('files'),
  });
  const termOn = open && tab === 'terminal';
  add({
    id: 'terminal',
    label: t(termOn ? 'palette.terminal.close' : 'palette.terminal.open'),
    keywords: t('palette.terminal.keywords'),
    icon: <SquareTerminal size={15} />,
    keys: ['Ctrl', '`'],
    run: () => togglePanel('terminal'),
  });
  const browserOn = open && tab === 'browser';
  add({
    id: 'browser',
    label: t(browserOn ? 'palette.browser.close' : 'palette.browser.open'),
    keywords: t('palette.browser.keywords'),
    icon: <Globe size={15} />,
    run: () => {
      const st = useStore.getState();
      if (st.settings.changesOpen && st.panelTab === 'browser') st.setSettings({ changesOpen: false });
      else st.openBrowser();
    },
  });
  if (started) {
    const changesOn = open && (tab === 'chat' || tab === 'git');
    add({
      id: 'changes',
      label: t(changesOn ? 'palette.changes.close' : 'palette.changes.open'),
      keywords: t('palette.changes.keywords'),
      icon: <FileDiff size={15} />,
      run: () => {
        const st = useStore.getState();
        if (st.settings.changesOpen && (st.panelTab === 'chat' || st.panelTab === 'git')) st.setSettings({ changesOpen: false });
        else {
          if (st.panelTab !== 'git') st.setPanelTab('chat');
          st.setSettings({ changesOpen: true });
        }
      },
    });
  }
  if (started && th && Object.keys(th.agents).length > 0) {
    const agentsOn = open && tab === 'agents';
    add({
      id: 'agents',
      label: t(agentsOn ? 'palette.agents.close' : 'palette.agents.open'),
      keywords: t('palette.agents.keywords'),
      icon: <Sparkles size={15} />,
      run: () => {
        const st = useStore.getState();
        if (st.settings.changesOpen && st.panelTab === 'agents') st.setSettings({ changesOpen: false });
        else st.openAgent();
      },
    });
  }
  if (s.split) {
    add({
      id: 'split',
      label: t('palette.split.close'),
      keywords: t('palette.split.closeKeywords'),
      icon: <PanelRightClose size={15} />,
      run: () => useStore.getState().closeSplit(),
    });
  } else {
    add({
      id: 'split',
      label: t('palette.split.open'),
      sub: t('palette.split.sub'),
      keywords: t('palette.split.openKeywords'),
      icon: <Columns2 size={15} />,
      run: () => useStore.getState().openSplit(),
    });
  }
  add({
    id: 'sidebar',
    label: t('palette.sidebar'),
    sub: t(s.settings.sidebarOpen ? 'palette.sidebar.hide' : 'palette.sidebar.show'),
    keywords: t('palette.sidebar.keywords'),
    icon: <PanelLeft size={15} />,
    keys: ['Ctrl', 'B'],
    run: () => {
      const st = useStore.getState();
      st.setSettings({ sidebarOpen: !st.settings.sidebarOpen });
    },
  });
  const theme = s.settings.theme;
  add({
    id: 'theme',
    label: t('palette.theme'),
    sub: `${themeLabel(theme)} → ${themeLabel(THEME_NEXT[theme])}`,
    keywords: t('palette.theme.keywords'),
    icon: <SunMoon size={15} />,
    run: () => {
      const st = useStore.getState();
      const next = THEME_NEXT[st.settings.theme];
      st.setSettings({ theme: next });
      st.toast(t('palette.theme.toast', { theme: themeLabel(next) }));
    },
  });
  add({
    id: 'settings',
    label: t('palette.settings'),
    keywords: t('palette.settings.keywords'),
    icon: <Settings size={15} />,
    keys: ['Ctrl', ','],
    run: () => useStore.setState({ settingsOpen: true }),
  });
  const archiveKey = th?.sessionId ?? (started ? th?.id : undefined);
  if (th && archiveKey && !s.settings.archived.includes(archiveKey)) {
    add({
      id: 'archive',
      label: t('palette.archive'),
      sub: th.title.replace(FORK_SUFFIX, ''),
      keywords: t('palette.archive.keywords'),
      icon: <Archive size={15} />,
      run: () => {
        const older = (th.chain ?? []).filter((p) => p.segment == null).map((p) => p.sessionId);
        const st = useStore.getState();
        st.archiveChats([...new Set([archiveKey, ...older])], true);
        st.toast(t('palette.archive.done'));
      },
    });
  }
  return items;
}

/** Default actions on an empty query, before recently used ones are mixed in. */
const DEFAULT_ACTIONS = ['new-chat', 'new-chat-project', 'search', 'create-project', 'settings'];

function buildProjects(s: Snapshot, latest: Map<string, number>): Item[] {
  const { projects, recentProjects } = s.settings;
  const items: Item[] = [...projects]
    .sort((a, b) => (latest.get(b.id) ?? b.createdAt) - (latest.get(a.id) ?? a.createdAt))
    .map((p) => ({
      id: 'project:' + p.id,
      section: 'projects' as const,
      label: p.name,
      sub: p.folders.length ? p.folders[0] + (p.folders.length > 1 ? ` +${p.folders.length - 1}` : '') : t('palette.noFolders'),
      keywords: p.folders.join(' '),
      icon: <Boxes size={15} />,
      mru: true,
      run: () => useStore.getState().newThreadInProject(p.id),
    }));
  const owned = new Set(projects.flatMap((p) => p.folders.map(normDir)));
  const seen = new Set<string>();
  for (const dir of recentProjects) {
    const k = normDir(dir);
    if (!dir || owned.has(k) || seen.has(k)) continue;
    seen.add(k);
    items.push({
      id: 'folder:' + k,
      section: 'projects',
      label: basename(dir),
      sub: dir,
      keywords: dir,
      icon: <Folder size={15} />,
      mru: true,
      run: () => useStore.getState().newThread(dir),
    });
  }
  return items;
}

interface ChatRow {
  key: string;
  title: string;
  ts: number;
  cwd: string;
  projectId?: string;
  session?: SessionInfo;
  thread?: Thread;
  older: ChatRow[];
}

/** Recent chats newest first; continuations of one long conversation collapse into one row (like the sidebar). */
function buildChats(s: Snapshot): { items: Item[]; latest: Map<string, number> } {
  const { threads, sessions, worktrees, settings, activeId } = s;
  const archived = new Set(settings.archived);
  const baseOf = (cwd: string) => worktrees[(cwd || '').toLowerCase()]?.base ?? cwd ?? '';
  const known = new Set(sessions.map((x) => x.sessionId));
  const bySession = new Map<string, Thread>();
  for (const t of Object.values(threads)) if (t.sessionId) bySession.set(t.sessionId, t);

  const rows: ChatRow[] = [];
  const now = Date.now();
  for (const t of Object.values(threads)) {
    if (t.entries.length && (!t.sessionId || !known.has(t.sessionId)))
      rows.push({ key: t.sessionId ?? t.id, title: t.title, ts: now, cwd: baseOf(t.cwd), projectId: t.projectId, thread: t, older: [] });
  }
  for (const x of sessions) {
    const t = bySession.get(x.sessionId);
    rows.push({ key: x.sessionId, title: x.title, ts: x.lastModified, cwd: baseOf(x.cwd), projectId: t?.projectId, session: x, thread: t, older: [] });
  }
  rows.sort((a, b) => b.ts - a.ts);

  const heads = new Map<string, ChatRow>();
  const out: ChatRow[] = [];
  for (const r of rows) {
    if (archived.has(r.key)) continue;
    const base = baseTitle(r.title);
    const head = base ? heads.get(base) : undefined;
    if (head) head.older.push(r);
    else {
      if (base) heads.set(base, r);
      out.push(r);
    }
  }

  const latest = new Map<string, number>();
  const active = threads[activeId];
  const items = out.map((r): Item => {
    const project = (r.projectId && settings.projects.find((p) => p.id === r.projectId)) || projectOf(settings, r.key, r.cwd);
    if (project) latest.set(project.id, Math.max(latest.get(project.id) ?? 0, r.ts));
    const go = () => {
      const st = useStore.getState();
      if (r.thread && st.threads[r.thread.id]) st.activate(r.thread.id);
      else if (r.session) st.openSession(r.session, r.older.map((o) => o.session!).filter(Boolean));
    };
    const isCurrent = Boolean(active && (active.id === r.key || active.sessionId === r.key));
    return {
      id: 'chat:' + r.key,
      section: 'chats',
      label: r.title.replace(FORK_SUFFIX, '') || t('common.untitled'),
      keywords: `${project?.name ?? ''} ${r.cwd}`,
      icon: <MessageSquare size={15} />,
      project: project?.name ?? projectName(r.cwd),
      time: r.ts,
      running: r.thread?.status === 'running',
      current: isCurrent,
      run: go,
      split: () => (isCurrent ? go() : useStore.getState().openSplit(go)),
    };
  });
  return { items, latest };
}

/* ---------- filtering ---------- */

type Mode = 'all' | 'actions' | 'projects' | 'chats';
const PREFIX: Record<string, Mode> = { '>': 'actions', '#': 'projects', '@': 'chats' };
const modeLabel = (mode: Mode) => (mode === 'all' ? '' : sectionLabel(mode));

function parseQuery(raw: string): { mode: Mode; text: string } {
  const head = raw.trimStart()[0];
  if (head && PREFIX[head]) return { mode: PREFIX[head], text: raw.trimStart().slice(1).trim() };
  return { mode: 'all', text: raw.trim() };
}

const LIMIT: Record<SectionId, number> = { actions: 12, projects: 8, chats: 40, search: 1 };

function filter(items: Item[], text: string, mru: string[]): Scored[] {
  const out: Scored[] = [];
  for (const item of items) {
    const m = fuzzyAny(text, item.label, `${item.sub ?? ''} ${item.keywords ?? ''}`);
    if (!m) continue;
    const r = item.mru ? mru.indexOf(item.id) : -1;
    out.push({ item, pos: m.pos, score: m.score + (r >= 0 ? (MRU_MAX - r) * 0.5 : 0) });
  }
  return out.sort((a, b) => b.score - a.score || (b.item.time ?? 0) - (a.item.time ?? 0));
}

const byMru = (items: Item[], mru: string[]) =>
  [...items].sort((a, b) => {
    const ra = mru.indexOf(a.id);
    const rb = mru.indexOf(b.id);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  });

interface Section {
  id: SectionId;
  rows: Scored[];
}

function compute(s: Snapshot, raw: string, mru: string[]): Section[] {
  const { mode, text } = parseQuery(raw);
  const actions = mode === 'all' || mode === 'actions' ? buildActions(s) : [];
  const chats = mode === 'all' || mode === 'chats' || mode === 'projects' ? buildChats(s) : null;
  const projects = mode === 'all' || mode === 'projects' ? buildProjects(s, chats?.latest ?? new Map()) : [];
  const chatItems = mode === 'projects' ? [] : chats?.items ?? [];
  const plain = (items: Item[]): Scored[] => items.map((item) => ({ item, pos: [], score: 0 }));

  if (!text) {
    if (mode === 'actions') return [{ id: 'actions', rows: plain(byMru(actions, mru)) }];
    if (mode === 'projects') return [{ id: 'projects', rows: plain(byMru(projects, mru)) }];
    if (mode === 'chats') return [{ id: 'chats', rows: plain(chatItems.slice(0, 60)) }];
    const used = actions.filter((a) => mru.includes(a.id));
    const defaults = DEFAULT_ACTIONS.map((id) => actions.find((a) => a.id === id)).filter((a): a is Item => Boolean(a));
    const picked = [...new Set([...byMru(used, mru).slice(0, 3), ...defaults])].slice(0, 5);
    return [
      { id: 'actions' as const, rows: plain(picked) },
      { id: 'chats' as const, rows: plain(chatItems.slice(0, 8)) },
    ].filter((x) => x.rows.length);
  }

  const sections: Section[] = (
    [
      { id: 'actions', rows: filter(actions, text, mru).slice(0, mode === 'actions' ? 100 : LIMIT.actions) },
      { id: 'projects', rows: filter(projects, text, mru).slice(0, mode === 'projects' ? 100 : LIMIT.projects) },
      { id: 'chats', rows: filter(chatItems, text, mru).slice(0, mode === 'chats' ? 100 : LIMIT.chats) },
    ] as Section[]
  ).filter((x) => x.rows.length);
  // The section with the strongest match goes first, so Enter picks the best hit.
  const order: SectionId[] = ['actions', 'projects', 'chats'];
  sections.sort((a, b) => b.rows[0].score - a.rows[0].score || order.indexOf(a.id) - order.indexOf(b.id));

  if (mode === 'all' || mode === 'chats') {
    sections.push({
      id: 'search',
      rows: [
        {
          pos: [],
          score: 0,
          item: {
            id: 'search-text',
            section: 'search',
            label: t('palette.searchText', { text }),
            icon: <Search size={15} />,
            keys: ['Ctrl', 'Shift', 'F'],
            run: () => {
              useSearchStore.getState().setQ(text);
              openSearch();
            },
          },
        },
      ],
    });
  }
  return sections;
}

/* ---------- view ---------- */

const backdrop = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
const card = {
  initial: { opacity: 0, scale: 0.96, y: -8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, y: -4 },
  transition: spring,
};

function Highlight({ text, pos }: { text: string; pos: number[] }) {
  if (!pos.length) return <>{text}</>;
  const set = new Set(pos);
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const on = set.has(i);
    let j = i;
    while (j < text.length && set.has(j) === on) j++;
    const chunk = text.slice(i, j);
    parts.push(on ? <mark key={i}>{chunk}</mark> : <Fragment key={i}>{chunk}</Fragment>);
    i = j;
  }
  return <>{parts}</>;
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="palette-keys">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  );
}

const PAGE = 8;

function PaletteBody() {
  const q = usePaletteStore((s) => s.q);
  const setQ = usePaletteStore((s) => s.setQ);
  const threads = useStore((s) => s.threads);
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const activeId = useStore((s) => s.activeId);
  const panelTab = useStore((s) => s.panelTab);
  const split = useStore((s) => s.split);
  const worktrees = useStore((s) => s.worktrees);
  const [mru] = useState(readMru);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(
    () => compute(useStore.getState(), q, mru),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, mru, threads, sessions, settings, activeId, panelTab, split, worktrees],
  );
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const { mode } = parseQuery(q);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    if (sel >= flat.length) setSel(Math.max(0, flat.length - 1));
  }, [flat.length, sel]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (sel === 0) list.scrollTop = 0;
    else list.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, flat]);

  const choose = (row: Scored | undefined, side = false) => {
    if (!row) return;
    const { item } = row;
    closePalette();
    if (item.mru) pushMru(item.id);
    // Let the palette release focus first, so focus-taking targets (composer, editor) get it.
    requestAnimationFrame(() => (side && item.split ? item.split() : item.run()));
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = flat.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setSel((s) => (s + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setSel((s) => (s - 1 + n) % n);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      if (n) setSel((s) => Math.min(n - 1, s + PAGE));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      if (n) setSel((s) => Math.max(0, s - PAGE));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[sel], e.ctrlKey || e.metaKey);
    }
  };

  const selected = flat[sel]?.item;
  let idx = 0;

  return (
    <>
      <div className="palette-bar">
        <Command size={17} />
        {mode !== 'all' && <span className="palette-mode">{modeLabel(mode)}</span>}
        <input
          autoFocus
          className="palette-input"
          placeholder={t('palette.placeholder')}
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <kbd className="palette-esc">Esc</kbd>
      </div>
      <motion.div className="palette-list" ref={listRef} layoutScroll>
        {flat.length === 0 ? (
          <div className="palette-empty">
            <Search size={20} />
            <div>{t('palette.empty')}</div>
            <div className="muted small">
              <kbd>&gt;</kbd> {t('palette.hint.actions')} · <kbd>#</kbd> {t('palette.hint.projects')} · <kbd>@</kbd> {t('palette.hint.chats')}
            </div>
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.id} className="palette-section">
              <div className="palette-section-head">{sectionLabel(section.id)}</div>
              {section.rows.map((row) => {
                const i = idx++;
                const { item } = row;
                const on = i === sel;
                return (
                  <button
                    key={item.id}
                    data-idx={i}
                    className={`palette-item ${on ? 'is-sel' : ''}`}
                    onMouseMove={() => !on && setSel(i)}
                    onClick={(e) => choose(row, e.ctrlKey || e.metaKey)}
                  >
                    {on && <motion.span layoutId="palette-sel" className="palette-sel-bg" transition={spring} />}
                    <span className="palette-icon">{item.icon}</span>
                    <span className="palette-text">
                      <span className="palette-label truncate">
                        <Highlight text={item.label} pos={row.pos} />
                      </span>
                      {item.sub && <span className="palette-sub truncate">{item.sub}</span>}
                    </span>
                    {item.running && <span className="palette-running" title={t('palette.running')} />}
                    {item.current && <span className="palette-tag">{t('palette.current')}</span>}
                    {item.project && (
                      <span className="palette-proj truncate" title={item.project}>
                        {item.project}
                      </span>
                    )}
                    {item.time != null && <span className="palette-time">{relativeTime(item.time)}</span>}
                    {item.keys && <Keys keys={item.keys} />}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </motion.div>
      <div className="palette-foot muted small">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> {t('palette.foot.select')}
        </span>
        <span>
          <kbd>
            <CornerDownLeft size={10} />
          </kbd>{' '}
          {t(selected?.section === 'chats' ? 'palette.foot.open' : 'palette.foot.run')}
        </span>
        {selected?.split && (
          <span>
            <kbd>Ctrl</kbd>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{' '}
            {t('palette.foot.side')}
          </span>
        )}
        <span className="palette-foot-modes">
          <kbd>&gt;</kbd> {t('palette.hint.actions')} <kbd>#</kbd> {t('palette.hint.projects')} <kbd>@</kbd> {t('palette.hint.chats')}
        </span>
      </div>
    </>
  );
}

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' || (ctrl && !e.shiftKey && !e.altKey && e.code === 'KeyK')) {
        e.preventDefault();
        e.stopPropagation();
        closePalette();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop palette-backdrop" {...backdrop} onMouseDown={closePalette}>
          <motion.div className="modal palette-modal" {...card} onMouseDown={(e) => e.stopPropagation()}>
            <PaletteBody />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

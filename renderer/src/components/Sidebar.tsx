import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Archive,
  ArchiveRestore,
  Boxes,
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitFork,
  Moon,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  SquarePen,
  Sun,
  SunMoon,
  TextSearch,
  Trash2,
  X,
} from 'lucide-react';
import { create } from 'zustand';
import { openSearch } from '../features/search/SearchModal';
import { projectName, projectOf, useStore } from '../store';
import type { Project, SessionInfo, Thread } from '../types';
import { relativeTime, resetTime } from '../lib/format';
import { askConfirm } from '../lib/dialog';
import { t } from '../i18n';
import { FloatingMenu, MenuItem, anchorFrom, spring, type MenuAnchor } from './Popover';

// Chat titles are stored data written under whatever UI language was active, so they are matched
// against the strings of every locale, not just the current one.
const allLocales = (dicts: Record<string, Record<string, string>>, key: string) =>
  Object.values(dicts)
    .map((d) => d[key]?.trim())
    .filter((v): v is string => Boolean(v));
const sidebarDicts = import.meta.glob('../i18n/locales/*/sidebar.json', { eager: true, import: 'default' }) as Record<string, Record<string, string>>;
const commonDicts = import.meta.glob('../i18n/locales/*/common.json', { eager: true, import: 'default' }) as Record<string, Record<string, string>>;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches the " (fork N)" suffix of continued/forked sessions, in any UI language. */
export const FORK_SUFFIX = new RegExp(
  `\\s*\\((${['fork', ...allLocales(sidebarDicts, 'forkWord')].map(escapeRe).join('|')})(\\s*\\d+)?\\)\\s*$`,
  'i',
);
const GENERIC_TITLES = new Set([...allLocales(commonDicts, 'newChat'), ...allLocales(commonDicts, 'untitled')].map((s) => s.toLowerCase()));
const DRAG_TYPE = 'application/x-desk-chat';

/** Title without the " (fork N)" suffix Claude adds to continued sessions; '' when too generic to group. */
function baseTitle(title: string) {
  const s = title.replace(FORK_SUFFIX, '').trim().toLowerCase();
  return s.length >= 6 && !GENERIC_TITLES.has(s) ? s : '';
}

interface Row {
  key: string;
  title: string;
  ts: number;
  cwd: string;
  session?: SessionInfo;
  thread?: Thread;
  older?: Row[];
}

interface Group {
  key: string;
  project?: Project;
  cwd: string;
  rows: Row[];
  latest: number;
}

function UsageBar({ label, pct, resetsAt }: { label: string; pct: number; resetsAt?: string | number | null }) {
  const tone = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  return (
    <div className="usage" title={resetsAt ? t('sidebar.resets', { time: resetTime(resetsAt) }) : undefined}>
      <div className="usage-row">
        <span>{label}</span>
        <span className="muted">
          {Math.round(pct)}%{resetsAt ? ` · ${resetTime(resetsAt)}` : ''}
        </span>
      </div>
      <div className="usage-track">
        <motion.div className={`usage-fill ${tone}`} initial={false} animate={{ width: `${Math.min(100, pct)}%` }} transition={spring} />
      </div>
    </div>
  );
}

/** Collapses continuations of one long conversation ("… (fork 2)") into a single row with older parts. */
function chainRows(rows: Row[]) {
  rows.sort((a, b) => b.ts - a.ts);
  const heads = new Map<string, Row>();
  const out: Row[] = [];
  for (const r of rows) {
    const base = baseTitle(r.title);
    const head = base ? heads.get(base) : undefined;
    if (head) (head.older ??= []).push(r);
    else {
      const row = { ...r, older: undefined };
      if (base) heads.set(base, row);
      out.push(row);
    }
  }
  return out;
}

const rowKeys = (r: Row) => [r.key, ...(r.older ?? []).map((o) => o.key)];

/** Multi-select in the chat list (Shift+click): bulk move, pin, archive, delete. */
const useSelection = create<{ rows: Record<string, Row>; toggle(r: Row): void; clear(): void }>((set) => ({
  rows: {},
  toggle: (r) =>
    set((s) => {
      const rows = { ...s.rows };
      if (rows[r.key]) delete rows[r.key];
      else rows[r.key] = r;
      return { rows };
    }),
  clear: () => set({ rows: {} }),
}));

async function renameRow(row: Row, title: string) {
  const s = useStore.getState();
  for (const r of [row, ...(row.older ?? [])]) {
    // Keep "(fork N)" so the parts of a long conversation stay grouped.
    const next = title.trim() + (r.title.match(FORK_SUFFIX)?.[0] ?? '');
    const open = Object.values(s.threads).find((t) => t.id === r.key || (t.sessionId && t.sessionId === r.session?.sessionId));
    if (open) s.renameThread(open.id, next);
    else if (r.session) await window.desk.renameSession(r.session.sessionId, next, r.session.cwd).catch(() => {});
  }
  s.refreshSessions();
}

async function deleteRow(row: Row, confirmed = false) {
  const parts = [row, ...(row.older ?? [])];
  const ok =
    confirmed ||
    (await askConfirm({
      title: t('sidebar.deleteChatTitle'),
      message: parts.length > 1 ? t('sidebar.deleteChatPartsMessage', { n: parts.length }) : t('sidebar.deleteChatMessage'),
      confirmLabel: t('common.delete'),
      danger: true,
    }));
  if (!ok) return;
  const s = useStore.getState();
  for (const r of parts) {
    const open = Object.values(s.threads).find((t) => t.id === r.key || (t.sessionId && t.sessionId === r.session?.sessionId));
    if (open) s.deleteThread(open.id);
    else if (r.session) await window.desk.deleteSession(r.session.sessionId, r.session.cwd).catch(() => {});
  }
  s.archiveChats(rowKeys(row), false);
  s.refreshSessions();
}

function ChatMenu({ row, archived, onRename, onClose }: { row: Row; archived: boolean; onRename: () => void; onClose: () => void }) {
  const projects = useStore((s) => s.settings.projects);
  const settings = useStore((s) => s.settings);
  const current = projectOf(settings, row.key, row.cwd);
  const { moveChat, archiveChats, pinChats } = useStore.getState();
  const pinned = settings.pinned.includes(row.key);
  const [moving, setMoving] = useState(false);
  const move = (id: string | null) => {
    for (const k of rowKeys(row)) moveChat(k, id);
    onClose();
  };
  if (moving) {
    return (
      <>
        <div className="menu-title">{t('sidebar.moveToProject')}</div>
        <div className="menu-scroll">
          {projects.map((p) => (
            <MenuItem key={p.id} icon={<Boxes size={14} />} label={p.name} checked={current?.id === p.id} onClick={() => move(p.id)} />
          ))}
          {!projects.length && <div className="muted small menu-empty">{t('sidebar.noProjectsYet')}</div>}
        </div>
        <div className="menu-sep" />
        {current && <MenuItem icon={<X size={14} />} label={t('sidebar.removeFromProject')} onClick={() => move(null)} />}
        <MenuItem
          icon={<FolderPlus size={14} />}
          label={t('sidebar.newProject')}
          onClick={() => {
            onClose();
            useStore.setState({ projectModal: {} });
          }}
        />
      </>
    );
  }
  return (
    <>
      <MenuItem
        icon={<Pencil size={14} />}
        label={t('common.rename')}
        onClick={() => {
          onClose();
          onRename();
        }}
      />
      <MenuItem
        icon={pinned ? <PinOff size={14} /> : <Pin size={14} />}
        label={pinned ? t('sidebar.unpin') : t('sidebar.pin')}
        onClick={() => {
          pinChats([row.key], !pinned);
          onClose();
        }}
      />
      <MenuItem
        icon={<FolderInput size={14} />}
        label={t('sidebar.moveToProject')}
        right={<ChevronRight size={13} className="muted" />}
        onClick={() => setMoving(true)}
      />
      <MenuItem
        icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        label={archived ? t('sidebar.unarchive') : t('sidebar.archive')}
        onClick={() => {
          archiveChats(rowKeys(row), !archived);
          onClose();
        }}
      />
      <div className="menu-sep" />
      <MenuItem
        icon={<Trash2 size={14} />}
        label={t('common.delete')}
        tone="warn"
        onClick={() => {
          onClose();
          deleteRow(row);
        }}
      />
    </>
  );
}

function ChatRow({
  row,
  part,
  active,
  running,
  archived,
  chainOpen,
  onToggleChain,
}: {
  row: Row;
  part?: number;
  active: boolean;
  running: boolean;
  archived: boolean;
  chainOpen?: boolean;
  onToggleChain?: () => void;
}) {
  const worktrees = useStore((s) => s.worktrees);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState('');
  const closedAt = useRef(0);
  const closeMenu = useCallback(() => {
    closedAt.current = Date.now();
    setMenu(null);
  }, []);
  const shown = part ? t('sidebar.part', { n: part }) : baseTitle(row.title) ? row.title.replace(FORK_SUFFIX, '') : row.title;

  const selected = useSelection((x) => Boolean(x.rows[row.key]));
  const selecting = useSelection((x) => Object.keys(x.rows).length > 0);

  const open = (e: React.MouseEvent) => {
    if (!part && (e.shiftKey || selecting)) {
      useSelection.getState().toggle(row);
      return;
    }
    const { activate, openSession, openSplit } = useStore.getState();
    const go = () =>
      row.thread
        ? activate(row.thread.id)
        : row.session && openSession(row.session, part ? undefined : (row.older ?? []).map((o) => o.session!).filter(Boolean));
    if ((e.ctrlKey || e.metaKey) && !active) openSplit(go);
    else go();
  };

  const startRename = () => {
    setValue(row.title.replace(FORK_SUFFIX, ''));
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    if (value.trim() && value.trim() !== row.title.replace(FORK_SUFFIX, '')) renameRow(row, value);
  };

  return (
    <div className={`thread-row-wrap ${menu ? 'menu-open' : ''}`}>
      <div
        role="button"
        tabIndex={0}
        className={`side-item thread-row ${part ? 'chain-part' : ''} ${active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}
        draggable={!part && !renaming}
        onDragStart={(e) => {
          const sel = Object.values(useSelection.getState().rows);
          const rows = selected && sel.length ? sel : [row];
          e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(rows.flatMap(rowKeys)));
          e.dataTransfer.effectAllowed = 'move';
          document.body.classList.add('dragging-chat');
        }}
        onDragEnd={() => document.body.classList.remove('dragging-chat')}
        onClick={(e) => !renaming && open(e)}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === 'F2') startRename();
          else if (e.key === 'Enter') open(e as unknown as React.MouseEvent);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({
            left: e.clientX,
            right: e.clientX,
            top: e.clientY,
            bottom: e.clientY,
            align: 'left',
          });
        }}
        title={`${row.title}\n${t('sidebar.rowHint')}`}
      >
        {active && <motion.span layoutId="thread-active" className="active-bg" transition={spring} />}
        {(worktrees[row.cwd.toLowerCase()] || row.thread?.worktree) && <GitFork size={12} className="muted" style={{ flexShrink: 0 }} />}
        {renaming ? (
          <input
            className="row-rename"
            autoFocus
            value={value}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onFocus={(e) => e.target.select()}
          />
        ) : (
          <span className="truncate">{shown}</span>
        )}
        {!part && row.older?.length ? (
          <span
            role="button"
            className={`chain-badge ${chainOpen ? 'is-open' : ''}`}
            title={t('sidebar.chainHint')}
            onClick={(e) => {
              e.stopPropagation();
              onToggleChain?.();
            }}
          >
            ×{row.older.length + 1}
          </span>
        ) : null}
        {!renaming && (running ? <span className="dot-run" /> : <span className="row-time">{relativeTime(row.ts)}</span>)}
      </div>
      {!part && !renaming && (
        <button
          className="icon-btn sm row-menu-btn"
          title={t('sidebar.chatActions')}
          onClick={(e) => {
            // The outside-click handler already closed it on mousedown; don't reopen on the same click.
            if (Date.now() - closedAt.current > 250) setMenu(anchorFrom(e.currentTarget));
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
      <FloatingMenu anchor={menu} onClose={closeMenu} width={230}>
        <ChatMenu row={row} archived={archived} onRename={startRename} onClose={closeMenu} />
      </FloatingMenu>
    </div>
  );
}

function BulkBar() {
  const rows = useSelection((x) => x.rows);
  const list = Object.values(rows);
  const projects = useStore((s) => s.settings.projects);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => {
    if (!list.length) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useSelection.getState().clear();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list.length]);
  const keys = list.flatMap(rowKeys);
  const s = useStore.getState();
  const done = (text: string) => {
    useSelection.getState().clear();
    s.toast(text);
  };
  return (
    <AnimatePresence>
      {list.length > 0 && (
        <motion.div
          className="bulk-bar"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={spring}
        >
          <span className="bulk-count">{t('sidebar.selected', { n: list.length })}</span>
          <div className="spacer" />
          <button className="icon-btn sm" title={t('sidebar.moveToProject')} onClick={(e) => setMenu(anchorFrom(e.currentTarget))}>
            <FolderInput size={14} />
          </button>
          <button
            className="icon-btn sm"
            title={t('sidebar.pin')}
            onClick={() => {
              s.pinChats(
                list.map((r) => r.key),
                true,
              );
              done(t('sidebar.pinnedToast'));
            }}
          >
            <Pin size={14} />
          </button>
          <button
            className="icon-btn sm"
            title={t('sidebar.archive')}
            onClick={() => {
              s.archiveChats(keys, true);
              done(t('sidebar.archivedToast', { n: list.length }));
            }}
          >
            <Archive size={14} />
          </button>
          <button
            className="icon-btn sm"
            title={t('common.delete')}
            onClick={async () => {
              const ok = await askConfirm({
                title: t('sidebar.deleteChatsTitle', { count: list.length }),
                message: t('sidebar.deleteChatsMessage'),
                confirmLabel: t('common.delete'),
                danger: true,
              });
              if (!ok) return;
              for (const r of list) await deleteRow(r, true);
              done(t('sidebar.deletedToast', { n: list.length }));
            }}
          >
            <Trash2 size={14} />
          </button>
          <button className="icon-btn sm" title={t('sidebar.clearSelection')} onClick={() => useSelection.getState().clear()}>
            <X size={14} />
          </button>
          <FloatingMenu anchor={menu} onClose={closeMenu} width={230}>
            <div className="menu-title">{t('sidebar.moveToProject')}</div>
            {projects.map((p) => (
              <MenuItem
                key={p.id}
                icon={<Boxes size={14} />}
                label={p.name}
                onClick={() => {
                  for (const k of keys) s.moveChat(k, p.id);
                  closeMenu();
                  done(t('sidebar.movedTo', { name: p.name }));
                }}
              />
            ))}
            {!projects.length && <div className="muted small menu-empty">{t('sidebar.noProjectsYet')}</div>}
            <div className="menu-sep" />
            <MenuItem
              icon={<X size={14} />}
              label={t('sidebar.removeFromProjects')}
              onClick={() => {
                for (const k of keys) s.moveChat(k, null);
                closeMenu();
                done(t('sidebar.removedFromProjects'));
              }}
            />
          </FloatingMenu>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ProjectMenu({ group, onClose }: { group: Group; onClose: () => void }) {
  const s = useStore.getState();
  if (!group.project) {
    return (
      <>
        <MenuItem
          icon={<Plus size={14} />}
          label={t('common.newChat')}
          onClick={() => {
            onClose();
            s.newThread(group.cwd);
          }}
        />
        <MenuItem
          icon={<Boxes size={14} />}
          label={t('sidebar.makeProject')}
          hint={t('sidebar.makeProjectHint')}
          onClick={() => {
            onClose();
            const id = s.saveProject({
              name: projectName(group.cwd),
              folders: [group.cwd],
            });
            useStore.setState({ projectModal: { id } });
          }}
        />
        <MenuItem
          icon={<FolderOpen size={14} />}
          label={t('sidebar.openFolder')}
          onClick={() => {
            onClose();
            window.desk.openPath(group.cwd);
          }}
        />
      </>
    );
  }
  const p = group.project;
  return (
    <>
      <MenuItem
        icon={<Plus size={14} />}
        label={t('sidebar.newChatInProject')}
        onClick={() => {
          onClose();
          s.newThreadInProject(p.id);
        }}
      />
      <MenuItem
        icon={<Settings2 size={14} />}
        label={t('sidebar.nameAndFolders')}
        onClick={() => {
          onClose();
          useStore.setState({ projectModal: { id: p.id } });
        }}
      />
      <div className="menu-sep" />
      <MenuItem
        icon={<Trash2 size={14} />}
        label={t('sidebar.deleteProject')}
        tone="warn"
        onClick={() => {
          onClose();
          askConfirm({
            title: t('sidebar.deleteProjectTitle', { name: p.name }),
            message: t('sidebar.deleteProjectMessage'),
            confirmLabel: t('sidebar.deleteProject'),
            danger: true,
          }).then((ok) => ok && s.deleteProject(p.id));
        }}
      />
    </>
  );
}

function ProjectHeader({ group, collapsed, onToggle }: { group: Group; collapsed: boolean; onToggle: () => void }) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [drop, setDrop] = useState(false);
  const closedAt = useRef(0);
  const closeMenu = useCallback(() => {
    closedAt.current = Date.now();
    setMenu(null);
  }, []);
  const p = group.project;
  const Icon = p ? Boxes : collapsed ? Folder : FolderOpen;
  const title = p ? `${p.name}\n${p.folders.join('\n') || t('sidebar.noFolders')}` : group.cwd;
  return (
    <>
      <div
        className={`side-item project-row ${drop ? 'is-drop' : ''} ${p ? 'is-project' : ''} ${menu ? 'menu-open' : ''}`}
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({
            left: e.clientX,
            right: e.clientX,
            top: e.clientY,
            bottom: e.clientY,
            align: 'left',
          });
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDrop(true);
        }}
        onDragLeave={() => setDrop(false)}
        onDrop={(e) => {
          setDrop(false);
          document.body.classList.remove('dragging-chat');
          const raw = e.dataTransfer.getData(DRAG_TYPE);
          if (!raw) return;
          e.preventDefault();
          const keys: string[] = JSON.parse(raw);
          const { moveChat, toast } = useStore.getState();
          for (const k of keys) moveChat(k, p?.id ?? null);
          toast(p ? t('sidebar.chatMovedTo', { name: p.name }) : t('sidebar.chatRemovedFromProject'));
        }}
      >
        <Icon size={15} className={p ? 'project-icon' : undefined} />
        <span className="truncate" title={title}>
          {p ? p.name : projectName(group.cwd)}
        </span>
        {p && p.folders.length > 1 && <span className="muted small">· {t('sidebar.folderCount', { count: p.folders.length })}</span>}
        <div className="spacer" />
        <button
          className={`icon-btn sm hover-only ${menu ? 'is-on' : ''}`}
          title={t('sidebar.projectActions')}
          onClick={(e) => {
            e.stopPropagation();
            if (Date.now() - closedAt.current > 250) setMenu(anchorFrom(e.currentTarget));
          }}
        >
          <MoreHorizontal size={13} />
        </button>
        <button
          className="icon-btn sm hover-only"
          title={t('sidebar.newChatInProject')}
          onClick={(e) => {
            e.stopPropagation();
            const s = useStore.getState();
            if (p) s.newThreadInProject(p.id);
            else s.newThread(group.cwd);
          }}
        >
          <Plus size={13} />
        </button>
      </div>
      <FloatingMenu anchor={menu} onClose={closeMenu} width={240}>
        <ProjectMenu group={group} onClose={closeMenu} />
      </FloatingMenu>
    </>
  );
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const threads = useStore((s) => s.threads);
  const activeId = useStore((s) => s.activeId);
  const settings = useStore((s) => s.settings);
  const account = useStore((s) => s.account);
  const usage = useStore((s) => s.usage);
  const search = useStore((s) => s.search);
  const worktrees = useStore((s) => s.worktrees);
  const { setSearch, newThread, setSettings } = useStore.getState();
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [allProjects, setAllProjects] = useState(false);
  const [openChains, setOpenChains] = useState<Record<string, boolean>>({});
  const [archiveOpen, setArchiveOpen] = useState(false);
  const PROJECT_LIMIT = 10;

  const active = threads[activeId];

  const { groups, archivedRows, pinnedRows } = useMemo(() => {
    const byKey = new Map<string, Group>();
    const archivedSet = new Set(settings.archived);
    const pinnedSet = new Set(settings.pinned);
    const archived: Row[] = [];
    const pinned: Row[] = [];
    const q = search.trim().toLowerCase();
    for (const p of settings.projects)
      byKey.set('p:' + p.id, {
        key: 'p:' + p.id,
        project: p,
        cwd: p.folders[0] ?? '',
        rows: [],
        latest: p.createdAt,
      });
    const add = (row: Row, projectId?: string) => {
      if (archivedSet.has(row.key)) return archived.push(row);
      if (q && !row.title.toLowerCase().includes(q)) return;
      if (pinnedSet.has(row.key)) return pinned.push(row);
      const project = (projectId && settings.projects.find((p) => p.id === projectId)) || projectOf(settings, row.key, row.cwd);
      const k = project ? 'p:' + project.id : 'f:' + row.cwd.toLowerCase();
      let g = byKey.get(k);
      if (!g) byKey.set(k, (g = { key: k, cwd: row.cwd, rows: [], latest: 0 }));
      g.rows.push(row);
      g.latest = Math.max(g.latest, row.ts);
    };
    // Worktree chats are listed under the project they were branched from.
    const baseOf = (cwd: string) => worktrees[(cwd || '').toLowerCase()]?.base ?? cwd ?? '';
    const known = new Set(sessions.map((s) => s.sessionId));
    for (const t of Object.values(threads)) {
      if (t.entries.length && (!t.sessionId || !known.has(t.sessionId))) {
        add(
          {
            key: t.sessionId ?? t.id,
            title: t.title,
            ts: Date.now(),
            cwd: baseOf(t.cwd),
            thread: t,
          },
          t.projectId,
        );
      }
    }
    for (const s of sessions) {
      const open = Object.values(threads).find((t) => t.sessionId === s.sessionId);
      add(
        {
          key: s.sessionId,
          title: s.title,
          ts: s.lastModified,
          cwd: baseOf(s.cwd),
          session: s,
        },
        open?.projectId,
      );
    }
    const list = [...byKey.values()]
      .filter((g) => g.rows.length || (g.project && !q))
      .sort((a, b) => Number(Boolean(b.project)) - Number(Boolean(a.project)) || b.latest - a.latest);
    for (const g of list) g.rows = chainRows(g.rows);
    const order = (r: Row) => settings.pinned.indexOf(r.key);
    return { groups: list, archivedRows: chainRows(archived), pinnedRows: pinned.sort((a, b) => order(a) - order(b)) };
  }, [sessions, threads, search, worktrees, settings]);

  const runningIds = useMemo(
    () =>
      new Set(
        Object.values(threads)
          .filter((t) => t.status === 'running')
          .flatMap((t) => [t.id, t.sessionId ?? '']),
      ),
    [threads],
  );

  const isActive = (r: Row) =>
    r.thread
      ? r.thread.id === activeId
      : Boolean(active && (active.sessionId === r.session?.sessionId || active.id === r.session?.sessionId));

  const toggleGroup = (key: string) => {
    const cur = settings.collapsedProjects;
    setSettings({
      collapsedProjects: cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key],
    });
  };

  const renderRows = (rows: Row[], archived: boolean) =>
    rows.map((r) => (
      <div key={r.key}>
        <ChatRow
          row={r}
          active={isActive(r)}
          running={runningIds.has(r.key)}
          archived={archived}
          chainOpen={openChains[r.key]}
          onToggleChain={() => setOpenChains((x) => ({ ...x, [r.key]: !x[r.key] }))}
        />
        <AnimatePresence initial={false}>
          {r.older && openChains[r.key] && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              style={{ overflow: 'hidden' }}
            >
              {r.older.map((o, i) => (
                <ChatRow
                  key={o.key}
                  row={o}
                  part={r.older!.length - i}
                  active={isActive(o)}
                  running={runningIds.has(o.key)}
                  archived={archived}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    ));

  const ThemeIcon = settings.theme === 'dark' ? Moon : settings.theme === 'light' ? Sun : SunMoon;
  const nextTheme = settings.theme === 'system' ? 'dark' : settings.theme === 'dark' ? 'light' : 'system';
  const initials = (account.email ?? 'C').slice(0, 1).toUpperCase();
  const projectCount = groups.filter((g) => g.project).length;
  const visible = allProjects || search ? groups : groups.slice(0, Math.max(PROJECT_LIMIT, projectCount));

  return (
    <div className="sidebar-inner">
      <div className="side-head">
        <span className="brand">Claude</span>
        <div className="spacer" />
        <button className="icon-btn" title={t('sidebar.searchAllChats')} onClick={() => openSearch()}>
          <TextSearch size={15} />
        </button>
        <button className="icon-btn" title={t('sidebar.filterChats')} onClick={() => setSearchOpen((v) => !v)}>
          <Search size={15} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {searchOpen && (
          <motion.div
            className="side-search"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <div className="search-box">
              <Search size={13} className="muted" />
              <input autoFocus placeholder={t('sidebar.searchChats')} value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && (
                <button className="icon-btn sm" onClick={() => setSearch('')}>
                  <X size={12} />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button className="side-item new-chat" onClick={() => newThread()}>
        <SquarePen size={15} />
        <span>{t('common.newChat')}</span>
        <kbd className="muted">Ctrl N</kbd>
      </button>

      <div className="side-section side-section-row">
        <span>{t('sidebar.projects')}</span>
        <div className="spacer" />
        <button className="icon-btn sm" title={t('sidebar.createProject')} onClick={() => useStore.setState({ projectModal: {} })}>
          <FolderPlus size={13} />
        </button>
      </div>
      <div className="side-scroll">
        {pinnedRows.length > 0 && (
          <div className="project pinned-group">
            <div className="side-item project-row">
              <Pin size={14} />
              <span>{t('sidebar.pinnedSection')}</span>
            </div>
            {renderRows(pinnedRows, false)}
          </div>
        )}
        {visible.map((g) => {
          const collapsed = settings.collapsedProjects.includes(g.project ? g.key : g.cwd.toLowerCase()) && !search;
          const limit = expanded[g.key] || search ? g.rows.length : 6;
          return (
            <div className="project" key={g.key || 'none'}>
              <ProjectHeader group={g} collapsed={collapsed} onToggle={() => toggleGroup(g.project ? g.key : g.cwd.toLowerCase())} />
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.div
                    className="project-threads"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ height: spring, opacity: { duration: 0.15 } }}
                  >
                    {renderRows(g.rows.slice(0, limit), false)}
                    {g.project && g.rows.length === 0 && (
                      <button className="side-more" onClick={() => useStore.getState().newThreadInProject(g.project!.id)}>
                        {t('sidebar.emptyProject')}
                      </button>
                    )}
                    {g.rows.length > limit && (
                      <button className="side-more" onClick={() => setExpanded((x) => ({ ...x, [g.key]: true }))}>
                        {t('sidebar.showMore', { n: g.rows.length - limit })}
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
        {!search && groups.length > visible.length && (
          <button className="side-more projects-more" onClick={() => setAllProjects(true)}>
            {t('sidebar.allProjects', { n: groups.length })}
          </button>
        )}
        {!search && allProjects && groups.length > PROJECT_LIMIT && (
          <button className="side-more projects-more" onClick={() => setAllProjects(false)}>
            {t('sidebar.collapseProjects')}
          </button>
        )}
        {archivedRows.length > 0 && (
          <div className="project archive-group">
            <div className="side-item project-row" onClick={() => setArchiveOpen((v) => !v)}>
              <Archive size={15} />
              <span>{t('sidebar.archiveSection')}</span>
              <span className="muted small">{archivedRows.length}</span>
              <div className="spacer" />
              <ChevronRight size={13} className={`muted chevron ${archiveOpen ? 'is-open' : ''}`} />
            </div>
            <AnimatePresence initial={false}>
              {archiveOpen && (
                <motion.div
                  className="project-threads"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ height: spring, opacity: { duration: 0.15 } }}
                >
                  {renderRows(archivedRows, true)}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      <BulkBar />

      <div className="side-foot">
        {usage.session && <UsageBar label={t('sidebar.usageSession')} pct={usage.session.pct} resetsAt={usage.session.resetsAt} />}
        {usage.weekly && <UsageBar label={t('sidebar.usageWeek')} pct={usage.weekly.pct} resetsAt={usage.weekly.resetsAt} />}
        <div className="account">
          <span className="avatar">{initials}</span>
          <div className="account-text">
            <span className="truncate">{account.email ?? 'Claude Code'}</span>
            <span className="muted small">{account.subscriptionType ?? usage.plan ?? ''}</span>
          </div>
          <button className="icon-btn" title={t('sidebar.settings')} onClick={() => useStore.setState({ settingsOpen: true })}>
            <Settings2 size={15} />
          </button>
          <button className="icon-btn" title={t('sidebar.theme', { theme: t(`sidebar.theme_${settings.theme}`) })} onClick={() => setSettings({ theme: nextTheme })}>
            <ThemeIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function SidebarToggleIcon({ open }: { open: boolean }) {
  return (
    <motion.span animate={{ rotate: open ? 0 : 180 }} transition={spring} style={{ display: 'inline-flex' }}>
      <ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
    </motion.span>
  );
}

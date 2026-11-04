import { providerEntries } from '../lib/providers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import type { Project, ProviderId, SessionInfo, Thread, UsageSummary } from '../types';
import { relativeTime, resetTime } from '../lib/format';
import { askConfirm } from '../lib/dialog';
import { useNow } from '../lib/hooks';
import { t } from '../i18n';
import { FloatingMenu, MenuItem, anchorFrom, spring, type MenuAnchor } from './Popover';
import { AgentMark, AgentMarks } from './AgentMark';
import { chatRows, type ChatRow as Row } from '../lib/chat-sessions';

const DRAG_TYPE = 'application/x-desk-chat';

interface Group {
  key: string;
  project?: Project;
  cwd: string;
  rows: Row[];
  latest: number;
}

/** One row per agent: account plan, short/week limits; detailed breakdown on hover. */
function AgentsUsage({ active }: { active: ProviderId }) {
  const providers = useStore((s) => s.providers);
  const usageBy = useStore((s) => s.usageBy);
  const claudeUsage = useStore((s) => s.usage);
  const claudeAccount = useStore((s) => s.account);
  const [hover, setHover] = useState<{ id: ProviderId; rect: DOMRect } | null>(null);
  const ids = providerEntries(providers).map(([id]) => id).filter((id) => providers[id].available);
  // Re-check every half minute so a window whose reset time has passed stops showing its old value.
  const now = useNow(ids.length > 0, 30_000);
  const expired = ids.some((id) => {
    const u = usageBy[id];
    return [u?.session, u?.weekly].some((w) => w?.resetsAt && Number(w.resetsAt) <= now);
  });
  useEffect(() => {
    if (expired) useStore.getState().refreshUsage();
  }, [expired]);
  if (!ids.length) return null;
  const openAgents = () => {
    useStore.setState({ settingsOpen: true, settingsSection: 'claude' });
    useStore.getState().refreshUsage();
  };
  const hoveredUsage: UsageSummary | undefined = hover ? usageBy[hover.id] ?? (hover.id === 'claude' ? claudeUsage : {}) : undefined;
  const hoveredPlan = hover
    ? (hover.id === 'claude' ? claudeAccount.subscriptionType ?? hoveredUsage?.plan : providers[hover.id]?.account?.subscriptionType) ?? ''
    : '';
  const showTip = Boolean(hover && hoveredUsage && (hoveredUsage.groups?.length || hoveredUsage.session || hoveredUsage.weekly));

  return (
    <div className="agents-usage">
      {ids.map((id) => {
        const u: UsageSummary = usageBy[id] ?? (id === 'claude' ? claudeUsage : {});
        const plan = (id === 'claude' ? claudeAccount.subscriptionType ?? u.plan : providers[id].account?.subscriptionType) ?? '';
        return (
          <button
            key={id}
            className={`agent-usage ${id === active ? 'is-active' : ''}`}
            onClick={openAgents}
            onMouseEnter={(e) => setHover({ id, rect: e.currentTarget.getBoundingClientRect() })}
            onMouseLeave={() => setHover((h) => (h?.id === id ? null : h))}
          >
            <span className="agent-usage-head">
              <AgentMark provider={id} size={13} />
              <span className="agent-usage-name truncate">{providers[id].label}</span>
              {plan && plan.toLowerCase() !== providers[id].label.toLowerCase() && <span className="agent-usage-plan muted truncate" title={plan}>{plan}</span>}
            </span>
            <span className="agent-usage-bars">
              <MiniBar label={t('sidebar.usageSessionShort')} w={u.session} now={now} />
              <MiniBar label={t('sidebar.usageWeekShort')} w={u.weekly} now={now} />
            </span>
          </button>
        );
      })}
      {typeof document !== 'undefined' &&
        document.body &&
        createPortal(
          <AnimatePresence>
            {showTip && hover && hoveredUsage && (
              <motion.div
                key={hover.id}
                className="popover usage-tooltip"
                style={{
                  position: 'fixed',
                  left: Math.min(hover.rect.right + 10, window.innerWidth - 300),
                  bottom: Math.max(10, window.innerHeight - hover.rect.bottom),
                  width: 280,
                  pointerEvents: 'none',
                }}
                initial={{ opacity: 0, scale: 0.96, x: -4 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
                transition={spring}
              >
                <div className="usage-tip-head">
                  <AgentMark provider={hover.id} size={14} />
                  <span className="agent-usage-name">{providers[hover.id]?.label}</span>
                  {hoveredPlan && <span className="muted small truncate">{hoveredPlan}</span>}
                </div>
                {hoveredUsage.groups?.length ? (
                  <div className="usage-tip-groups">
                    {hoveredUsage.groups.map((g) => (
                      <div key={g.name} className="usage-tip-group">
                        <div className="usage-tip-group-title">{g.name}</div>
                        <div className="agent-usage-bars">
                          <MiniBar label={t('sidebar.usageSessionShort')} w={g.session} now={now} showReset />
                          <MiniBar label={t('sidebar.usageWeekShort')} w={g.weekly} now={now} showReset />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="usage-tip-groups">
                    <div className="usage-tip-group">
                      <div className="agent-usage-bars">
                        <MiniBar label={t('sidebar.usageSessionShort')} w={hoveredUsage.session} now={now} showReset />
                        <MiniBar label={t('sidebar.usageWeekShort')} w={hoveredUsage.weekly} now={now} showReset />
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}

function MiniBar({
  label,
  w: raw,
  now,
  showReset,
}: {
  label: string;
  w?: { label?: string; pct: number; resetsAt?: string | number | null };
  now: number;
  showReset?: boolean;
}) {
  if (!raw) {
    return showReset ? (
      <span className="mini-bar is-empty">
        <span className="mini-bar-row">
          <span>{label}</span>
          <span>—</span>
        </span>
      </span>
    ) : (
      <span className="mini-bar is-empty" />
    );
  }
  // Past its reset time the window starts over, even before fresh numbers arrive.
  const w = raw.resetsAt && Number(raw.resetsAt) <= now ? { pct: 0, resetsAt: null } : raw;
  const tone = w.pct >= 90 ? 'danger' : w.pct >= 70 ? 'warn' : '';
  return (
    <span className="mini-bar" title={!showReset && w.resetsAt ? t('sidebar.resets', { time: resetTime(w.resetsAt) }) : undefined}>
      <span className="mini-bar-row">
        <span>{raw?.label==='Month'?t('kimi.monthly'):raw?.label??label}</span>
        <span>{Math.round(w.pct)}%</span>
      </span>
      <span className="usage-track">
        <motion.span className={`usage-fill ${tone}`} initial={false} animate={{ width: `${Math.min(100, w.pct)}%` }} transition={spring} />
      </span>
      {showReset && w.resetsAt && <span className="mini-bar-reset muted">{t('sidebar.resets', { time: resetTime(w.resetsAt) })}</span>}
    </span>
  );
}

const rowProvider = (r: Row): ProviderId => r.thread?.provider ?? r.provider ?? r.session?.provider ?? 'claude';
/** Agents of a row and its older parts, newest first. */
const rowProviders = (r: Row) => [rowProvider(r)];

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
  if (row.thread) s.renameThread(row.thread.id, title.trim());
  for (const r of [row, ...(row.older ?? [])]) {
    if (r.session && r.session.sessionId !== row.thread?.sessionId) await window.desk.renameSession(r.session.sessionId, title.trim(), r.session.cwd, r.session.provider).catch(() => {});
  }
  s.refreshSessions();
}

async function deleteRow(row: Row, confirmed = false) {
  const parts = [row, ...(row.older ?? [])];
  const ok =
    confirmed ||
    (await askConfirm({
      title: t('sidebar.deleteChatTitle'),
      message: t('sidebar.deleteChatMessage'),
      confirmLabel: t('common.delete'),
      danger: true,
    }));
  if (!ok) return;
  const s = useStore.getState();
  if (row.thread) s.deleteThread(row.thread.id);
  for (const r of parts) {
    if (r.session && r.session.sessionId !== row.thread?.sessionId) await window.desk.deleteSession(r.session.sessionId, r.session.cwd, r.session.provider).catch(() => {});
  }
  s.archiveChats(rowKeys(row), false);
  s.refreshSessions();
}

function ChatMenu({ row, archived, onRename, onClose }: { row: Row; archived: boolean; onRename: () => void; onClose: () => void }) {
  const projects = useStore((s) => s.settings.projects);
  const settings = useStore((s) => s.settings);
  const current = projectOf(settings, row.key, row.cwd);
  const { moveChat, archiveChats, pinChats } = useStore.getState();
  const pinned = rowKeys(row).some((key) => settings.pinned.includes(key));
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
          pinChats(rowKeys(row), !pinned);
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
  active,
  running,
  archived,
}: {
  row: Row;
  active: boolean;
  running: boolean;
  archived: boolean;
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
  const shown = row.title;
  // With more than one agent, every chat shows whose it is.
  const multiAgent = useStore((s) => Object.keys(s.providers).length > 1);

  const selected = useSelection((x) => Boolean(x.rows[row.key]));
  const selecting = useSelection((x) => Object.keys(x.rows).length > 0);

  const open = (e: React.MouseEvent) => {
    if (e.shiftKey || selecting) {
      useSelection.getState().toggle(row);
      return;
    }
    const { activate, openSession, openSplit } = useStore.getState();
    const go = () =>
      row.thread
        ? activate(row.thread.id)
        : row.session && openSession(row.session, (row.older ?? []).map((o) => o.session!).filter(Boolean));
    if ((e.ctrlKey || e.metaKey) && !active) openSplit(go);
    else go();
  };

  const startRename = () => {
    setValue(row.title);
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    if (value.trim() && value.trim() !== row.title) renameRow(row, value);
  };

  return (
    <div className={`thread-row-wrap ${menu ? 'menu-open' : ''}`}>
      <div
        role="button"
        tabIndex={0}
        className={`side-item thread-row ${active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}
        draggable={!renaming}
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
        {multiAgent && <AgentMarks providers={rowProviders(row)} size={13} />}
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
        {!renaming && (running ? <span className="dot-run" /> : <span className="row-time">{relativeTime(row.ts)}</span>)}
      </div>
      {!renaming && (
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
  const search = useStore((s) => s.search);
  const worktrees = useStore((s) => s.worktrees);
  const { setSearch, newThread, setSettings } = useStore.getState();
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [allProjects, setAllProjects] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const PROJECT_LIMIT = 10;

  const active = threads[activeId];
  // The person behind the agents: the open chat's agent account first.
  const agent = active?.provider ?? settings.provider ?? 'claude';
  const providers = useStore((s) => s.providers);
  const claudeAccount = useStore((s) => s.account);
  const accountOf = (id: string) => (id === 'claude' ? claudeAccount : providers[id]?.account ?? {});
  const email = accountOf(agent).email ?? providerEntries(providers).map(([id]) => accountOf(id).email).find(Boolean);

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
      if (rowKeys(row).some((key) => archivedSet.has(key))) return archived.push(row);
      if (q && !row.title.toLowerCase().includes(q)) return;
      if (rowKeys(row).some((key) => pinnedSet.has(key))) return pinned.push(row);
      const project = (projectId && settings.projects.find((p) => p.id === projectId)) || projectOf(settings, row.key, row.cwd);
      const k = project ? 'p:' + project.id : 'f:' + row.cwd.toLowerCase();
      let g = byKey.get(k);
      if (!g) byKey.set(k, (g = { key: k, cwd: row.cwd, rows: [], latest: 0 }));
      g.rows.push(row);
      g.latest = Math.max(g.latest, row.ts);
    };
    // Worktree chats are listed under the project they were branched from.
    const baseOf = (cwd: string) => worktrees[(cwd || '').toLowerCase()]?.base ?? cwd ?? '';
    const subSessions = new Set(settings.subSessions ?? []);
    const rows = chatRows(sessions.filter((s) => !subSessions.has(s.sessionId)), threads, settings.links, settings.chatProviders);
    for (const row of rows) add({ ...row, cwd: baseOf(row.cwd) }, row.thread?.projectId);
    const list = [...byKey.values()]
      .filter((g) => g.rows.length || (g.project && !q))
      .sort((a, b) => Number(Boolean(b.project)) - Number(Boolean(a.project)) || b.latest - a.latest);
    const order = (r: Row) => settings.pinned.indexOf(r.key);
    return { groups: list, archivedRows: archived, pinnedRows: pinned.sort((a, b) => order(a) - order(b)) };
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
          running={r.thread?.status === 'running' || runningIds.has(r.key)}
          archived={archived}
        />
      </div>
    ));

  const ThemeIcon = settings.theme === 'dark' ? Moon : settings.theme === 'light' ? Sun : SunMoon;
  const nextTheme = settings.theme === 'system' ? 'dark' : settings.theme === 'dark' ? 'light' : 'system';
  const initials = (email ?? 'D').slice(0, 1).toUpperCase();
  const projectCount = groups.filter((g) => g.project).length;
  const visible = allProjects || search ? groups : groups.slice(0, Math.max(PROJECT_LIMIT, projectCount));

  return (
    <div className="sidebar-inner">
      <div className="side-head">
        <span className="brand">Duet</span>
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
        <AgentsUsage active={agent} />
        <div className="account">
          <span className="avatar">{initials}</span>
          <div className="account-text">
            <span className="truncate">{email ?? 'Duet'}</span>
            <span className="muted small truncate">
              {providerEntries(providers)
                .filter(([, p]) => p.available)
                .map(([, p]) => p.label)
                .join(' · ')}
            </span>
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

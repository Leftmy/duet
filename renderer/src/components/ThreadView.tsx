import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  RefreshCw,
  AppWindow,
  ArrowDown,
  ArrowUp,
  Bug,
  ChevronDown,
  Code2,
  Columns2,
  FileDiff,
  FolderOpen,
  GitBranch,
  FileCode2,
  GitFork,
  Globe,
  MoreHorizontal,
  PanelRightClose,
  Pencil,
  ScanSearch,
  Sparkles,
  SquareTerminal,
  TestTubes,
  Trash2,
} from 'lucide-react';
import type { Entry, ProviderId, Thread } from '../types';
import type { RevealRequest } from '../features/search/SearchModal';
import { projectName, projectOf, useStore } from '../store';
import { useStickToBottom } from '../lib/hooks';
import { Composer } from './Composer';
import { TurnView, UserBubble } from './TurnView';
import { ProjectPicker, WorkModePicker, WorktreeChip } from './Pickers';
import { MenuItem, Popover, spring } from './Popover';
import { ChangesPanel } from './ChangesPanel';
import { collectChanges } from '../lib/changes';
import { ChaptersMenu } from './SessionItems';
import { AgentMark } from './AgentMark';
import { askConfirm } from '../lib/dialog';
import { detachThread, isDetachedWindow } from '../features/detach/detach';
import { t } from '../i18n';
import { MarkdownContext } from './Markdown';
import { CodexControls } from './CodexControls';

const suggestions = () => [
  { icon: ScanSearch, text: t('thread.suggestArchitecture') },
  { icon: Bug, text: t('thread.suggestBug') },
  { icon: TestTubes, text: t('thread.suggestTests') },
];

let targetsCache: Promise<{ id: string; label: string }[]> | null = null;

function OpenIn({ cwd }: { cwd: string }) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    (targetsCache ??= window.desk.openTargets()).then(setTargets).catch(() => {});
  }, []);
  if (!targets.length) return null;
  const iconFor = (id: string) =>
    id === 'explorer' ? <FolderOpen size={15} /> : id === 'terminal' ? <SquareTerminal size={15} /> : <Code2 size={15} />;
  return (
    <Popover
      open={open}
      onClose={close}
      side="bottom"
      align="right"
      width={220}
      trigger={() => (
        <button className="pill" onClick={() => setOpen((v) => !v)}>
          <Code2 size={14} />
          <span>{t('common.open')}</span>
          <ChevronDown size={13} className="muted" />
        </button>
      )}
    >
      <div className="menu-title">{t('thread.openProjectIn')}</div>
      {targets.map((target) => (
        <MenuItem
          key={target.id}
          icon={iconFor(target.id)}
          label={target.label}
          onClick={() => {
            setOpen(false);
            window.desk.openIn(target.id, cwd);
          }}
        />
      ))}
    </Popover>
  );
}

function Header({ thread, changes, changesOpen, split }: { thread: Thread; changes: number; changesOpen: boolean; split: boolean }) {
  const canFork = useStore((s) => s.providers[thread.provider]?.caps?.fork !== false);
  const rename = useStore((s) => s.renameThread);
  const del = useStore((s) => s.deleteThread);
  const setSettings = useStore((s) => s.setSettings);
  const panelTab = useStore((s) => s.panelTab);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const openAgent = useStore((s) => s.openAgent);
  const runningAgents = Object.values(thread.agents).filter((a) => a.status === 'running').length;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(thread.title);
  const [menu, setMenu] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const started = thread.entries.length > 0;
  const projectLabel =
    useStore(
      (s) =>
        s.settings.projects.find((p) => p.id === thread.projectId)?.name ??
        projectOf(s.settings, thread.sessionId ?? thread.id, thread.worktree?.base ?? thread.cwd)?.name,
    ) ??
    projectName(thread.worktree?.base ?? thread.cwd);

  useEffect(() => {
    let alive = true;
    setBranch(null);
    if (thread.cwd) window.desk.gitBranch(thread.cwd).then((b) => alive && setBranch(b));
    return () => {
      alive = false;
    };
  }, [thread.cwd, thread.status]);

  useEffect(() => setValue(thread.title), [thread.title]);

  const commit = () => {
    setEditing(false);
    if (value.trim() && value !== thread.title) rename(thread.id, value);
  };

  return (
    <header className="thread-head">
      <FolderOpen size={15} className="muted" />
      {editing ? (
        <input
          className="title-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setValue(thread.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={started ? thread.title : 'new'}
            className="thread-title truncate"
            onDoubleClick={() => started && setEditing(true)}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            {started ? thread.title : t('common.newChat')}
          </motion.span>
        </AnimatePresence>
      )}
      {thread.cwd && started && <span className="muted truncate head-meta">{projectLabel}</span>}
      {branch && started && (
        <span className="muted head-meta">
          <GitBranch size={12} /> {branch}
        </span>
      )}
      {started && <WorktreeChip thread={thread} />}
      <div className="spacer" />
      {split && (
        <button className="icon-btn" title={t('thread.closeSplit')} onClick={() => useStore.getState().closeSplit()}>
          <PanelRightClose size={15} />
        </button>
      )}
      <ChaptersMenu thread={thread} />
      {thread.cwd && <OpenIn cwd={thread.cwd} />}
      {thread.provider==='codex'&&window.desk.nativeHistoryPaging===true&&<CodexControls thread={thread}/>}
      {(['files', 'terminal'] as const).map((k) => (
        <button
          key={k}
          className={`icon-btn ${changesOpen && panelTab === k ? 'is-on' : ''}`}
          title={k === 'files' ? t('thread.filesPanel') : t('thread.terminalPanel')}
          onClick={() => {
            if (changesOpen && panelTab === k) setSettings({ changesOpen: false });
            else {
              setPanelTab(k);
              setSettings({ changesOpen: true });
            }
          }}
        >
          {k === 'files' ? <FileCode2 size={15} /> : <SquareTerminal size={15} />}
        </button>
      ))}
      {!isDetachedWindow() && (
      <button
        className={`icon-btn ${changesOpen && panelTab === 'browser' ? 'is-on' : ''}`}
        title={t('thread.browserPanel')}
        onClick={() => (changesOpen && panelTab === 'browser' ? setSettings({ changesOpen: false }) : useStore.getState().openBrowser())}
      >
        <Globe size={15} />
      </button>
      )}
      {started && Object.keys(thread.agents).length > 0 && (
        <button
          className={`icon-btn badge-btn ${changesOpen && panelTab === 'agents' ? 'is-on' : ''}`}
          title={t('thread.agents')}
          onClick={() => (changesOpen && panelTab === 'agents' ? setSettings({ changesOpen: false }) : openAgent())}
        >
          <Sparkles size={15} />
          <AnimatePresence>
            {runningAgents > 0 && (
              <motion.span className="badge" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring}>
                {runningAgents}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      )}
      {started && (
        <button
          className={`icon-btn badge-btn ${changesOpen && panelTab !== 'agents' ? 'is-on' : ''}`}
          title={t('thread.fileChanges')}
          onClick={() => {
            if (changesOpen && panelTab !== 'agents') setSettings({ changesOpen: false });
            else {
              if (panelTab === 'agents') setPanelTab('chat');
              setSettings({ changesOpen: true });
            }
          }}
        >
          <FileDiff size={15} />
          <AnimatePresence>
            {changes > 0 && (
              <motion.span className="badge" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring}>
                {changes}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      )}
      {started && (
        <Popover
          open={menu}
          onClose={closeMenu}
          side="bottom"
          align="right"
          width={220}
          trigger={() => (
            <button className="icon-btn" onClick={() => setMenu((v) => !v)}>
              <MoreHorizontal size={16} />
            </button>
          )}
        >
          <MenuItem
            icon={<Pencil size={14} />}
            label={t('common.rename')}
            onClick={() => {
              setMenu(false);
              setEditing(true);
            }}
          />
          {thread.cwd && (
            <MenuItem
              icon={<FolderOpen size={14} />}
              label={t('thread.openProjectFolder')}
              onClick={() => {
                setMenu(false);
                window.desk.openPath(thread.cwd);
              }}
            />
          )}
          {!split && !isDetachedWindow() && (
            <MenuItem
              icon={<Columns2 size={14} />}
              label={t('thread.splitView')}
              hint={t('thread.splitViewHint')}
              onClick={() => {
                setMenu(false);
                useStore.getState().openSplit();
              }}
            />
          )}
          {!isDetachedWindow() && thread.sessionId && (
            <MenuItem
              icon={<AppWindow size={14} />}
              label={t('thread.openInWindow')}
              hint={t('thread.openInWindowHint')}
              onClick={() => {
                setMenu(false);
                detachThread(thread.id);
              }}
            />
          )}
          {thread.sessionId && (
            <MenuItem
              icon={<RefreshCw size={14} />}
              label={t('thread.syncChat')}
              hint={t('thread.syncChatHint')}
              onClick={() => {
                setMenu(false);
                useStore.getState().syncThread(thread.id, true);
              }}
            />
          )}
          {thread.sessionId && canFork && (
            <MenuItem
              icon={<GitFork size={14} />}
              label={t('thread.forkChat')}
              hint={t('thread.forkChatHint')}
              onClick={() => {
                setMenu(false);
                useStore.getState().forkFrom(thread.id);
              }}
            />
          )}
          <MenuItem
            icon={<Trash2 size={14} />}
            label={t('thread.deleteChat')}
            tone="warn"
            onClick={() => {
              setMenu(false);
              askConfirm({
                title: t('thread.deleteChatTitle'),
                message: t('thread.deleteChatMessage'),
                confirmLabel: t('common.delete'),
                danger: true,
              }).then((ok) => ok && del(thread.id));
            }}
          />
        </Popover>
      )}
    </header>
  );
}

function Hero({ thread }: { thread: Thread }) {
  const send = useStore((s) => s.send);
  return (
    <div className="hero">
      <motion.h1 className="hero-title" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
        {t('thread.heroTitle')}
      </motion.h1>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.05 }}>
        <div className="hero-pickers">
          <ProjectPicker thread={thread} big />
          <WorkModePicker thread={thread} />
        </div>
      </motion.div>
      <motion.div layoutId={`composer-${thread.id}`} layout="position" className="dock-inner" transition={spring}>
        <Composer thread={thread} hero />
      </motion.div>
      <div className="suggestions">
        {suggestions().map((s, i) => (
          <motion.button
            key={s.text}
            className="suggestion"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 + i * 0.05, duration: 0.3 }}
            disabled={!thread.cwd}
            onClick={() => send(thread.id, s.text, [])}
          >
            <s.icon size={15} />
            <span>{s.text}</span>
          </motion.button>
        ))}
      </div>
      {!thread.cwd && <div className="muted small">{t('thread.pickFolderHint')}</div>}
    </div>
  );
}

/** Loads earlier parts of a continued conversation above the current one, keeping the scroll position. */
function EarlierParts({ thread, scrollRef }: { thread: Thread; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const loadEarlierPart = useStore((s) => s.loadEarlierPart);
  const left = (thread.chain?.length ?? 0) - (thread.chainLoaded ?? 0);
  const load = async (all: boolean) => {
    const el = scrollRef.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    await loadEarlierPart(thread.id, all);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - fromBottom;
    });
  };
  return (
    <div className="earlier-parts">
      <button className="pill" disabled={thread.loading} onClick={() => load(false)}>
        <ArrowUp size={13} />
        {t('thread.showEarlierPart')}
        <span className="muted">· {t('thread.partsLeft', { n: left })}</span>
      </button>
      {left > 1 && window.desk.nativeHistoryPaging !== true && (
        <button className="pill sm" disabled={thread.loading} onClick={() => load(true)}>
          {t('thread.loadAll')}
        </button>
      )}
    </div>
  );
}

const revealLoads = new Map<string, number>();
const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

function entryText(e: Entry) {
  if (e.kind === 'user') return e.text;
  return e.items.map((x) => (x.kind === 'text' ? x.text : '')).join(' ');
}

/** Index of the entry holding a search hit: exact uuid first, then the longest piece of the snippet. */
function findEntry(entries: Entry[], uuid: string, text?: string) {
  const byUuid = entries.findIndex((x) => (x.kind === 'user' ? x.uuid === uuid : x.uuids?.includes(uuid) || x.lastUuid === uuid));
  if (byUuid >= 0 || !text) return byUuid;
  const pieces = norm(text)
    .split('…')
    .map((p) => p.trim())
    .filter((p) => p.length >= 12)
    .sort((a, b) => b.length - a.length);
  if (!pieces.length) return -1;
  const probe = pieces[0].slice(0, 60);
  for (let i = entries.length - 1; i >= 0; i--) if (norm(entryText(entries[i])).includes(probe)) return i;
  return -1;
}

/** Renders only the tail of long chats; older entries mount as the user scrolls up. */
const WINDOW = 40;
const STEP = 40;

function useEntryWindow(thread: Thread, scrollRef: React.RefObject<HTMLDivElement | null>, atBottom: boolean) {
  const [shown, setShown] = useState(WINDOW);
  const prev = useRef({ id: thread.id, len: thread.entries.length, first: thread.entries[0]?.id });
  const anchor = useRef<number | null>(null);
  const total = thread.entries.length;

  if (prev.current.id !== thread.id) {
    prev.current = { id: thread.id, len: total, first: thread.entries[0]?.id };
    if (shown !== WINDOW) setShown(WINDOW);
  } else if (prev.current.len !== total) {
    const delta = total - prev.current.len;
    const prepended = prev.current.len > 0 && prev.current.first !== thread.entries[0]?.id;
    prev.current = { id: thread.id, len: total, first: thread.entries[0]?.id };
    // Appended entries stay mounted; a prepended earlier part mounts gradually as you scroll up.
    // Keep a bounded tail during live work; retain the reader's anchor while scrolled up.
    if (delta > 0 && (prepended || !atBottom)) setShown((v) => v + (prepended ? Math.min(delta, STEP) : delta));
  }

  const hidden = Math.max(0, total - shown);
  const expand = useCallback(
    (to?: number) => {
      const el = scrollRef.current;
      if (el) anchor.current = el.scrollHeight - el.scrollTop;
      setShown((v) => Math.max(v + STEP, to ?? 0));
    },
    [scrollRef],
  );

  // Preserve the visual position when older entries mount above.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && anchor.current != null) el.scrollTop = el.scrollHeight - anchor.current;
    anchor.current = null;
  }, [shown, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || hidden === 0) return;
    let frame = 0;
    const upward = (event: WheelEvent) => {
      // Initial layout/content-visibility can emit scroll events while heights
      // settle. Only an upward user gesture should mount earlier history.
      if (event.deltaY < 0 && el.scrollTop < 900 && !frame) frame = requestAnimationFrame(() => { frame = 0; expand(); });
    };
    el.addEventListener('wheel', upward, { passive: true });
    return () => { el.removeEventListener('wheel', upward); cancelAnimationFrame(frame); };
  }, [hidden, expand, scrollRef]);

  // Search results: find the message (by uuid, else by snippet text), mount it and scroll to it.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const req = (e as CustomEvent<RevealRequest>).detail;
      if (req.handled || !thread.loaded || thread.loading) return;
      if (req.sessionId && thread.sessionId !== req.sessionId && !thread.chain?.some((p) => p.sessionId === req.sessionId)) return;
      const idx = findEntry(thread.entries, req.uuid, req.text);
      if (idx < 0) {
        // The hit may sit in an earlier part (before a context compaction): load parts one by one.
        if (thread.sessionId && !thread.chainExpanded) return;
        const loads = revealLoads.get(req.uuid) ?? 0;
        if (thread.chain && (thread.chainLoaded ?? 0) < thread.chain.length && loads < 12) {
          revealLoads.set(req.uuid, loads + 1);
          useStore.getState().loadEarlierPart(thread.id, false);
        } else {
          req.handled = true;
          useStore.getState().toast(t('thread.messageNotFound'), 'info');
        }
        return;
      }
      req.handled = true;
      if (idx < total - shown) expand(total - idx + 4);
      const id = thread.entries[idx].id;
      const tryScroll = (n: number) => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-entry="${id}"]`);
        if (!el) return n > 0 && setTimeout(() => tryScroll(n - 1), 80);
        // Instant scroll, then settle once offscreen entries (content-visibility) get real sizes.
        const go = () => {
          const tall = el.offsetHeight > (scrollRef.current?.clientHeight ?? 0) * 0.8;
          el.scrollIntoView({ block: tall ? 'start' : 'center' });
        };
        go();
        requestAnimationFrame(() => requestAnimationFrame(go));
        setTimeout(go, 250);
        el.classList.remove('search-flash');
        void el.offsetWidth;
        el.classList.add('search-flash');
        setTimeout(() => el.classList.remove('search-flash'), 1700);
      };
      setTimeout(() => tryScroll(30), 60);
    };
    window.addEventListener('desk:reveal', onReveal);
    return () => window.removeEventListener('desk:reveal', onReveal);
  }, [thread, total, shown, expand, scrollRef]);

  return { visible: hidden ? thread.entries.slice(hidden) : thread.entries, hidden, expand };
}

/** Agent of the closest turn before index i. */
function agentBefore(entries: Entry[], i: number): ProviderId | undefined {
  for (let k = i - 1; k >= 0; k--) {
    const e = entries[k];
    if (e.kind === 'turn') return e.provider;
  }
  return undefined;
}

/** Marks where another agent took over the chat. */
function AgentDivider({ provider }: { provider: ProviderId }) {
  const label = useStore((s) => s.providers[provider]?.label ?? provider);
  return (
    <div className="chapter agent-divider">
      <span className="chapter-line" />
      <AgentMark provider={provider} size={14} />
      <span className="chapter-title">{label}</span>
      <span className="chapter-line" />
    </div>
  );
}

export function ThreadView({ thread, focused = true, split = false }: { thread: Thread; focused?: boolean; split?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const changesOpen = useStore((s) => s.settings.changesOpen);
  const setSettings = useStore((s) => s.setSettings);
  const empty = thread.entries.length === 0 && !thread.loading;
  const { atBottom, scrollToBottom, pin } = useStickToBottom(scrollRef, [thread.id, thread.entries.length, empty]);
  const changes = useMemo(() => collectChanges(thread).length, [thread.entries]);
  const panelTab = useStore((s) => s.panelTab);
  const panelOpen = focused && changesOpen && (!empty || panelTab === 'browser' || panelTab === 'files' || panelTab === 'terminal');
  const panelWidth = panelTab === 'files' ? 760 : panelTab === 'browser' ? 680 : panelTab === 'terminal' ? 640 : panelTab === 'agents' ? 560 : 460;

  useEffect(() => {
    pin();
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, thread.loaded]);

  const lastTurnId = thread.entries.findLast((e) => e.kind === 'turn')?.id;
  const { visible, hidden, expand } = useEntryWindow(thread, scrollRef, atBottom);

  return (
    <MarkdownContext.Provider value={thread.cwd}><div className="thread">
      <Header thread={thread} changes={changes} changesOpen={changesOpen && focused} split={split} />
      <div className="thread-body">
        <div className="thread-main">
          {empty ? (
            <Hero thread={thread} />
          ) : (
            <>
              <div className="scroll" ref={scrollRef}>
                <div className="column">
                  {hidden > 0 && <button className="side-more window-gap" onClick={() => expand()}>{t('thread.showEarlier', { count: hidden })}</button>}
                  {hidden === 0 && thread.chain && (thread.chainLoaded ?? 0) < thread.chain.length && (
                    <EarlierParts thread={thread} scrollRef={scrollRef} />
                  )}
                  {thread.loading && (
                    <div className="skeleton">
                      {[80, 55, 92, 40].map((w, i) => (
                        <div key={i} className="skeleton-line shimmer-bg" style={{ width: `${w}%` }} />
                      ))}
                    </div>
                  )}
                  {visible.map((e, i) => {
                    if (e.kind === 'user') return <UserBubble key={e.id} entry={e} threadId={thread.id} />;
                    const prev = agentBefore(visible, i);
                    return (
                      <Fragment key={e.id}>
                        {prev && e.provider && prev !== e.provider && <AgentDivider provider={e.provider} />}
                        <TurnView turn={e} threadId={thread.id} cwd={thread.cwd} activity={e.id === lastTurnId ? thread.activity : undefined} />
                      </Fragment>
                    );
                  })}
                  <div className="column-end" />
                </div>
              </div>
              <div className="dock">
                <AnimatePresence>
                  {!atBottom && (
                    <motion.button
                      className="to-bottom"
                      onClick={scrollToBottom}
                      initial={{ opacity: 0, y: 8, scale: 0.9 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.9 }}
                      transition={spring}
                    >
                      <ArrowDown size={15} />
                    </motion.button>
                  )}
                </AnimatePresence>
                <motion.div layoutId={`composer-${thread.id}`} layout="position" className="dock-inner" transition={spring}>
                  <Composer thread={thread} />
                </motion.div>
              </div>
            </>
          )}
        </div>
        <motion.aside className="changes" initial={false} animate={{ width: panelOpen ? panelWidth : 0 }} transition={spring}>
          {panelOpen && (
            <div className="changes-inner" style={{ width: panelWidth }}>
              <ChangesPanel thread={thread} onClose={() => setSettings({ changesOpen: false })} />
            </div>
          )}
        </motion.aside>
      </div>
    </div></MarkdownContext.Provider>
  );
}

import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { OctagonX, PanelLeft, RefreshCw, X } from 'lucide-react';
import { useStore } from './store';
import type { ProviderId } from './types';
import { t, useLang } from './i18n';
import { Sidebar } from './components/Sidebar';
import { ResizeHandle } from './components/ResizeHandle';
import { ThreadView } from './components/ThreadView';
import { spring } from './components/Popover';
import { ConfirmDialog, RewindDialog } from './components/Dialogs';
import { SearchModal, openSearch } from './features/search/SearchModal';
import { ProjectModal } from './components/ProjectModal';
import { CommandPalette, togglePalette } from './features/palette/CommandPalette';
import { onCommandsChanged, reprobeCommands } from './features/commands/events';

const SettingsModal = lazy(() => import('./components/Settings').then((m) => ({ default: m.SettingsModal })));

function useTheme() {
  const pref = useStore((s) => s.settings.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
      document.documentElement.dataset.theme = resolved;
      useStore.setState({ resolvedTheme: resolved });
      window.desk.setTheme(resolved);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);
}

function SplitPane({ id, focused, paneRef }: { id: string; focused: boolean; paneRef?: RefObject<HTMLDivElement | null> }) {
  const thread = useStore((s) => s.threads[id]);
  if (!thread) return null;
  return (
    <motion.div
      ref={paneRef}
      className={`split-pane ${focused ? 'is-focused' : ''}`}
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring}
      onPointerDownCapture={() => !focused && useStore.getState().activate(id)}
      onFocusCapture={() => !focused && useStore.getState().activate(id)}
    >
      <ThreadView thread={thread} focused={focused} split />
    </motion.div>
  );
}

function SplitLayout({ ids, activeId }: { ids: string[]; activeId: string }) {
  const first = useRef<HTMLDivElement>(null);
  return <div className="split">
    <SplitPane id={ids[0]} focused={ids[0] === activeId} paneRef={first}/>
    <ResizeHandle id="split" label={t('layout.split')} target={first} variable="--split-size" defaultSize={50} percent
      bounds={width => { const min=Math.min(280,width*.35)/width*100; return [min,100-min]; }}/>
    <SplitPane id={ids[1]} focused={ids[1] === activeId}/>
  </div>;
}

/** The `/` menu: built-in + user commands from the cached probe and active project. */
function useProjectCommands() {
  const cwd = useStore((s) => s.threads[s.activeId]?.cwd ?? '');
  useEffect(() => onCommandsChanged((e) => reprobeCommands(e.cwd ?? cwd)), [cwd]);
  useEffect(() => {
    let alive = true;
    Promise.all([
      window.desk.probe(false).catch(() => null),
      cwd ? window.desk.call<{ scope: string; name: string; description: string; argumentHint: string }[]>('cmd:list', cwd).catch(() => []) : [],
    ]).then(([probe, local]) => {
      if (!alive || !probe?.commands) return;
      const seen = new Set(probe.commands.map((c: { name: string }) => c.name));
      const extra = local
        .filter((c) => c.scope === 'project' && !seen.has(c.name))
        .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint || undefined }));
      useStore.setState({ commands: [...probe.commands, ...extra] });
    });
    return () => {
      alive = false;
    };
  }, [cwd]);
}

export function App() {
  const sidebarRef = useRef<HTMLElement>(null);
  const activeId = useStore((s) => s.activeId);
  const thread = useStore((s) => s.threads[s.activeId]);
  const sidebarOpen = useStore((s) => s.settings.sidebarOpen);
  const toasts = useStore((s) => s.toasts);
  const probeError = useStore((s) => s.probeError);
  const zoomImage = useStore((s) => s.zoomImage);
  const updateAvailable = useStore((s) => s.updateAvailable);
  const split = useStore((s) => s.split);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => { if (settingsOpen) setSettingsLoaded(true); }, [settingsOpen]);
  const lang = useLang((s) => s.lang);
  useTheme();
  useProjectCommands();

  useEffect(() => {
    useStore.getState().init();
    window.desk.onUpdateAvailable(() => useStore.setState({ updateAvailable: true }));
    // Scheduled runs save new chats; refresh the sidebar when one finishes.
    let runs = -1;
    const offSched = window.desk.subscribe<{ tasks: { history?: unknown[] }[] }>('sched:update', (p) => {
      const n = p.tasks.reduce((sum, task) => sum + (task.history?.length ?? 0), 0);
      if (runs >= 0 && n !== runs) useStore.getState().refreshSessions();
      runs = n;
    });
    // Chats run from Telegram are saved as sessions; show them in the sidebar.
    const offTg = window.desk.subscribe('tg:session', () => useStore.getState().refreshSessions());
    window.desk.buildInfo().then((b) => b.newer && useStore.setState({ updateAvailable: true })).catch(() => {});
    // Plan limits drift while you work elsewhere (CLI, other devices); refresh them now and then.
    const timer = setInterval(() => {
      if (!document.hidden) useStore.getState().refreshUsage();
    }, 10 * 60 * 1000);
    return () => {
      clearInterval(timer);
      offSched();
      offTg();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && useStore.getState().zoomImage) {
        useStore.setState({ zoomImage: null });
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
        e.preventDefault();
        togglePalette();
      } else if (ctrl && e.shiftKey && e.code === 'KeyF') {
        e.preventDefault();
        openSearch();
      } else if (ctrl && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        useStore.getState().newThread();
      } else if (ctrl && (e.key === '`' || e.code === 'Backquote' || e.key.toLowerCase() === 'e')) {
        e.preventDefault();
        const s = useStore.getState();
        const tab = e.code === 'Backquote' || e.key === '`' ? 'terminal' : 'files';
        if (s.settings.changesOpen && s.panelTab === tab) s.setSettings({ changesOpen: false });
        else {
          s.setPanelTab(tab);
          s.setSettings({ changesOpen: true });
        }
      } else if (ctrl && !e.shiftKey && e.code === 'Period') {
        // Quick swap: move the open chat to the next available agent, conversation included.
        e.preventDefault();
        const s = useStore.getState();
        const t = s.threads[s.activeId];
        const ids = Object.entries(s.providers)
          .filter(([, p]) => p.available)
          .map(([id]) => id as ProviderId);
        if (t && ids.length > 1) s.switchProvider(t.id, ids[(ids.indexOf(t.provider) + 1) % ids.length]);
      } else if (ctrl && e.key === ',') {
        e.preventDefault();
        useStore.setState({ settingsOpen: true });
      } else if (ctrl && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const s = useStore.getState();
        s.setSettings({ sidebarOpen: !s.settings.sidebarOpen });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    // Keyed by language so every component re-renders its strings when it changes (store state is kept).
    <div className="app" key={lang}>
      <div className="titlebar">
        <button
          className="icon-btn no-drag"
          title={t('app.toggleSidebar')}
          onClick={() => useStore.getState().setSettings({ sidebarOpen: !sidebarOpen })}
        >
          <PanelLeft size={15} />
        </button>
        <span className="titlebar-name">Duet</span>
      </div>
      <div className="body">
        <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? '' : 'is-collapsed'}`}>
          <Sidebar />
        </aside>
        {sidebarOpen && <ResizeHandle id="sidebar" label={t('layout.sidebar')} target={sidebarRef} variable="--sidebar-size" defaultSize={264}
          bounds={width => [Math.min(180,width*.4),Math.max(Math.min(180,width*.4),Math.min(600,width-320))]}/>}
        <main className="main">
          {split ? (
            <SplitLayout ids={split} activeId={activeId}/>
          ) : (
            thread && (
              <motion.div
                key={activeId}
                className="main-fade"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <ThreadView thread={thread} />
              </motion.div>
            )
          )}
        </main>
      </div>

      {probeError && (
        <div className="banner">
          <OctagonX size={14} />
          {t('app.probeError', { error: probeError })}
        </div>
      )}

      <AnimatePresence>
        {updateAvailable && (
          <motion.div className="update-banner" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={spring}>
            <RefreshCw size={13} />
            <span>{t('app.updateReady')}</span>
            <button className="btn primary" onClick={() => window.desk.relaunch()}>
              {t('app.relaunch')}
            </button>
            <button className="icon-btn sm" onClick={() => useStore.setState({ updateAvailable: false })}>
              <X size={12} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {settingsLoaded && <Suspense fallback={null}><SettingsModal /></Suspense>}
      <ConfirmDialog />
      <RewindDialog />
      <SearchModal />
      <ProjectModal />
      <CommandPalette />

      <AnimatePresence>
        {zoomImage && (
          <motion.div
            className="lightbox"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => useStore.setState({ zoomImage: null })}
          >
            <motion.img src={zoomImage} alt="" initial={{ scale: 0.94 }} animate={{ scale: 1 }} exit={{ scale: 0.96 }} transition={spring} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="toasts">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              className={`toast ${toast.tone}`}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={spring}
            >
              {toast.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

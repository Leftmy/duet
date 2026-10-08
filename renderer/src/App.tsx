import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { OctagonX, PanelLeft, RefreshCw, X } from 'lucide-react';
import { useStore } from './store';
import { t, useLang } from './i18n';
import { Sidebar } from './components/Sidebar';
import { ThreadView } from './components/ThreadView';
import { spring } from './components/Popover';
import { SettingsModal } from './components/Settings';
import { ConfirmDialog, RewindDialog } from './components/Dialogs';
import { SearchModal, openSearch } from './features/search/SearchModal';
import { ProjectModal } from './components/ProjectModal';
import { CommandPalette, togglePalette } from './features/palette/CommandPalette';
import { onCommandsChanged, reprobeCommands } from './features/commands/events';

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

function SplitPane({ id, focused }: { id: string; focused: boolean }) {
  const thread = useStore((s) => s.threads[id]);
  if (!thread) return null;
  return (
    <motion.div
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

/** The `/` menu: built-in + user commands from the (cached) probe, plus project commands of the active chat's folder. */
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
  const activeId = useStore((s) => s.activeId);
  const thread = useStore((s) => s.threads[s.activeId]);
  const sidebarOpen = useStore((s) => s.settings.sidebarOpen);
  const toasts = useStore((s) => s.toasts);
  const probeError = useStore((s) => s.probeError);
  const zoomImage = useStore((s) => s.zoomImage);
  const updateAvailable = useStore((s) => s.updateAvailable);
  const split = useStore((s) => s.split);
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
        <motion.aside className="sidebar" initial={false} animate={{ width: sidebarOpen ? 264 : 0 }} transition={spring}>
          <Sidebar />
        </motion.aside>
        <main className="main">
          {split ? (
            <div className="split">
              {split.map((id) => (
                <SplitPane key={id} id={id} focused={id === activeId} />
              ))}
            </div>
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

      <SettingsModal />
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

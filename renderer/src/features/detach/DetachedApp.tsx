import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { LoaderCircle, OctagonX, Undo2 } from 'lucide-react';
import { useStore } from '../../store';
import { ThreadView } from '../../components/ThreadView';
import { spring } from '../../components/Popover';
import { ConfirmDialog, RewindDialog } from '../../components/Dialogs';
import { askConfirm } from '../../lib/dialog';
import type { Effort, PermMode, Thread } from '../../types';
import { detachedKey, ipcMessage, type DetachInfo } from './mode';
import { detachBlocker } from './detach';
import './detach.css';
import { t, useLang } from '../../i18n';

export { isDetachedWindow } from './mode';

/** Same as App's useTheme, but colors this window's title bar instead of the main window's. */
function useTheme() {
  const pref = useStore((s) => s.settings.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
      document.documentElement.dataset.theme = resolved;
      useStore.setState({ resolvedTheme: resolved });
      window.desk.call('win:setTheme', resolved).catch(() => {});
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);
}

const waitFor = (ok: () => boolean, ms: number) =>
  new Promise<void>((resolve) => {
    if (ok()) return resolve();
    const timer = setTimeout(done, ms);
    const off = useStore.subscribe(() => ok() && done());
    function done() {
      clearTimeout(timer);
      off();
      resolve();
    }
  });

const busy = (t: Thread | undefined) => Boolean(t && detachBlocker(t) && t.sessionId);

let booted: Promise<string> | null = null;

/** Runs the normal store init once, opens the chat and keeps this window to that single chat. */
function boot(): Promise<string> {
  booted ??= (async () => {
    const info = await window.desk.call<DetachInfo>('win:info');
    document.title = info.title;
    const store = useStore.getState();
    await store.init();
    // Worktree info comes with the session list; openSession needs it to restore worktree chats.
    await waitFor(() => useStore.getState().sessionsLoaded, 8000);

    let id: string;
    if (info.sessionId) {
      useStore.getState().openSession({ sessionId: info.sessionId, title: info.title, cwd: info.cwd, lastModified: Date.now() }, info.chain);
      id = useStore.getState().activeId;
    } else {
      id = useStore.getState().newThread(info.cwd);
    }
    // Carry the chat's own settings over from the main window and drop init()'s blank chat.
    useStore.setState((s) => {
      const t = s.threads[id];
      if (!t) return s;
      const next: Thread = {
        ...t,
        ...(info.model ? { model: info.model } : {}),
        ...(info.effort ? { effort: info.effort as Effort } : {}),
        ...(info.permissionMode ? { permissionMode: info.permissionMode as PermMode } : {}),
        ...(info.projectId ? { projectId: info.projectId } : {}),
        ...(info.draft && !t.draft ? { draft: info.draft } : {}),
      };
      return { threads: { [id]: next }, activeId: id, panelTab: s.panelTab === 'browser' ? 'chat' : s.panelTab };
    });

    await waitFor(() => Boolean(useStore.getState().threads[id]?.loaded), 30000);
    await window.desk.call('win:ready', { threadId: id });
    return id;
  })();
  return booted;
}

/** Keeps the window on its one chat: other chats that show up here (forks, …) go to the main window. */
function useOwnership(id: string | null) {
  useEffect(() => {
    if (!id) return;
    let handing = false;
    const check = () => {
      const s = useStore.getState();
      if (!s.threads[id]) {
        // The chat was deleted here: nothing left to show.
        window.desk.call('win:close').catch(() => window.close());
        return;
      }
      if (s.panelTab === 'browser') useStore.setState({ panelTab: 'chat' });
      const strays = Object.values(s.threads).filter((t) => t.id !== id);
      if (s.activeId === id && !strays.length) return;
      if (handing) return;
      handing = true;
      queueMicrotask(() => {
        handing = false;
        const cur = useStore.getState();
        const others = Object.values(cur.threads).filter((t) => t.id !== id);
        for (const t of others) {
          if (t.sessionId) window.desk.call('win:handoff', { sessionId: t.sessionId, title: t.title, cwd: t.cwd }).catch(() => {});
          window.desk.closeThread(t.id).catch(() => {});
        }
        const threads = cur.threads[id] ? { [id]: cur.threads[id] } : cur.threads;
        useStore.setState({ threads, activeId: id, split: null });
      });
    };
    check();
    return useStore.subscribe(check);
  }, [id]);
}

/** Keeps the window title in sync and asks before closing a chat that is still working. */
function useWindowChrome(thread: Thread | undefined) {
  const title = thread?.title;
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  useEffect(() => {
    let asking = false;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const cur = useStore.getState().threads[useStore.getState().activeId];
      if (!busy(cur)) return;
      e.preventDefault();
      e.returnValue = '';
      if (asking) return;
      asking = true;
      askConfirm({
        title: t('detach.closeTitle'),
        message: t('detach.closeMessage'),
        confirmLabel: t('common.close'),
        danger: true,
      }).then((ok) => {
        asking = false;
        if (ok) window.desk.call('win:close').catch(() => {});
      });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Settings (theme, projects, …) change in the main window too: pick them up when this one gets focus.
  useEffect(() => {
    const onFocus = () =>
      window.desk
        .getSettings()
        .then((ui) => useStore.setState((s) => ({ settings: { ...s.settings, ...ui } })))
        .catch(() => {});
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const s = useStore.getState();
      if (e.key === 'Escape' && s.zoomImage) {
        useStore.setState({ zoomImage: null });
        return;
      }
      if (ctrl && (e.key === '`' || e.code === 'Backquote' || e.key.toLowerCase() === 'e')) {
        e.preventDefault();
        const tab = e.code === 'Backquote' || e.key === '`' ? 'terminal' : 'files';
        if (s.settings.changesOpen && s.panelTab === tab) s.setSettings({ changesOpen: false });
        else {
          s.setPanelTab(tab);
          s.setSettings({ changesOpen: true });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

async function returnToMain(thread: Thread | undefined) {
  const blocker = thread ? detachBlocker(thread, 'return') : null;
  if (thread && blocker && thread.sessionId) {
    useStore.getState().toast(blocker, 'error');
    return;
  }
  try {
    await window.desk.call('win:reattach');
  } catch (e) {
    useStore.getState().toast(ipcMessage(e), 'error');
  }
}

/** Root of a detached chat window (location.hash = #detached=<sessionId or threadId>). */
export function DetachedApp() {
  const lang = useLang((s) => s.lang);
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const thread = useStore((s) => (id ? s.threads[id] : undefined));
  const toasts = useStore((s) => s.toasts);
  const probeError = useStore((s) => s.probeError);
  const zoomImage = useStore((s) => s.zoomImage);
  useTheme();
  useOwnership(id);
  useWindowChrome(thread);
  useShortcuts();

  useEffect(() => {
    if (!detachedKey) return setError(t('detach.noChat'));
    boot()
      .then(setId)
      .catch((e) => setError(ipcMessage(e)));
  }, []);

  return (
    <div className="app detached-app" key={lang}>
      <div className="titlebar">
        <span className="titlebar-name truncate">{thread?.title ?? 'Duet'}</span>
        <div className="spacer" />
        {thread && (
          <button className="icon-btn no-drag" title={t('detach.returnToMain')} onClick={() => returnToMain(thread)}>
            <Undo2 size={15} />
          </button>
        )}
      </div>
      <div className="body">
        <main className="main">
          {thread ? (
            <div className="main-fade">
              <ThreadView thread={thread} />
            </div>
          ) : (
            <div className="detached-wait muted">
              {error ? (
                <>
                  <OctagonX size={16} /> {error}
                </>
              ) : (
                <>
                  <LoaderCircle size={16} className="spin" /> {t('detach.opening')}
                </>
              )}
            </div>
          )}
        </main>
      </div>

      {probeError && (
        <div className="banner">
          <OctagonX size={14} />
          {t('detach.probeError', { error: probeError })}
        </div>
      )}

      <ConfirmDialog />
      <RewindDialog />

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
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              className={`toast ${t.tone}`}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={spring}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

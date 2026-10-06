// Detached chat windows: one chat per extra BrowserWindow. A chat lives in exactly one window —
// the main window drops it once the detached window reports ready (win:detached) and may show it
// again in the sidebar after that window closes (win:reattached).
import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../i18n.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same colors as THEMES in main.mjs (title bar overlay + window background).
const THEMES = {
  dark: { bg: '#181818', symbol: '#cfcfcf' },
  light: { bg: '#ffffff', symbol: '#3a3a3a' },
};
const SIZE = { width: 900, height: 800 };
const MIN = { width: 560, height: 480 };
const CASCADE = 32;
const MAX_SAVED = 200;

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');

export function register(ctx) {
  const { handle, emit, bridge, getWindow, userData, trustWindow, preloadPath, devUrl, indexFile } = ctx;
  const boundsFile = path.join(userData, 'detached.json');
  const settingsFile = path.join(userData, 'settings.json');
  const icon = path.join(__dirname, '..', '..', 'build', 'icon.png');

  /** key (session id, else thread id) → record */
  const windows = new Map();
  /** webContents id → record (for sender-aware channels) */
  const bySender = new Map();
  const hookedMains = new WeakSet();

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };

  const resolvedTheme = () => THEMES[readJson(settingsFile).resolvedTheme] ?? THEMES.dark;

  function saveBounds(rec) {
    const w = rec.win;
    if (!w || w.isDestroyed()) return;
    try {
      const all = readJson(boundsFile);
      const prev = all[rec.key] ?? {};
      const maximized = w.isMaximized();
      const bounds = !maximized && !w.isMinimized() ? w.getBounds() : prev.bounds;
      delete all[rec.key];
      all[rec.key] = { ...(bounds ? { bounds } : {}), maximized, at: Date.now() };
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SAVED))) delete all[k];
      fs.mkdirSync(path.dirname(boundsFile), { recursive: true });
      fs.writeFileSync(boundsFile, JSON.stringify(all, null, 2));
    } catch {}
  }

  /** Keeps a window on a visible display (screens may have changed since the bounds were saved). */
  function fitToScreen(b) {
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(Math.max(b.width, MIN.width), area.width);
    const height = Math.min(Math.max(b.height, MIN.height), area.height);
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
    return { x, y, width, height };
  }

  function initialBounds(key) {
    const saved = readJson(boundsFile)[key];
    if (saved?.bounds && Number.isFinite(saved.bounds.x)) return { bounds: fitToScreen(saved.bounds), maximized: Boolean(saved.maximized) };
    const main = getWindow();
    const base = main && !main.isDestroyed() ? main.getBounds() : screen.getPrimaryDisplay().workArea;
    const step = CASCADE * ((windows.size % 8) + 1);
    return { bounds: fitToScreen({ x: base.x + step, y: base.y + step, ...SIZE }), maximized: false };
  }

  /** Detached windows can't outlive the main window (IPC trust and the app lifetime hang on it). */
  function hookMain() {
    const main = getWindow();
    if (!main || main.isDestroyed() || hookedMains.has(main)) return;
    hookedMains.add(main);
    main.on('closed', () => {
      for (const rec of [...windows.values()]) {
        saveBounds(rec);
        if (!rec.win.isDestroyed()) rec.win.destroy();
      }
    });
  }

  function focus(rec) {
    const w = rec.win;
    if (w.isDestroyed()) return false;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    return true;
  }

  function senderRec(event) {
    const rec = bySender.get(event.sender.id);
    if (!rec || rec.win.isDestroyed()) throw new Error('Unknown sender');
    return rec;
  }

  // Channels a detached window calls about itself (they need to know which window is asking).
  const own = (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(senderRec(event), ...args));

  handle('win:detach', (payload = {}) => {
    const threadId = str(payload.threadId, 200);
    const sessionId = str(payload.sessionId, 200) || undefined;
    if (!threadId) throw new Error(t('windows.noChat'));
    const key = sessionId ?? threadId;
    const open = windows.get(key);
    if (open && !open.win.isDestroyed()) {
      focus(open);
      return { ok: true, existing: true };
    }
    // The renderer already refuses busy chats; double-check when the bridge can tell.
    if (typeof bridge.isBusy === 'function' && (bridge.isBusy(threadId) || (sessionId && bridge.isBusy(sessionId)))) {
      throw new Error(t('windows.busy'));
    }

    const title = str(payload.title, 300) || t('windows.chat');
    const info = {
      threadId,
      sessionId,
      title,
      cwd: str(payload.cwd, 2000),
      chain: Array.isArray(payload.chain) ? payload.chain.slice(0, 500) : undefined,
      model: str(payload.model, 200) || undefined,
      effort: str(payload.effort, 40) || undefined,
      permissionMode: str(payload.permissionMode, 60) || undefined,
      projectId: str(payload.projectId, 200) || undefined,
      draft: str(payload.draft, 100000) || undefined,
    };

    const theme = resolvedTheme();
    const { bounds, maximized } = initialBounds(key);
    const w = new BrowserWindow({
      ...bounds,
      ...(fs.existsSync(icon) ? { icon } : {}),
      title,
      minWidth: MIN.width,
      minHeight: MIN.height,
      show: false,
      backgroundColor: theme.bg,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: theme.bg, symbolColor: theme.symbol, height: 40 },
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    trustWindow(w);
    const rec = { key, win: w, info, ready: false, liveThreadId: null };
    const wcId = w.webContents.id;
    windows.set(key, rec);
    bySender.set(wcId, rec);
    hookMain();

    if (maximized) w.maximize();
    w.once('ready-to-show', () => w.show());

    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    w.webContents.on('will-navigate', (event, url) => {
      if (url === w.webContents.getURL()) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });
    w.webContents.on('before-input-event', (event, input) => {
      const ctrl = input.control || input.meta;
      if (input.type !== 'keyDown') return;
      if ((ctrl && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
        w.webContents.toggleDevTools();
        event.preventDefault();
      } else if (ctrl && input.key.toLowerCase() === 'r' && devUrl) {
        w.webContents.reload();
        event.preventDefault();
      }
    });

    w.on('close', () => saveBounds(rec));
    w.on('closed', () => {
      bySender.delete(wcId);
      if (windows.get(key) === rec) windows.delete(key);
      // Stop the chat's Claude Code process; the main window resumes the session if it is reopened.
      if (rec.liveThreadId) {
        try {
          bridge.closeThread(rec.liveThreadId);
        } catch {}
      }
      if (rec.ready) emit('win:reattached', { sessionId, threadId, open: Boolean(rec.reopen) });
    });

    const hash = `detached=${encodeURIComponent(key)}`;
    if (devUrl) w.loadURL(`${devUrl.replace(/#.*$/, '')}#${hash}`);
    else w.loadFile(indexFile, { hash });
    return { ok: true };
  });

  handle('win:focus', (key) => {
    const rec = windows.get(String(key ?? ''));
    return rec ? focus(rec) : false;
  });

  handle('win:list', () =>
    [...windows.values()].filter((r) => !r.win.isDestroyed()).map((r) => ({ key: r.key, threadId: r.info.threadId, sessionId: r.info.sessionId, ready: r.ready })),
  );

  /** What the detached window should open. */
  own('win:info', (rec) => rec.info);

  /** The detached window has the chat on screen: the main window may drop it now. */
  own('win:ready', (rec, payload = {}) => {
    const live = str(payload.threadId, 200);
    if (live) rec.liveThreadId = live;
    if (rec.ready) return true;
    rec.ready = true;
    const { threadId, sessionId } = rec.info;
    // A chat started in the main window keeps its process under its temporary id; the detached
    // window talks to Claude under the session id, so the old idle process is closed.
    if (threadId !== (rec.liveThreadId ?? sessionId)) {
      try {
        bridge.closeThread(threadId);
      } catch {}
    }
    emit('win:detached', { threadId, sessionId });
    return true;
  });

  own('win:setTheme', (rec, resolved) => {
    const theme = THEMES[resolved] ?? THEMES.dark;
    rec.win.setBackgroundColor(theme.bg);
    rec.win.setTitleBarOverlay?.({ color: theme.bg, symbolColor: theme.symbol, height: 40 });
    return true;
  });

  /** Closes the calling window (after the renderer confirmed closing a busy chat). */
  own('win:close', (rec) => {
    saveBounds(rec);
    // destroy() skips the renderer's beforeunload guard (it already asked) and the 'close' event.
    setImmediate(() => !rec.win.isDestroyed() && rec.win.destroy());
    return true;
  });

  /** "Return to the main window": closes this window and asks the main window to open the chat. */
  own('win:reattach', (rec) => {
    rec.reopen = true;
    saveBounds(rec);
    setImmediate(() => !rec.win.isDestroyed() && rec.win.destroy());
    const main = getWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.focus();
    }
    return true;
  });

  /** A chat that appeared inside a detached window (e.g. a fork) opens in the main window instead. */
  own('win:handoff', (_rec, info = {}) => {
    const sessionId = str(info.sessionId, 200);
    if (!sessionId) return false;
    emit('win:open', { sessionId, title: str(info.title, 300) || t('windows.chat'), cwd: str(info.cwd, 2000), lastModified: Date.now() });
    const main = getWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.focus();
    }
    return true;
  });
}

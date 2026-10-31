import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification } from './desktop.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeCli, createClaudeProvider } from './providers/claude/index.mjs';
import { createCodexProvider } from './providers/codex/index.mjs';
import { createAntigravityProvider } from './providers/antigravity/index.mjs';
import { createRegistry } from './core/registry.mjs';
import { createCore } from './core/runs.mjs';
import { createEventBatcher } from './core/event-batch.mjs';
import { createDiagnostics } from './core/diagnostics.mjs';
import { createFiles } from './files.mjs';
import { createTerminals } from './terminal.mjs';
import { createStats } from './stats.mjs';
import { createWorktrees } from './worktree.mjs';
import { setLanguage, t } from './i18n.mjs';
import { isWin, jetbrainsScriptsDir, terminalLauncher, which } from './platform.mjs';
import { createBrowser } from './browser.mjs';
import { sessionToolset } from './session-tools.mjs';
import { agentsToolset } from './core/agents.mjs';
import { createSessionWatch } from './core/watch.mjs';
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitDiffForMessage,
  gitDiscard,
  gitFileDiff,
  gitPull,
  gitPush,
  gitStatus,
} from './git.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.CLAUDE_UI_DEV_URL;

app.setName('Duet');
// Multiple cores sharing one profile multiply agents, GPU work and IPC traffic.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
// The app id predates the rename; keeping it lets the installer upgrade the old install in place.
if (process.platform === 'win32') app.setAppUserModelId('local.claude-desk');
migrateUserData('Claude Desk');

/** One-time copy of settings, chats state and browser logins from the app's previous userData folder. */
function migrateUserData(oldName) {
  const dir = app.getPath('userData');
  const old = path.join(app.getPath('appData'), oldName);
  if (fs.existsSync(path.join(dir, 'settings.json')) || !fs.existsSync(path.join(old, 'settings.json'))) return;
  // Per-file: a still-running old instance keeps some files locked; those are skipped, not fatal.
  const copy = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      // Caches rebuild themselves; DevToolsActivePort belongs to the old instance.
      if (/(Cache|DevToolsActivePort)$/i.test(e.name)) continue;
      const src = path.join(from, e.name);
      const dst = path.join(to, e.name);
      try {
        if (e.isDirectory()) {
          fs.mkdirSync(dst, { recursive: true });
          copy(src, dst);
        } else if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
      } catch (err) {
        console.error('userData migration: skipped', src, err.code ?? err);
      }
    }
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    copy(old, dir);
  } catch (e) {
    console.error('userData migration failed', e);
  }
}

const THEMES = {
  dark: { bg: '#181818', symbol: '#cfcfcf' },
  light: { bg: '#ffffff', symbol: '#3a3a3a' },
};

let win = null;
let openTargets = null;

/** JetBrains Toolbox launcher scripts (idea.cmd on Windows, idea on Linux/macOS) → IDE name. */
const JETBRAINS = {
  idea: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
  goland: 'GoLand',
  pycharm: 'PyCharm',
  phpstorm: 'PhpStorm',
  rider: 'Rider',
  clion: 'CLion',
  rustrover: 'RustRover',
  studio: 'Android Studio',
};

/** Editors and tools a project folder can be opened in, detected once per run. */
function detectOpenTargets() {
  if (openTargets) return openTargets;
  const list = [{ id: 'explorer', labelKey: isWin ? 'main.explorer' : 'main.fileManager' }];
  for (const [id, cmd, label] of [
    ['vscode', 'code', 'VS Code'],
    ['cursor', 'cursor', 'Cursor'],
    ['windsurf', 'windsurf', 'Windsurf'],
  ]) {
    const found = which(cmd);
    if (found) list.push({ id, label, cmd: found });
  }
  const tb = jetbrainsScriptsDir();
  try {
    for (const f of fs.readdirSync(tb)) {
      const base = f.replace(/\.(cmd|bat|sh)$/i, '').toLowerCase();
      if (JETBRAINS[base]) list.push({ id: `jb:${base}`, label: JETBRAINS[base], cmd: path.join(tb, f) });
    }
  } catch {}
  const term = terminalLauncher();
  if (term || isWin) list.push({ id: 'terminal', labelKey: 'main.terminal', term });
  openTargets = list;
  return list;
}

function openIn(id, cwd) {
  const target = detectOpenTargets().find((t) => t.id === id);
  if (!target || !cwd || !fs.existsSync(cwd)) return false;
  const detached = { detached: true, stdio: 'ignore', windowsHide: true };
  if (id === 'explorer') shell.openPath(cwd);
  else if (id === 'terminal') {
    if (target.term) spawn(target.term.cmd, target.term.args(cwd), { ...detached, cwd }).unref();
    else spawn('cmd.exe', ['/c', 'start', '', 'powershell', '-NoExit', '-Command', `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`], detached).unref();
  } else if (isWin) {
    // .cmd launchers (VS Code, Toolbox scripts) need a shell on Windows.
    spawn(`"${target.cmd}"`, [`"${cwd}"`], { ...detached, shell: true }).unref();
  } else {
    spawn(target.cmd, [cwd], { ...detached, cwd }).unref();
  }
  return true;
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(next) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
}

// Main-process strings (errors, notifications, Telegram) follow the UI language.
setLanguage(readSettings().ui?.language || 'en');

// Events go to every app window (main + detached chat windows); each renderer ignores threads it doesn't show.
const broadcast = (channel, payload) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
};
const eventBatch = createEventBatcher((batch) => broadcast('agent:events', batch));
const emit = (channel, payload) => {
  if (channel === 'agent:event') return eventBatch.push(payload);
  // A permission/close must never overtake the tool/result it belongs to.
  eventBatch.flush();
  broadcast(channel, payload);
};
const diagnostic = createDiagnostics(path.join(app.getPath('userData'), 'diagnostics.log'));
app.on('render-process-gone', (_event, contents, details) => diagnostic('renderer-gone', { webContentsId: contents.id, ...details }));
app.on('web-contents-created', (_event, contents) => {
  contents.on('unresponsive', () => diagnostic('renderer-unresponsive', { webContentsId: contents.id }));
});
const worktrees = createWorktrees(path.join(app.getPath('userData'), 'worktrees.json'));
const browser = createBrowser({ getWindow: () => win, emit });
const files = createFiles({ emit });
const terminals = createTerminals({ emit });
const stats = createStats(app.getPath('userData'));
const registry = createRegistry();
registry.register(createClaudeProvider({ stats, log: (...a) => console.log('[claude]', ...a) }));
registry.register(createCodexProvider({ log: (...a) => console.log('[codex]', ...a) }));
registry.register(createAntigravityProvider({ dataDir: app.getPath('userData'), log: (...a) => console.log('[antigravity]', ...a) }));
// Tools the app gives every agent: session helpers, the chat's own browser page and the other agents
// (one level of delegation, so agents don't keep handing work to each other).
const toolsFor = (key, { depth = 0 } = {}) => [sessionToolset(), browser.toolset(key), ...(depth < 1 ? [agentsToolset(core, key)] : [])];
const core = createCore({ emit, registry, browser, toolsFor, log: (...a) => console.log('[core]', ...a) });
const idleTrim = setInterval(() => {
  const minutes = Number(readSettings().ui?.idleAgentMinutes ?? 5);
  const released = core.trimIdleRuns({ maxIdleMs: Math.max(0, minutes) * 60000 });
  if (released.length) diagnostic('idle-agents-released', { count: released.length });
}, 30000);
idleTrim.unref();

function createWindow() {
  const settings = readSettings();
  const theme = THEMES[settings.resolvedTheme] ?? THEMES.dark;
  const bounds = settings.windowBounds ?? { width: 1380, height: 880 };

  const icon = path.join(__dirname, '..', 'build', 'icon.png');
  win = new BrowserWindow({
    ...bounds,
    ...(fs.existsSync(icon) ? { icon } : {}),
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: theme.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: theme.bg, symbolColor: theme.symbol, height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Keep streaming text and animations running while the window is in the background.
      backgroundThrottling: false,
    },
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('before-input-event', (event, input) => {
    const ctrl = input.control || input.meta;
    if (input.type !== 'keyDown') return;
    if ((ctrl && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (ctrl && input.key.toLowerCase() === 'r' && DEV_URL) {
      win.webContents.reload();
      event.preventDefault();
    }
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const s = readSettings();
    s.maximized = win.isMaximized();
    if (!s.maximized && !win.isMinimized()) s.windowBounds = win.getBounds();
    writeSettings(s);
  };
  win.on('close', saveBounds);

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

// Extra app windows (detached chats) that may call IPC like the main window.
const trustedContents = new Set();
const trustWindow = (w) => {
  const wc = w.webContents;
  trustedContents.add(wc);
  w.on('closed', () => trustedContents.delete(wc));
};

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!win || (event.sender !== win.webContents && !trustedContents.has(event.sender))) throw new Error('Unknown sender');
    return fn(...args);
  });
}

handle('agent:probe', (force) => core.probe(Boolean(force)));
handle('agent:usage', (provider) => core.usage(provider));
handle('agent:listSessions', () => core.listSessions());
handle('agent:loadSession', (sessionId, cwd, segment, provider) => core.loadSession(sessionId, cwd, segment, provider));
handle('agent:segments', (sessionId, cwd, provider) => core.listSegments(sessionId, cwd, provider));
handle('agent:renameSession', (sessionId, title, cwd, provider) => core.renameSession(sessionId, title, cwd, provider));
handle('agent:deleteSession', (sessionId, cwd, provider) => core.deleteSession(sessionId, cwd, provider));
handle('agent:send', (payload) => core.send(payload));
handle('agent:configure', (payload) => core.configure(payload));
handle('desk:switch-provider', (payload) => core.switchProvider(payload));
handle('agent:interrupt', (threadId) => core.interrupt(threadId));
handle('agent:respondPermission', (payload) => core.respondPermission(payload));
handle('agent:closeThread', (threadId) => core.closeThread(threadId));
handle('agent:autoTitle', (payload) => core.autoTitle(payload));
handle('browser:setBounds', (b) => browser.setBounds(b));
handle('browser:setVisible', (v, key) => browser.setVisible(v, key));
handle('browser:navigate', (url, key) => browser.navigate(key, url));
handle('browser:control', (action, key) => browser.control(key, action));
handle('browser:state', (key) => browser.state(key));
handle('browser:screenshot', (key) => browser.screenshot(key));
handle('wt:isRepo', (cwd) => worktrees.isRepo(cwd));
handle('wt:create', (cwd) => worktrees.create(cwd));
handle('wt:apply', (dir) => worktrees.apply(dir));
handle('wt:remove', (dir) => worktrees.remove(dir));
handle('wt:all', () => worktrees.all());
handle('agent:contextUsage', (threadId) => core.contextUsage(threadId));
handle('agent:rewind', (payload) => core.rewind(payload));
handle('agent:fork', (payload) => core.fork(payload));
handle('agent:rewindConversation', (payload) => core.rewindConversation(payload));
handle('agent:loadSubagents', (sessionId, cwd, provider) => core.loadSubagents(sessionId, cwd, provider));
handle('agent:stopTask', (threadId, taskId) => core.stopTask(threadId, taskId));
handle('agent:backgroundTask', (threadId, toolUseId) => core.backgroundTask(threadId, toolUseId));
handle('agent:taskOutput', (file) => core.taskOutput(file));
handle('app:gitStatus', (cwd) => gitStatus(cwd));
handle('app:gitFileDiff', (root, file, untracked) => gitFileDiff(root, file, untracked));
handle('app:gitCommit', (root, files, message) => gitCommit(root, files, message));
handle('app:gitPush', (root) => gitPush(root));
handle('app:gitPull', (root) => gitPull(root));
handle('app:gitDiscard', (root, file, untracked) => gitDiscard(root, file, untracked));
handle('app:gitBranches', (root) => gitBranches(root));
handle('app:gitCheckout', (root, branch, create) => gitCheckout(root, branch, create));
// Open chats follow their sessions on disk (continued in another window, the CLI or the agent's own app).
const sessionWatch = createSessionWatch({ registry, emit, activity: (id, sid) => core.activity(id, sid), log: (...a) => console.log('[watch]', ...a) });
handle('desk:watch', (key, list) => sessionWatch.set(key, list));
handle('desk:release', (threadId) => core.release(threadId));
// Skills an agent offers in a folder (agents whose skills aren't in the probe's command list).
handle('desk:skills', (provider, cwd) => registry.get(provider).skills?.(cwd) ?? []);
// Condenses the older part of a conversation handed over to another agent.
handle('desk:summarize', (text) =>
  core.quickText({
    prompt:
      'Summarize this earlier part of a coding session for the agent that will continue it. Keep: the goal, decisions and their reasons, ' +
      'files and functions touched, commands and their outcomes, open problems and next steps. Plain text, at most 600 words.\n\n' +
      String(text).slice(0, 120000),
    system: 'You write precise, compact handoff notes for software engineers.',
    timeoutMs: 120000,
  }),
);
handle('app:commitMessage', async (root, files) => core.commitMessage(await gitDiffForMessage(root, files)));
handle('app:openTargets', () => detectOpenTargets().map(({ id, label, labelKey }) => ({ id, label: labelKey ? t(labelKey) : label })));
handle('app:openIn', (id, cwd) => openIn(id, cwd));

handle('app:getSettings', () => readSettings().ui ?? {});
handle('desk:ui-error', (error = {}) => diagnostic('ui-error', {
  message: String(error.message ?? '').slice(0, 2000), stack: String(error.stack ?? '').slice(0, 4000),
}));
handle('desk:notification', ({ title, body }) => {
  if (Notification?.isSupported?.()) new Notification({ title: String(title).slice(0, 200), body: String(body).slice(0, 2000) }).show();
});
handle('app:setSettings', (ui) => {
  const s = readSettings();
  s.ui = { ...(s.ui ?? {}), ...ui };
  writeSettings(s);
  if (ui?.language) setLanguage(ui.language);
  return s.ui;
});
handle('app:setTheme', (resolved) => {
  const theme = THEMES[resolved] ?? THEMES.dark;
  const s = readSettings();
  s.resolvedTheme = resolved;
  writeSettings(s);
  win.setBackgroundColor(theme.bg);
  win.setTitleBarOverlay?.({ color: theme.bg, symbolColor: theme.symbol, height: 40 });
});
handle('app:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});
handle('app:openExternal', (url) => {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
});
handle('app:openPath', (p) => (fs.existsSync(p) ? shell.openPath(p) : 'not found'));
handle('app:showInFolder', (p) => fs.existsSync(p) && shell.showItemInFolder(p));
handle(
  'app:gitBranch',
  (cwd) =>
    new Promise((resolve) => {
      if (!cwd || !fs.existsSync(cwd)) return resolve(null);
      execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000, windowsHide: true }, (err, out) =>
        resolve(err ? null : out.trim() || null),
      );
    }),
);
handle('app:pathExists', (p) => Boolean(p) && fs.existsSync(p));

// ---------- editor files ----------
handle('files:list', (dir) => files.list(dir));
handle('files:read', (p) => files.read(p));
handle('files:write', (p, text) => files.write(p, text));
handle('files:watch', (p) => files.watch(p));
handle('files:unwatch', (p) => files.unwatch(p));

// ---------- terminals ----------
handle('term:create', (opts) => terminals.create(opts));
handle('term:write', (id, data) => terminals.write(id, data));
handle('term:resize', (id, cols, rows) => terminals.resize(id, cols, rows));
handle('term:kill', (id) => terminals.kill(id));

// ---------- stats ----------
handle('stats:summary', (days) => stats.summary(days));

// ---------- MCP management (via the bundled Claude Code CLI) ----------
const runCli = (args) =>
  new Promise((resolve, reject) =>
    execFile(claudeCli(), args, { windowsHide: true, timeout: 60000, cwd: os.homedir() }, (err, out, errOut) =>
      err ? reject(new Error((errOut || out || err.message).toString().trim())) : resolve(out.toString().trim()),
    ),
  );
handle('mcp:status', (provider) => core.mcpStatus(provider));
handle('mcp:reconnect', (name, provider) => core.mcpReconnect(name, provider));
handle('mcp:add', ({ name, transport, target, args = [], scope = 'user', env = {}, provider }) => {
  if (!/^[\w.:-]+$/.test(name)) throw new Error(t('main.mcpBadName'));
  if (provider && provider !== 'claude') return registry.get(provider).mcpAdd({ name, transport, target, args, env });
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return transport === 'stdio'
    ? runCli(['mcp', 'add', '-s', scope, ...envArgs, name, '--', target, ...args])
    : runCli(['mcp', 'add', '--transport', transport, '-s', scope, name, target]);
});
handle('mcp:remove', (name, scope, provider) =>
  provider && provider !== 'claude' ? registry.get(provider).mcpRemove(name) : runCli(['mcp', 'remove', name, ...(scope ? ['-s', scope] : [])]),
);

// ---------- self-update (dev checkout only) ----------
const startedAt = Date.now();
const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
const distMtime = () => (fs.existsSync(distIndex) ? fs.statSync(distIndex).mtimeMs : 0);
handle('app:buildInfo', () => ({ canRebuild: !app.isPackaged, newer: distMtime() > startedAt + 2000 }));
handle(
  'app:rebuild',
  () =>
    new Promise((resolve, reject) =>
      execFile('npm', ['run', 'build'], { cwd: path.join(__dirname, '..'), shell: true, windowsHide: true, timeout: 300000 }, (err, out, errOut) =>
        err ? reject(new Error((errOut || out || err.message).toString().slice(-800))) : resolve(true),
      ),
    ),
);
handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});
if (!app.isPackaged) {
  let notified = false;
  fs.watch(path.dirname(distIndex), { persistent: false }, () => {
    if (!notified && distMtime() > startedAt + 2000) {
      notified = true;
      emit('app:update-available', {});
    }
  }).on?.('error', () => {});
}

// ---------- feature modules (electron/features/*.mjs export register(ctx)) ----------
const featureCtx = { handle, emit, core, stats, app, getWindow: () => win, userData: app.getPath('userData'), trustWindow, preloadPath: path.join(__dirname, 'preload.cjs'), devUrl: DEV_URL, indexFile: path.join(__dirname, '..', 'dist', 'index.html') };
const featuresDir = path.join(__dirname, 'features');
if (fs.existsSync(featuresDir)) {
  for (const f of fs.readdirSync(featuresDir).filter((x) => x.endsWith('.mjs'))) {
    // An isolated preview must never start a second Telegram poller or scheduler.
    if (process.env.DUET_NATIVE_PREVIEW && ['telegram.mjs', 'scheduler.mjs'].includes(f)) continue;
    import(pathToFileURL(path.join(featuresDir, f)).href)
      .then((m) => m.register?.(featureCtx))
      .catch((e) => console.error('[feature]', f, e));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});
app.on('window-all-closed', () => {
  terminals.killAll();
  core.closeAll();
  app.quit();
});

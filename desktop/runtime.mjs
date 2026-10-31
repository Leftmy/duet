import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const config = JSON.parse(process.env.DUET_NATIVE_CONFIG || '{}');
if (!config.userData) throw new Error('Native host configuration is missing');
const nativeOwnedInTest = process.env.DUET_NATIVE_TEST
  ? new Set(JSON.parse(fs.readFileSync(new URL('./ipc-ownership.json', import.meta.url), 'utf8')).channels.filter((c) => c.owner === 'rust').map((c) => c.channel))
  : null;
const objects = new Map(), handlers = new Map(), waiting = new Map();
let sequence = 0, windowCount = 0, shuttingDown = false;
const send = (message) => !shuttingDown && !process.stdout.destroyed && process.stdout.write(JSON.stringify(message) + '\n');
process.stdout.on('error', () => shutdown());
function host(method, params = {}) {
  if (shuttingDown) return Promise.resolve(null);
  const id = `node-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Native host timed out: ${method}`)); }, 30000);
    waiting.set(id, { resolve, reject, timer });
    send({ type: 'host', id, method, params });
  });
}
const fire = (method, params) => host(method, params).catch((e) => console.error(e.message));
const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'host.result') {
      const pending = waiting.get(msg.id);
      if (!pending) return;
      waiting.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error)); else pending.resolve(msg.result);
    } else if (msg.type === 'invoke') {
      try {
        if (nativeOwnedInTest?.has(msg.channel)) throw new Error('Native-owned command reached the legacy Node core: ' + msg.channel);
        const owner = objects.get(msg.window);
        if (!(owner instanceof BrowserWindow) || owner.isDestroyed()) throw new Error('Unknown UI window');
        const fn = handlers.get(msg.channel);
        if (!fn) throw new Error(`Unknown channel: ${msg.channel}`);
        const result = await fn({ sender: owner.webContents }, ...(msg.args ?? []));
        send({ type: 'response', id: msg.id, result: result ?? null });
      } catch (e) { send({ type: 'response', id: msg.id, error: String(e.message || e) }); }
    } else if (msg.type === 'native.event') {
      const obj = objects.get(msg.window);
      if (!obj) return;
      if (msg.event === 'state') {
        Object.assign(obj.webContents.state, msg.data ?? {});
        obj.webContents.emit('did-navigate');
      } else if (msg.event === 'window-state') Object.assign(obj, msg.data);
      else if (msg.event === 'bounds') obj.bounds = { ...obj.bounds, ...msg.data };
      else if (msg.event === 'ready') { obj.emit('ready-to-show'); obj.webContents.emit('did-finish-load'); }
      else if (msg.event === 'popup') obj.webContents.openHandler?.({ url: msg.data.url });
      else if (msg.event === 'closed') {
        obj.emit('close'); obj.destroyed = true; objects.delete(obj.id); obj.emit('closed');
        if (!BrowserWindow.getAllWindows().length) app.emit('window-all-closed');
      }
    } else if (msg.type === 'shutdown') shutdown();
  } catch (e) { console.error('native transport:', e.message); }
});
input.once('close', shutdown);

export const ipcMain = { handle(channel, fn) { if (handlers.has(channel)) throw new Error(`Duplicate channel: ${channel}`); handlers.set(channel, fn); } };
export const app = Object.assign(new EventEmitter(), {
  isPackaged: Boolean(config.packaged),
  getPath(name) {
    const paths = { userData: config.userData, appData: config.appData, home: os.homedir(), temp: os.tmpdir(), desktop: path.join(os.homedir(), 'Desktop') };
    if (!paths[name]) throw new Error(`Unknown native path: ${name}`);
    return paths[name];
  },
  setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  relaunch: () => fire('app.relaunch'),
  exit: () => fire('app.quit'), quit: () => fire('app.quit'),
});
export const Menu = { setApplicationMenu() {} };
export const shell = {
  openExternal: (target) => host('shell.open', { target }),
  openPath: (target) => host('shell.open', { target }),
  showItemInFolder: (target) => host('shell.reveal', { target }),
};
export const dialog = { async showOpenDialog(_owner, options) {
  const selected = await host('dialog.open', options);
  return { canceled: !selected, filePaths: selected ? [selected] : [] };
} };
const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
export const screen = { getDisplayMatching: () => ({ workArea: config.workArea ?? workArea }), getPrimaryDisplay: () => ({ workArea: config.workArea ?? workArea }) };
// Native WebView media permission handling lives in the host, never in Node.
export const session = { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } };
export class Notification extends EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); this.options = options; }
  show() { fire('notification', this.options); }
}

class NativeImage {
  constructor(result) { this.result = result; }
  getSize() { return { width: this.result.width, height: this.result.height }; }
  resize() { return this; } // The host already constrains captures to 1280 pixels.
  toPNG() { return Buffer.from(this.result.png, 'base64'); }
}
class Contents extends EventEmitter {
  constructor(owner) {
    super(); this.owner = owner; this.id = owner.id;
    this.state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
    this.navigationHistory = {
      canGoBack: () => this.state.canGoBack, canGoForward: () => this.state.canGoForward,
      goBack: () => this.op('back'), goForward: () => this.op('forward'),
    };
  }
  isDestroyed() { return this.owner.destroyed; }
  getURL() { return this.state.url; }
  getTitle() { return this.state.title; }
  isLoading() { return this.state.loading; }
  send(channel, payload) { fire('event', { window: this.id, channel, payload }); }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  async op(op, args = {}) { await this.owner.created; return host('window.op', { id: this.id, op, ...args }); }
  async loadURL(url) { this.state.url = url; this.state.loading = true; return this.op('navigate', { url }); }
  executeJavaScript(code) { return this.op('eval', { code }); }
  async capturePage() { return new NativeImage(await this.op('capture')); }
  reload() { return this.op('reload'); }
  stop() { return this.op('stop'); }
  toggleDevTools() { return this.op('devtools'); }
  close() { return this.owner.destroy(); }
}

class NativeView extends EventEmitter {
  constructor(options, kind) {
    super(); this.kind = kind; this.id = kind === 'window' && windowCount++ === 0 ? 'main' : `${kind}-${++sequence}`;
    this.destroyed = false; this.bounds = { x: 100, y: 100, width: 1380, height: 880, ...options };
    this.webContents = new Contents(this);
    objects.set(this.id, this);
    this.created = Promise.resolve().then(() => host('window.create', { id: this.id, kind, options, hash: this.hash ?? '' })).catch((e) => { console.error('native window:', e.message); throw e; });
    this.contentView = {
      children: [],
      addChildView: (view) => { if (!this.contentView.children.includes(view)) this.contentView.children.push(view); view.show(); },
      removeChildView: (view) => { this.contentView.children = this.contentView.children.filter((v) => v !== view); view.hide(); },
    };
  }
  isDestroyed() { return this.destroyed; }
  getBounds() { const { x, y, width, height } = this.bounds; return { x, y, width, height }; }
  isMaximized() { return Boolean(this.maximized); }
  isMinimized() { return Boolean(this.minimized); }
  maximize() { this.maximized = true; this.webContents.op('maximize'); }
  restore() { this.minimized = false; this.webContents.op('restore'); }
  show() { this.webContents.op('show'); }
  hide() { this.webContents.op('hide'); }
  focus() { this.webContents.op('focus'); }
  setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; this.webContents.op('bounds', bounds); }
  setBackgroundColor(color) { this.webContents.op('background', { color }); }
  setTitleBarOverlay() {}
  loadURL(url) { return this.webContents.loadURL(url); }
  loadFile(_file, { hash = '' } = {}) { this.hash = hash; return this.created; }
  destroy() { if (!this.destroyed) return this.webContents.op('close'); }
}
export class BrowserWindow extends NativeView {
  constructor(options = {}) { super(options, 'window'); }
  static getAllWindows() { return [...objects.values()].filter((o) => o instanceof BrowserWindow && !o.destroyed); }
}
export class WebContentsView extends NativeView {
  constructor(options = {}) { super(options, 'view'); }
}
export function ready() { send({ type: 'ready' }); }
export function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Graceful quit follows the same core cleanup path as the original application.
  app.emit('window-all-closed');
  for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('Native host closed')); }
  waiting.clear();
  setTimeout(() => process.exit(0), 300).unref();
}

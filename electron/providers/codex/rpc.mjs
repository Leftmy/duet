// JSON-RPC client for `codex app-server` (newline-delimited JSON over stdio).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
};

function npmGlobalRoot() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const p = path.join(process.env.APPDATA, 'npm', 'node_modules');
    if (fs.existsSync(p)) return p;
  }
  try {
    return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

/** "codex-cli 0.162.0-alpha.2" → comparable [0, 162, 0]. */
function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? m.slice(1).map(Number) : [0, 0, 0];
  } catch {
    return null;
  }
}
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Binaries the Codex desktop app keeps up to date (Windows: %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe). */
function desktopCodex() {
  const dir = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d, 'codex.exe'))
    .filter((p) => fs.existsSync(p))
    .map((bin) => ({ bin, env: {} }));
}

let found;

/**
 * The codex binary to run (newest of the CLI from npm and the one the Codex desktop app ships), with the
 * environment its launcher would give it; null when Codex isn't installed. DUET_CODEX_BIN overrides.
 */
export function findCodex() {
  if (process.env.DUET_CODEX_BIN && fs.existsSync(process.env.DUET_CODEX_BIN)) return { bin: process.env.DUET_CODEX_BIN, env: {} };
  if (found !== undefined) return found;
  let best = null;
  for (const c of [npmCodex(), ...desktopCodex()].filter(Boolean)) {
    const v = versionOf(c.bin);
    if (v && (!best || newer(v, best.version) > 0)) best = { ...c, version: v };
  }
  found = best;
  return found;
}

/** The native binary of the npm package (global or next to the app) with its launcher's environment. */
function npmCodex() {
  const key = `${process.platform}-${process.arch}`;
  const triple = TRIPLES[key];
  if (!triple) return null;
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const roots = [];
  try {
    roots.push(path.dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json')));
  } catch {}
  const global = npmGlobalRoot();
  if (global) roots.push(path.join(global, '@openai', 'codex'));
  for (const root of roots) {
    const vendors = [
      path.join(root, 'node_modules', '@openai', `codex-${key}`, 'vendor'),
      path.join(path.dirname(root), `codex-${key}`, 'vendor'),
      path.join(root, 'vendor'),
    ];
    for (const vendor of vendors) {
      for (const [bin, pathDir] of [
        [path.join(vendor, triple, 'bin', exe), path.join(vendor, triple, 'codex-path')],
        [path.join(vendor, triple, 'codex', exe), path.join(vendor, triple, 'path')],
      ]) {
        if (!fs.existsSync(bin)) continue;
        const extra = fs.existsSync(pathDir) ? pathDir + path.delimiter : '';
        return {
          bin: bin.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
          env: { PATH: extra + (process.env.PATH || ''), CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: root },
        };
      }
    }
  }
  return null;
}

export class RpcError extends Error {
  constructor(error) {
    super(error?.message || 'Codex request failed');
    this.code = error?.code;
    this.data = error?.data;
  }
}

/**
 * One app-server process. onNotification(method, params); onRequest(method, params, id) → result (may be async).
 */
export class AppServer {
  constructor({ codex, onNotification, onRequest, onExit, log = () => {}, args = [] }) {
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
    this.stderrTail = '';
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.log = log;
    this.proc = spawn(codex.bin, ['app-server', ...args], {
      env: { ...process.env, ...codex.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: os.homedir(),
    });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.receive(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    const exited = (error) => {
      if (this.closed) return;
      this.closed = true;
      const err = new Error(error || `codex app-server exited${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      onExit?.(err);
    };
    this.proc.on('exit', () => exited());
    this.proc.on('error', (e) => exited(String(e?.message || e)));
  }

  receive(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log('codex: bad line', line.slice(0, 200));
      return;
    }
    if (msg.id != null && msg.method) {
      // A request from the server (approvals, client tool calls).
      Promise.resolve()
        .then(() => this.onRequest?.(msg.method, msg.params ?? {}, msg.id))
        .then(
          (result) => this.write({ id: msg.id, result: result ?? {} }),
          (e) => this.write({ id: msg.id, error: { code: -32000, message: String(e?.message || e) } }),
        );
    } else if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error));
      else p.resolve(msg.result);
    } else if (msg.method) {
      try {
        this.onNotification?.(msg.method, msg.params ?? {});
      } catch (e) {
        this.log('codex: notification handler failed', msg.method, e);
      }
    }
  }

  write(msg) {
    if (this.closed) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params, timeoutMs = 120000) {
    if (this.closed) return Promise.reject(new Error('codex app-server is not running'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  async initialize(clientInfo) {
    const r = await this.request('initialize', { clientInfo, capabilities: { experimentalApi: true, requestAttestation: false } }, 60000);
    this.notify('initialized');
    return r;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        this.proc.kill();
      } catch {}
    }, 1500).unref?.();
  }
}

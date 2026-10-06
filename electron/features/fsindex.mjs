// Project file index for @-mentions in the composer.
// fs:index(cwd) -> { entries: string[] (relative, '/'-separated; directories end with '/'), git, truncated }
// fs:stat(paths[]) -> [{ path, exists, dir }]
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 30000;
const TTL = 30_000;
const SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  'target', 'bin', 'obj', '.idea', '.vs', '.vscode-test', '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  '.gradle', 'coverage', '.terraform', 'vendor', 'Pods', 'DerivedData', '.angular', '.expo',
]);

/** cwd -> { ts, promise } */
const cache = new Map();

function gitList(cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        if (err) return reject(err);
        const out = [];
        const seen = new Set();
        for (const p of stdout.split('\0')) {
          // --cached and --others never overlap, but a conflicted file is listed once per stage.
          if (!p || seen.has(p)) continue;
          seen.add(p);
          out.push(p);
        }
        resolve(out);
      },
    );
  });
}

async function walk(root) {
  const out = [];
  const queue = [''];
  while (queue.length && out.length < MAX_FILES) {
    const rel = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.git')) queue.push(p);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (e.name === '.DS_Store' || e.name === 'Thumbs.db') continue;
        out.push(p);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return { files: out, truncated: out.length >= MAX_FILES || queue.length > 0 };
}

/** Files plus every parent directory (with a trailing '/'), directories first per depth is left to the renderer. */
function withDirs(files) {
  const dirs = new Set();
  for (const f of files) {
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const d = f.slice(0, i + 1);
      if (dirs.has(d)) break;
      dirs.add(d);
      i = f.lastIndexOf('/', i - 1);
    }
  }
  return [...dirs, ...files];
}

export async function buildIndex(cwd) {
  let files;
  let git = false;
  let truncated = false;
  try {
    files = await gitList(cwd);
    git = true;
  } catch {
    ({ files, truncated } = await walk(cwd));
  }
  if (files.length > MAX_FILES) {
    files = files.slice(0, MAX_FILES);
    truncated = true;
  }
  return { entries: withDirs(files), git, truncated };
}

export function getIndex(cwd, force = false) {
  const key = path.resolve(cwd);
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.ts < TTL) return hit.promise;
  const promise = buildIndex(key);
  const rec = { ts: Date.now(), promise };
  cache.set(key, rec);
  promise.then(
    () => (rec.ts = Date.now()),
    () => cache.get(key) === rec && cache.delete(key),
  );
  return promise;
}

export function register(ctx) {
  ctx.handle('fs:index', async (cwd, opts) => {
    if (typeof cwd !== 'string' || !cwd) return { entries: [], git: false, truncated: false };
    const st = await fsp.stat(cwd).catch(() => null);
    if (!st?.isDirectory()) return { entries: [], git: false, truncated: false };
    return getIndex(cwd, !!opts?.force);
  });

  ctx.handle('fs:stat', async (paths) => {
    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string').slice(0, 500) : [];
    return Promise.all(
      list.map(async (p) => {
        const st = await fsp.stat(p).catch(() => null);
        return { path: p, exists: !!st, dir: !!st?.isDirectory() };
      }),
    );
  });
}

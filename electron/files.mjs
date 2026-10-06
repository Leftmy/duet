// File access for the editor panel: list folders, read/write text files, watch open files.
import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';

const MAX_READ = 4 * 1024 * 1024;
const HIDDEN = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'bin', 'obj', '.idea', '.vs', '__pycache__', '.venv', 'venv']);

export function createFiles({ emit }) {
  const watchers = new Map();

  return {
    list(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith('.git') && e.name !== '.DS_Store')
        .map((e) => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory(), dim: HIDDEN.has(e.name) }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    },

    read(file) {
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error(t('files.notAFile'));
      if (st.size > MAX_READ) return { tooLarge: true, size: st.size };
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
      return { text: buf.toString('utf8'), mtime: st.mtimeMs, size: st.size };
    },

    write(file, text) {
      fs.writeFileSync(file, text, 'utf8');
      return { mtime: fs.statSync(file).mtimeMs };
    },

    /** Notifies the renderer when an open file changes on disk (e.g. Claude edited it). */
    watch(file) {
      if (watchers.has(file) || !fs.existsSync(file)) return;
      let timer;
      const w = fs.watch(file, () => {
        clearTimeout(timer);
        timer = setTimeout(() => emit('files:changed', { path: file }), 150);
      });
      w.on('error', () => {});
      watchers.set(file, w);
    },

    unwatch(file) {
      watchers.get(file)?.close();
      watchers.delete(file);
    },
  };
}

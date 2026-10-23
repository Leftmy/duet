import type { Entry, Thread, ToolItem } from '../types';
import { toolStats, toolKind } from './tools';
import { locale } from '../i18n';

export interface FileChange {
  path: string;
  items: ToolItem[];
  add: number;
  del: number;
  created: boolean;
}

const turnCache = new WeakMap<Entry, { language: string; files: FileChange[] }>();
const historyCache = new WeakMap<Entry[], { language: string; files: FileChange[] }>();

/** Reuse closed turns and immutable tool inputs across streamed updates. */
export function collectChanges(thread: Pick<Thread, 'entries'>): FileChange[] {
  const language = locale();
  const hit = historyCache.get(thread.entries);
  if (hit?.language === language) return hit.files;
  const byPath = new Map<string, FileChange>();
  for (const e of thread.entries) {
    if (e.kind !== 'turn') continue;
    let cached = turnCache.get(e);
    if (!cached || cached.language !== language) {
      const files: FileChange[] = [];
      for (const it of e.items) {
        if (it.kind !== 'tool' || it.status === 'error') continue;
        const kind = toolKind(it.name);
        if (kind !== 'edit' && kind !== 'write') continue;
        const p = it.input?.file_path ?? it.input?.notebook_path;
        if (typeof p !== 'string' || !p) continue;
        const s = toolStats(it);
        files.push({ path: p, items: [it], add: s?.add ?? 0, del: s?.del ?? 0, created: it.name === 'Write' });
      }
      cached = { language, files };
      turnCache.set(e, cached);
    }
    for (const file of cached.files) {
      const key = file.path.toLowerCase();
      const prev = byPath.get(key);
      if (prev) { prev.items.push(...file.items); prev.add += file.add; prev.del += file.del; }
      else byPath.set(key, { ...file, items: [...file.items] });
    }
  }
  const files = [...byPath.values()].reverse();
  historyCache.set(thread.entries, { language, files });
  return files;
}

// Turns dropped / pasted (non-image) files into text mentions:
// inside the thread's cwd -> `@relative/path` (folders get a trailing '/'), elsewhere -> "C:\absolute\path".
import { mentionFor } from './useMentions';

/** Needs preload: `getPathForFile: (file) => webUtils.getPathForFile(file)`. */
export function pathForFile(file: File): string {
  try {
    return (window.desk as any).getPathForFile?.(file) || '';
  } catch {
    return '';
  }
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

export async function filesToMentions(files: File[], cwd: string): Promise<string> {
  const paths = files.map(pathForFile);
  const real = paths.filter(Boolean);
  let dirs = new Set<string>();
  if (real.length) {
    try {
      const st = await window.desk.call<{ path: string; dir: boolean }[]>('fs:stat', real);
      dirs = new Set(st.filter((s) => s.dir).map((s) => s.path));
    } catch {}
  }
  const root = cwd ? norm(cwd) : '';
  const rootLc = root.toLowerCase() + '/';
  // Windows paths are case-insensitive; elsewhere compare exactly.
  const ci = window.desk.platform === 'win32';
  return files
    .map((f, i) => {
      const abs = paths[i];
      if (!abs) return /\s/.test(f.name) ? `"${f.name}"` : f.name;
      const n = norm(abs);
      const inside = root && (ci ? (n.toLowerCase() + '/').startsWith(rootLc) : (n + '/').startsWith(root + '/')) && n.length > root.length;
      if (inside) return mentionFor(n.slice(root.length + 1) + (dirs.has(abs) ? '/' : ''));
      return `"${abs}"`;
    })
    .join(' ');
}

/** Inserts `snippet` at the textarea caret, padding with spaces where needed. Returns new value + caret. */
export function insertAtCaret(ta: HTMLTextAreaElement | null, value: string, snippet: string): { value: string; caret: number } {
  const start = ta ? ta.selectionStart : value.length;
  const end = ta ? ta.selectionEnd : value.length;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && /^\s/.test(after) ? '' : ' ';
  const ins = lead + snippet + trail;
  return { value: before + ins + after, caret: before.length + ins.length };
}

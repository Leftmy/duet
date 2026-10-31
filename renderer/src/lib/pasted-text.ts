import type { PastedTextFile } from '../types';

export const PASTE_CHAR_THRESHOLD = 4000;
export const PASTE_LINE_THRESHOLD = 50;
export const pastedLineCount = (text: string) => text.split(/\r\n|\r|\n/).length;
export const shouldAttachPaste = (text: string) => text.length >= PASTE_CHAR_THRESHOLD || pastedLineCount(text) >= PASTE_LINE_THRESHOLD;

const heading = 'Files pasted by the user (read as needed):';
// A plain-text reference works with every provider, queued messages and restored history.
// The actual file content never becomes part of the prompt automatically.
export function withPastedText(text: string, files: PastedTextFile[]): string {
  if (!files.length) return text;
  const links = files.map(file => {
    const href = encodeURI(file.path.replace(/\\/g, '/')).replace(/[?#<>()[\]]/g, c => encodeURIComponent(c));
    return `- [${file.name} (${file.lines} lines)](<${href}>)`;
  });
  return [text.trimEnd(), heading + '\n' + links.join('\n')].filter(Boolean).join('\n\n');
}

export function splitPastedText(message: string): { text: string; files: PastedTextFile[] } {
  const start = message.lastIndexOf(heading + '\n');
  if (start < 0 || (start > 0 && !message.slice(0, start).endsWith('\n\n'))) return { text: message, files: [] };
  const files: PastedTextFile[] = [];
  for (const line of message.slice(start + heading.length + 1).split('\n')) {
    const match = /^- \[(pasted-text-([\da-f-]{36})\.txt) \((\d+) lines\)\]\(<(.+)>\)$/.exec(line);
    if (!match) return { text: message, files: [] };
    let path: string;
    try { path = decodeURIComponent(match[4]); } catch { return { text: message, files: [] }; }
    if (!/^(?:[a-z]:\/|\/)/i.test(path) || /[\x00-\x1f]/.test(path)) return { text: message, files: [] };
    files.push({ id: match[2], name: match[1], path, lines: Number(match[3]), bytes: 0 });
  }
  return { text: message.slice(0, start).trimEnd(), files };
}

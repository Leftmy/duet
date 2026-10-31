export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'file'; path: string; line?: number; column?: number; endLine?: number }
  | { kind: 'blocked' };

const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
const drive = /^[a-z]:[\\/]/i;
export function linkTarget(raw: string, cwd = '', platform = 'linux'): LinkTarget {
  let href = raw.trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return { kind: 'blocked' };
  if (/^(https?:|mailto:)/i.test(href) || href.startsWith('//')) {
    try {
      const url = new URL(href.startsWith('//') ? 'https:' + href : href);
      if (['https:', 'http:', 'mailto:'].includes(url.protocol)) return { kind: 'external', url: url.href };
    } catch {}
    return { kind: 'blocked' };
  }
  if (href.startsWith('#')) return { kind: 'anchor', id: decode(href.slice(1)) };
  href=href.replace(/%3a(\d+)(?:(?:%3a|:)(\d+))?(?=#|$)/i,(_,line,column)=>`:${line}${column?':'+column:''}`);
  if (/^\/[a-z]:[\\/]/i.test(href)) href = href.slice(1);
  if(/^(javascript|vbscript|data|blob|about):/i.test(href))return {kind:'blocked'};
  if (!drive.test(href) && !/^file:/i.test(href) && /^[a-z][a-z\d+.-]*:/i.test(href) && !/^[^:/\\]+:\d+(?::\d+)?(?:#.*)?$/.test(href)) return { kind: 'blocked' };
  let fragment = '';
  const hash = href.indexOf('#');
  if (hash >= 0) { fragment = href.slice(hash + 1); href = href.slice(0, hash); }
  const location = /^(?:L)?(\d+)(?:(?:C|:)(\d+))?(?:-(?:L)?(\d+))?$/i.exec(fragment);
  const suffix = /:(\d+)(?::(\d+))?$/.exec(href);
  const line = location?.[1] ?? suffix?.[1];
  const column = location?.[2] ?? suffix?.[2];
  if (suffix) href = href.slice(0, suffix.index);
  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      href = (url.hostname && url.hostname !== 'localhost' ? '\\\\' + url.hostname : '') + decode(url.pathname);
    } catch { return { kind: 'blocked' }; }
  } else href = decode(href);
  if (/^\/[a-z]:[\\/]/i.test(href)) href = href.slice(1);
  if (/[\u0000-\u001f\u007f]/.test(href)) return { kind: 'blocked' };
  const windows = drive.test(href) || href.startsWith('\\\\') || platform === 'win32';
  let path = href.replace(/\\/g, '/');
  const base = cwd.replace(/\\/g, '/');
  if (!drive.test(path) && !path.startsWith('//')) {
    if (path.startsWith('/')) { if (windows && drive.test(base)) path = base.slice(0, 2) + path; }
    else { if (!base) return { kind: 'blocked' }; path = base.replace(/\/+$/, '') + '/' + path; }
  }
  const root = /^([a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i.exec(path)?.[0];
  if (!root) return { kind: 'blocked' };
  const parts: string[] = [];
  for (const part of path.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  path = root.replace(/\/?$/, '/') + parts.join('/');
  if (windows) path = path.replace(/\//g, '\\');
  return { kind: 'file', path, ...(line ? { line: Math.max(1, Number(line)) } : {}), ...(column ? { column: Math.max(1, Number(column)) } : {}), ...(location?.[3] ? { endLine: Number(location[3]) } : {}) };
}

/** Windows drive letters are paths, not URI schemes. Never allow active-content URLs. */
export function markdownUrl(url: string): string {
  const target=linkTarget(url,'/project','linux');
  if(target.kind==='blocked')return '';
  return target.kind==='file'&&!drive.test(url)&&!/^file:/i.test(url)?url.replace(/^([^/\\:]+):/,'$1%3A'):url;
}
export const headingSlug = (text: string) => text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');

// Renderer-side cache of the project file index (fs:index) + fuzzy ranking for @-mentions.

export interface IndexEntry {
  /** Relative path with '/' separators; directories end with '/'. */
  path: string;
  lower: string;
  /** Basename without the trailing '/'. */
  base: string;
  baseLower: string;
  /** Parent directory ('' for top level), ending with '/'. */
  parent: string;
  dir: boolean;
}

interface IndexResult {
  entries: string[];
  git: boolean;
  truncated: boolean;
}

const TTL = 30_000;
const cache = new Map<string, { ts: number; entries: IndexEntry[]; pending?: Promise<IndexEntry[]> }>();

function prepare(paths: string[]): IndexEntry[] {
  return paths.map((path) => {
    const dir = path.endsWith('/');
    const trimmed = dir ? path.slice(0, -1) : path;
    const slash = trimmed.lastIndexOf('/');
    const base = trimmed.slice(slash + 1);
    return { path, lower: path.toLowerCase(), base, baseLower: base.toLowerCase(), parent: trimmed.slice(0, slash + 1), dir };
  });
}

/** Cached entries for cwd (possibly stale), or null when never loaded. */
export function cachedIndex(cwd: string): IndexEntry[] | null {
  return cache.get(cwd)?.entries ?? null;
}

/** Returns the index, refetching when the cached copy is older than 30s. */
export function loadIndex(cwd: string): Promise<IndexEntry[]> {
  const hit = cache.get(cwd);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.ts < TTL) return Promise.resolve(hit.entries);
  const pending = window.desk
    .call<IndexResult>('fs:index', cwd)
    .then((r) => {
      const entries = prepare(r?.entries ?? []);
      cache.set(cwd, { ts: Date.now(), entries });
      return entries;
    })
    .catch(() => {
      const prev = cache.get(cwd);
      cache.set(cwd, { ts: Date.now(), entries: prev?.entries ?? [] });
      return prev?.entries ?? [];
    });
  cache.set(cwd, { ts: hit?.ts ?? 0, entries: hit?.entries ?? [], pending });
  return pending;
}

const BOUNDARY = new Set(['/', '.', '-', '_', ' ']);

/** Greedy subsequence match; null when `q` is not a subsequence of `s`. Rewards word starts and runs. */
function fuzzyScore(q: string, s: string): number | null {
  let score = 0;
  let from = 0;
  let prev = -2;
  for (let j = 0; j < q.length; j++) {
    const i = s.indexOf(q[j], from);
    if (i < 0) return null;
    if (i === prev + 1) score += 3;
    if (i === 0 || BOUNDARY.has(s[i - 1])) score += 4;
    score -= Math.min(i - from, 8) * 0.25;
    prev = i;
    from = i + 1;
  }
  return score;
}

/** Fuzzy subsequence match on the relative path; basename hits rank first, then shorter paths. */
export function rankEntries(entries: IndexEntry[], query: string, limit = 50): IndexEntry[] {
  const q = query.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
  // tier: 0 exact, 1 basename prefix, 2 basename substring, 3 path substring, 4 fuzzy (ordered by score).
  const scored: { e: IndexEntry; tier: number; score: number }[] = [];
  for (const e of entries) {
    let tier = 4;
    let score = 0;
    if (!q || e.baseLower === q || e.lower === q) tier = 0;
    else if (e.baseLower.startsWith(q)) tier = 1;
    else if (e.baseLower.includes(q)) tier = 2;
    else if (e.lower.includes(q)) tier = 3;
    else {
      const sb = fuzzyScore(q, e.baseLower);
      const sp = fuzzyScore(q, e.lower);
      if (sp === null) continue;
      score = Math.max(sp, sb === null ? -Infinity : sb + 4);
    }
    scored.push({ e, tier, score });
  }
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score || a.e.path.length - b.e.path.length || (a.e.path < b.e.path ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.e);
}

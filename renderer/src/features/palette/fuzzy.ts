/** Fuzzy subsequence matching with word-start / consecutive bonuses (fzf-like, O(query × text)). */
import enPalette from '../../i18n/locales/en/palette.json';
import ruPalette from '../../i18n/locales/ru/palette.json';

export interface FuzzyMatch {
  score: number;
  /** Matched character indices in the original text. */
  pos: number[];
}

const WORD = /[\p{L}\p{N}]/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;

const BONUS_START = 10;
const BONUS_WORD = 8;
const BONUS_CAMEL = 6;
const BONUS_CONSEC = 5;
const GAP = 0.6;
const LEAD = 0.15;
const NEG = -1e9;

// Cyrillic yo (U+0451) folds to ye (U+0435).
// Cyrillic yo (U+0451) folds to ye (U+0435).
export const normalize = (s: string) => s.toLowerCase().replace(/\u0451/g, '\u0435');

/** Best alignment of one query word inside the text; null when it is not a subsequence. */
function matchWord(q: string, raw: string, t: string): FuzzyMatch | null {
  const m = q.length;
  const n = t.length;
  if (!m) return { score: 0, pos: [] };
  if (m > n) return null;
  let k = 0;
  for (let j = 0; j < n && k < m; j++) if (t[j] === q[k]) k++;
  if (k < m) return null;

  const bonus = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const c = raw[j];
    const prev = j ? raw[j - 1] : '';
    if (j === 0) bonus[j] = BONUS_START;
    else if (!WORD.test(prev) && WORD.test(c)) bonus[j] = BONUS_WORD;
    else if (LOWER.test(prev) && UPPER.test(c)) bonus[j] = BONUS_CAMEL;
  }

  let prev = new Float64Array(n).fill(NEG);
  const back: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(NEG);
    const bk = new Int32Array(n).fill(-1);
    // Running max of prev[k] + GAP·k over k ≤ j-2 (linear gap penalty in O(1) per cell).
    let best = NEG;
    let bestK = -1;
    for (let j = i; j < n; j++) {
      if (i > 0 && j >= 2) {
        const v = prev[j - 2] + GAP * (j - 2);
        if (v > best) {
          best = v;
          bestK = j - 2;
        }
      }
      if (t[j] !== q[i]) continue;
      const base = 1 + bonus[j];
      if (i === 0) {
        row[j] = base - LEAD * Math.min(j, 20);
        continue;
      }
      let s = NEG;
      let from = -1;
      if (prev[j - 1] > NEG / 2) {
        s = prev[j - 1] + base + BONUS_CONSEC;
        from = j - 1;
      }
      if (bestK >= 0 && best > NEG / 2) {
        const v = best - GAP * (j - 1) + base;
        if (v > s) {
          s = v;
          from = bestK;
        }
      }
      row[j] = s;
      bk[j] = from;
    }
    back.push(bk);
    prev = row;
  }

  let end = -1;
  let score = NEG;
  for (let j = 0; j < n; j++) {
    if (prev[j] > score) {
      score = prev[j];
      end = j;
    }
  }
  if (end < 0 || score <= NEG / 2) return null;
  const pos: number[] = new Array(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    pos[i] = j;
    j = back[i][j];
  }
  return { score, pos };
}

/**
 * Matches every whitespace-separated query word against `text` (highlighted) or, failing that, `extra`
 * (searchable but not shown, e.g. path or English synonyms). Null if any word matches nowhere.
 */
export function fuzzy(query: string, text: string, extra = ''): FuzzyMatch | null {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, pos: [] };
  const tn = normalize(text);
  const raw = tn.length === text.length ? text : tn;
  const en = normalize(extra);
  const rawExtra = en.length === extra.length ? extra : en;
  let score = 0;
  const pos = new Set<number>();
  for (const w of words) {
    const a = matchWord(w, raw, tn);
    if (a) {
      score += a.score;
      for (const p of a.pos) pos.add(p);
      continue;
    }
    const b = en ? matchWord(w, rawExtra, en) : null;
    if (!b) return null;
    score += b.score * 0.6;
  }
  const whole = normalize(query.trim());
  if (tn.startsWith(whole)) score += 6;
  else if (tn.includes(whole)) score += 3;
  // Among equal matches the shorter text is the closer one.
  score -= Math.min(tn.length, 120) * 0.02;
  return { score, pos: [...pos].sort((x, y) => x - y) };
}

// Keyboard rows of the two layouts, key for key (the Russian row lives in the ru dictionary).
const EN = enPalette.layout;
const RU = ruPalette.layout;
const EN_RU = new Map([...EN].map((c, i) => [c, RU[i]]));
const RU_EN = new Map([...RU].map((c, i) => [c, EN[i]]));

/** The query retyped in the other keyboard layout (Latin keys typed on the Russian layout and vice versa); null if nothing changes. */
export function swapLayout(q: string): string | null {
  const lower = q.toLowerCase();
  const latin = (lower.match(/[a-z]/g) ?? []).length;
  const cyr = (lower.match(/[\u0430-\u044f\u0451]/g) ?? []).length;
  if (!latin && !cyr) return null;
  const map = latin >= cyr ? EN_RU : RU_EN;
  const out = [...lower].map((c) => map.get(c) ?? c).join('');
  return out === lower ? null : out;
}

/** Best of the query as typed and the query in the other keyboard layout. */
export function fuzzyAny(query: string, text: string, extra = ''): FuzzyMatch | null {
  const a = fuzzy(query, text, extra);
  const swapped = swapLayout(query);
  const b = swapped ? fuzzy(swapped, text, extra) : null;
  if (b) b.score *= 0.9;
  if (a && b) return b.score > a.score ? b : a;
  return a ?? b;
}

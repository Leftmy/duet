// Full-text search across all Claude Code transcripts (~/.claude/projects/<project>/<sessionId>.jsonl).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { t as tr } from '../i18n.mjs';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const MAX_TEXT = 2000;
const PER_SESSION = 3;
const SKIP_PREFIXES = ['<local-command', '<system-reminder>', 'Caveat:', '<command-', '<task-notification>', 'This session is being continued', '[Request interrupted'];

// Byte patterns used to reject lines before decoding / JSON.parse.
const B = (s) => Buffer.from(s);
const P_TEXT_BLOCK = B('"type":"text"');
const P_USER_STRING = B('"role":"user","content":"');
const P_TOOL_RESULT = B('"tool_use_id"');
const P_SIDECHAIN = B('"isSidechain":true');
const P_META = B('"isMeta":true');
const P_COMPACT = B('"isCompactSummary":true');
const P_CUSTOM_TITLE = B('"customTitle"');
const P_AI_TITLE = B('"aiTitle"');
const P_CWD = B('"cwd":"');

/** sessionId -> { file, size, mtime, offset, cwd, title, customTitle, aiTitle, firstUser, lastTs, msgs: [{ uuid, role, text, lc, ts }] } */
const sessions = new Map();
let refreshing = null;
let dirty = false;

const tick = () => new Promise((r) => setImmediate(r));

function cleanUserText(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'tool_result') return '';
      if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
    }
  }
  text = text.trim();
  if (!text || SKIP_PREFIXES.some((p) => text.startsWith(p))) return '';
  return text;
}

function assistantText(content) {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
  return text.trim();
}

function addMsg(s, uuid, role, text, ts) {
  const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  s.msgs.push({ uuid, role, text: t, lc: t.toLowerCase(), ts });
  if (ts > s.lastTs) s.lastTs = ts;
}

function readCwd(line) {
  const i = line.indexOf(P_CWD);
  if (i < 0) return '';
  const m = line.toString('utf8', i, Math.min(line.length, i + 2000)).match(/^"cwd":"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return '';
  }
}

/** Handles one raw line; returns true if it was JSON-parsed (for yield pacing). */
function processLine(s, line) {
  if (line.length < 40) return false;
  // Rename / auto-title records are tiny.
  if (line.length < 4096) {
    if (line.indexOf(P_CUSTOM_TITLE) >= 0 || line.indexOf(P_AI_TITLE) >= 0) {
      try {
        const o = JSON.parse(line.toString('utf8'));
        if (o.type === 'custom-title' && o.customTitle) s.customTitle = String(o.customTitle);
        else if (o.type === 'ai-title' && o.aiTitle) s.aiTitle = String(o.aiTitle);
      } catch {}
      return true;
    }
  }
  if (!s.cwd) s.cwd = readCwd(line);
  if (line.indexOf(P_TEXT_BLOCK) < 0 && line.indexOf(P_USER_STRING) < 0) return false;
  if (line.indexOf(P_TOOL_RESULT) >= 0 || line.indexOf(P_SIDECHAIN) >= 0 || line.indexOf(P_META) >= 0 || line.indexOf(P_COMPACT) >= 0)
    return false;
  let o;
  try {
    o = JSON.parse(line.toString('utf8'));
  } catch {
    return true;
  }
  if (!o?.uuid || !o.message) return true;
  if (o.cwd && !s.cwd) s.cwd = o.cwd;
  const ts = Date.parse(o.timestamp) || 0;
  if (o.type === 'user') {
    const text = cleanUserText(o.message.content);
    if (!text) return true;
    if (!s.firstUser) s.firstUser = text.replace(/\s+/g, ' ').slice(0, 80);
    addMsg(s, o.uuid, 'user', text, ts);
  } else if (o.type === 'assistant') {
    const text = assistantText(o.message.content);
    if (text) addMsg(s, o.uuid, 'assistant', text, ts);
  }
  return true;
}

/** Streams the file from s.offset, splitting on '\n' at byte level so huge tool lines are never decoded. */
async function readFrom(s) {
  const stream = fs.createReadStream(s.file, { start: s.offset, highWaterMark: 1 << 20 });
  let pending = [];
  let pendingLen = 0;
  let pos = s.offset;
  let parsed = 0;
  for await (const chunk of stream) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(10, start)) >= 0) {
      let line = chunk.subarray(start, nl);
      if (pendingLen) {
        line = Buffer.concat([...pending, line], pendingLen + line.length);
        pending = [];
        pendingLen = 0;
      }
      pos += nl - start + 1;
      s.offset = pos;
      start = nl + 1;
      if (processLine(s, line) && ++parsed % 200 === 0) await tick();
    }
    if (start < chunk.length) {
      pending.push(chunk.subarray(start));
      pendingLen += chunk.length - start;
      pos += chunk.length - start;
    }
  }
  // A trailing line without '\n' may still be written; it is picked up on the next refresh.
}

function freshSession(file, sessionId) {
  return { sessionId, file, size: 0, mtime: 0, offset: 0, cwd: '', customTitle: '', aiTitle: '', firstUser: '', lastTs: 0, msgs: [] };
}

async function listFiles() {
  const out = [];
  let dirs = [];
  try {
    dirs = await fsp.readdir(ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(ROOT, d.name);
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(dir, e.name));
  }
  return out;
}

async function refresh(emit) {
  const files = await listFiles();
  const seen = new Set();
  const work = [];
  for (const file of files) {
    const sessionId = path.basename(file, '.jsonl');
    seen.add(sessionId);
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      continue;
    }
    const prev = sessions.get(sessionId);
    if (prev && prev.file === file && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
    work.push({ file, sessionId, st, prev });
  }
  for (const id of sessions.keys()) if (!seen.has(id)) sessions.delete(id);
  if (!work.length) return;

  const total = work.length;
  const showProgress = total > 3;
  let lastEmit = 0;
  for (let i = 0; i < work.length; i++) {
    const { file, sessionId, st, prev } = work[i];
    // Append-only growth: continue from the last complete line; otherwise rebuild this session.
    const s = prev && prev.file === file && st.size >= prev.offset ? prev : freshSession(file, sessionId);
    try {
      await readFrom(s);
      s.size = st.size;
      s.mtime = st.mtimeMs;
      sessions.set(sessionId, s);
    } catch (e) {
      console.error('[search] read failed', file, e?.message ?? e);
    }
    const now = Date.now();
    if (showProgress && (now - lastEmit > 120 || i === total - 1)) {
      lastEmit = now;
      emit('search:progress', { done: i + 1, total });
    }
  }
}

function ensureFresh(emit) {
  if (refreshing) {
    dirty = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      do {
        dirty = false;
        await refresh(emit);
      } while (dirty);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function countOcc(hay, needle, cap) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0 && n < cap) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function makeSnippet(text, lc, words) {
  let at = -1;
  let len = 0;
  for (const w of words) {
    const i = lc.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = w.length;
    }
  }
  if (at < 0) at = 0;
  const from = Math.max(0, at - 80);
  const to = Math.min(text.length, at + len + 80);
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return (from > 0 ? '…' : '') + body + (to < text.length ? '…' : '');
}

function titleOf(s) {
  return s.customTitle || s.aiTitle || s.firstUser || tr('search.untitled');
}

function runQuery(q, limit) {
  const words = [...new Set(String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean))];
  if (!words.length) return [];
  const now = Date.now();
  const hits = [];
  for (const s of sessions.values()) {
    const local = [];
    for (const m of s.msgs) {
      let count = 0;
      let ok = true;
      for (const w of words) {
        const c = countOcc(m.lc, w, 10);
        if (!c) {
          ok = false;
          break;
        }
        count += c;
      }
      if (!ok) continue;
      const ageDays = Math.max(0, (now - (m.ts || 0)) / 86400000);
      const score = Math.min(count, 12) + 6 * Math.exp(-ageDays / 21) + (m.role === 'user' ? 0.5 : 0);
      local.push({ m, score });
    }
    if (!local.length) continue;
    local.sort((a, b) => b.score - a.score);
    const title = titleOf(s);
    for (const { m, score } of local.slice(0, PER_SESSION)) {
      hits.push({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title,
        uuid: m.uuid,
        role: m.role,
        snippet: makeSnippet(m.text, m.lc, words),
        ts: m.ts || s.lastTs,
        score: Math.round(score * 100) / 100,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return hits.slice(0, limit);
}

export function register(ctx) {
  const emit = (ch, p) => {
    try {
      ctx.emit(ch, p);
    } catch {}
  };
  ctx.handle('search:query', async (opts = {}) => {
    const { q = '', limit = 60 } = opts ?? {};
    await ensureFresh(emit);
    return runQuery(q, Math.max(1, Math.min(500, Number(limit) || 60)));
  });
  ctx.handle('search:reindex', async () => {
    if (refreshing) await refreshing.catch(() => {});
    sessions.clear();
    await ensureFresh(emit);
    let messages = 0;
    for (const s of sessions.values()) messages += s.msgs.length;
    return { sessions: sessions.size, messages };
  });
}

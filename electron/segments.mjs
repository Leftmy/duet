// Transcript segments before in-file context compactions.
// Claude Code keeps compacting inside one .jsonl: each compact_boundary starts a new chain
// (parentUuid null) and points back via logicalParentUuid. The SDK returns only the last chain;
// this module exposes the earlier ones so the app can show them as previous parts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectsDir = path.join(os.homedir(), '.claude', 'projects');
const encode = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** The session's .jsonl file, or null. */
export function findFile(sessionId, cwd) {
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const p = path.join(projectsDir, encode(cwd), name);
    if (fs.existsSync(p)) return p;
  }
  for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = path.join(projectsDir, d.name, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let cache = null; // { file, mtimeMs, size, index }

async function indexFile(file) {
  const st = await fs.promises.stat(file);
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.index;
  const text = await fs.promises.readFile(file, 'utf8');
  const nodes = new Map(); // uuid -> { parent, line }
  const boundaries = [];
  let start = 0;
  let idx = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    idx++;
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o.uuid) continue;
    if (o.type === 'system' && o.subtype === 'compact_boundary' && !o.isSidechain) {
      boundaries.push({ uuid: o.uuid, logicalParentUuid: o.logicalParentUuid, ts: o.timestamp, idx });
      nodes.set(o.uuid, { parent: null, boundary: true });
      continue;
    }
    const keep = (o.type === 'user' || o.type === 'assistant') && !o.isSidechain;
    nodes.set(o.uuid, {
      idx,
      parent: o.parentUuid ?? null,
      msg: keep
        ? {
            type: o.type,
            uuid: o.uuid,
            session_id: o.sessionId,
            message: o.message,
            parent_tool_use_id: null,
            ...(o.isCompactSummary ? { isCompactSummary: true } : {}),
            ...(o.isMeta ? { is_meta: true } : {}),
            timestamp: o.timestamp,
          }
        : null,
    });
  }
  const index = { nodes, boundaries };
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, index };
  return index;
}

function walk(nodes, leaf) {
  const out = [];
  const seen = new Set();
  for (let u = leaf; u && !seen.has(u); ) {
    seen.add(u);
    const n = nodes.get(u);
    if (!n || n.boundary) break;
    if (n.msg) out.push(n.msg);
    u = n.parent;
  }
  return out.reverse();
}

/** Earlier segments of a session file, newest first: [{ segment, count, ts }]. */
export async function listSegments(sessionId, cwd) {
  const file = findFile(sessionId, cwd);
  if (!file) return [];
  const { nodes, boundaries } = await indexFile(file);
  const out = [];
  boundaries.forEach((b, i) => {
    // Continuation files start with a boundary pointing into the parent session; skip those.
    const parent = b.logicalParentUuid && nodes.get(b.logicalParentUuid);
    if (!parent || parent.boundary || parent.idx > b.idx) return;
    const count = walk(nodes, b.logicalParentUuid).length;
    if (count) out.push({ segment: i, count, ts: b.ts });
  });
  return out.reverse();
}

/** Messages of one earlier segment, in the SDK's SessionMessage shape. */
export async function loadSegment(sessionId, cwd, segment) {
  const file = findFile(sessionId, cwd);
  if (!file) return [];
  const { nodes, boundaries } = await indexFile(file);
  const b = boundaries[segment];
  return b?.logicalParentUuid ? walk(nodes, b.logicalParentUuid) : [];
}

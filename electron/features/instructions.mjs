// Editor backend for Claude Code instructions (CLAUDE.md), settings/hooks and per-project memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n.mjs';

const MAX_READ = 2 * 1024 * 1024;
const HOOK_SOURCES = ['user', 'project', 'local'];

const claudeHome = () => path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(claudeHome(), 'projects');
const norm = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** Claude Code stores per-project data under ~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>. */
export function encodeProject(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function memoryDir(cwd) {
  const enc = encodeProject(cwd);
  const exact = path.join(projectsDir(), enc, 'memory');
  if (fs.existsSync(exact) || enc.length <= 200) return exact;
  // Very long paths may be shortened with a suffix; fall back to a prefix match.
  try {
    const hit = fs.readdirSync(projectsDir()).find((d) => d.startsWith(enc.slice(0, 200)));
    if (hit) return path.join(projectsDir(), hit, 'memory');
  } catch {}
  return exact;
}

function settingsPaths(cwd) {
  const out = { user: path.join(claudeHome(), 'settings.json') };
  if (cwd) {
    out.project = path.join(cwd, '.claude', 'settings.json');
    out.local = path.join(cwd, '.claude', 'settings.local.json');
  }
  return out;
}

function doc(group, label, file) {
  let st = null;
  try {
    st = fs.statSync(file);
    if (!st.isFile()) st = null;
  } catch {}
  return {
    id: file,
    group,
    label,
    path: file,
    exists: !!st,
    kind: file.toLowerCase().endsWith('.json') ? 'json' : 'md',
    size: st ? st.size : 0,
  };
}

export function listDocs(cwd) {
  const home = claudeHome();
  const docs = [
    doc('global', t('instructions.doc.globalInstructions'), path.join(home, 'CLAUDE.md')),
    doc('global', t('instructions.doc.userSettings'), path.join(home, 'settings.json')),
  ];
  if (!cwd) return docs;
  docs.push(
    doc('project', t('instructions.doc.projectInstructions'), path.join(cwd, 'CLAUDE.md')),
    doc('project', t('instructions.doc.projectLocalInstructions'), path.join(cwd, 'CLAUDE.local.md')),
    doc('project', t('instructions.doc.projectSettings'), path.join(cwd, '.claude', 'settings.json')),
    doc('project', t('instructions.doc.projectLocalSettings'), path.join(cwd, '.claude', 'settings.local.json')),
  );
  const mem = memoryDir(cwd);
  let names = [];
  try {
    names = fs
      .readdirSync(mem, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name);
  } catch {}
  names.sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)));
  for (const n of names) docs.push(doc('memory', n === 'MEMORY.md' ? t('instructions.doc.memoryIndex') : n.replace(/\.md$/i, ''), path.join(mem, n)));
  return docs;
}

/** Only files that listDocs could return for some project are readable/writable. */
export function isAllowed(file) {
  if (typeof file !== 'string' || !file || !path.isAbsolute(file)) return false;
  const p = norm(file);
  if (p === norm(path.join(claudeHome(), 'CLAUDE.md')) || p === norm(path.join(claudeHome(), 'settings.json'))) return true;
  const base = path.basename(file);
  const parent = path.basename(path.dirname(file));
  if (base === 'CLAUDE.md' || base === 'CLAUDE.local.md') return true;
  if ((base === 'settings.json' || base === 'settings.local.json') && parent === '.claude') return true;
  // ~/.claude/projects/<encoded>/memory/<name>.md
  const dir = path.dirname(p);
  const projects = norm(projectsDir());
  if (base.toLowerCase().endsWith('.md') && path.basename(dir) === 'memory' && path.dirname(path.dirname(dir)) === projects) return true;
  return false;
}

function assertAllowed(file) {
  if (!isAllowed(file)) throw new Error(t('instructions.notAllowed'));
}

export function readDoc(file) {
  assertAllowed(file);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { text: '', exists: false };
  }
  if (!st.isFile()) throw new Error(t('instructions.notAFile'));
  if (st.size > MAX_READ) throw new Error(t('instructions.tooLarge'));
  return { text: fs.readFileSync(file, 'utf8'), exists: true };
}

/** JSON.parse with a localized error that carries the line number. */
export function validateJson(text) {
  try {
    JSON.parse(text);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const m = /position (\d+)/.exec(msg);
    const pos = m ? Number(m[1]) : text.length;
    const line = text.slice(0, pos).split('\n').length;
    const clean = msg.replace(/\s*\(line \d+ column \d+\)/, '').replace(/\s*in JSON at position \d+/, '');
    throw new Error(t('instructions.invalidJson', { error: clean, line }));
  }
}

/** Unchecked write: validates JSON, keeps a .bak copy of the previous version, creates folders. */
export function writeFile(file, text) {
  if (typeof text !== 'string') throw new Error(t('instructions.emptyContent'));
  if (file.toLowerCase().endsWith('.json')) validateJson(text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, text, 'utf8');
  return { ok: true, size: fs.statSync(file).size };
}

export function writeDoc(file, text) {
  assertAllowed(file);
  return writeFile(file, text);
}

export function parseHooks(json, source) {
  const out = [];
  const hooks = json && typeof json === 'object' ? json.hooks : null;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const list = Array.isArray(g.hooks) ? g.hooks : [];
      const commands = list
        .map((h) => (h?.type === 'command' || h?.command ? String(h.command ?? '') : h?.type ? `[${h.type}] ${h.prompt ?? h.url ?? ''}`.trim() : ''))
        .filter(Boolean);
      out.push({ source, event, matcher: typeof g.matcher === 'string' ? g.matcher : '', commands });
    }
  }
  return out;
}

export function hooksSummary(cwd) {
  const files = settingsPaths(cwd);
  const out = [];
  for (const source of HOOK_SOURCES) {
    const file = files[source];
    if (!file || !fs.existsSync(file)) continue;
    try {
      for (const h of parseHooks(JSON.parse(fs.readFileSync(file, 'utf8')), source)) out.push({ ...h, file });
    } catch {
      out.push({ source, file, event: '', matcher: '', commands: [], error: t('instructions.hooksInvalidJson') });
    }
  }
  return out;
}

export function register(ctx) {
  ctx.handle('instr:list', (cwd) => listDocs(cwd || null));
  ctx.handle('instr:read', (file) => readDoc(file));
  ctx.handle('instr:write', (file, text) => writeDoc(file, text));
  ctx.handle('instr:hooksSummary', (cwd) => hooksSummary(cwd || null));
}

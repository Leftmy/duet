// Editor backend for agents' custom slash commands and skills, user scope (~/.<agent>) and project scope (<cwd>/.<agent>).
// Claude Code: .claude/commands/**/*.md and .claude/skills/<name>/SKILL.md. Codex: ~/.codex/prompts/*.md (user
// scope only) and .codex/skills/<name>/SKILL.md. Deleted items are moved to ~/.<agent>/.desk-trash.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n.mjs';

const MAX_READ = 1024 * 1024;
const MAX_DEPTH = 5;
const SEG_RE = /^[a-z0-9_-]{1,64}$/;
const SKILL_FILE = 'SKILL.md';
const BOM_RE = new RegExp('^' + String.fromCharCode(0xfeff));

const isWin = process.platform === 'win32';
const norm = (p) => {
  const r = path.resolve(p);
  return isWin ? r.toLowerCase() : r;
};
/** True when `child` is strictly inside `parent` (lexically, after resolving `..`). */
const inside = (parent, child) => {
  const rel = path.relative(norm(parent), norm(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Minimal YAML front matter reader: `key: value`, quoted values, `key: |`/`>` blocks and `- item` lists (joined by ", "). */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(BOM_RE, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    const block = [];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || /^[ \t]*$/.test(lines[i + 1]) || /^-[ \t]/.test(lines[i + 1]))) {
      if (/^-[ \t]/.test(lines[i + 1]) && val && !/^[|>]/.test(val)) break;
      block.push(lines[++i]);
    }
    if (/^[|>][+-]?$/.test(val)) {
      const parts = block.map((l) => l.trim());
      val = val[0] === '>' ? parts.filter(Boolean).join(' ') : parts.join('\n').trim();
    } else if (!val && block.some((l) => /^[ \t]*-[ \t]/.test(l))) {
      val = block
        .map((l) => /^[ \t]*-[ \t]+(.*)$/.exec(l)?.[1]?.trim())
        .filter(Boolean)
        .map(unquote)
        .join(', ');
    } else {
      if (block.length && !/^["']/.test(val)) val = [val, ...block.map((l) => l.trim())].filter(Boolean).join(' ');
      val = /^\[.*\]$/.test(val) ? val.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean).join(', ') : unquote(val);
    }
    data[key] = val;
  }
  return { data, body: src.slice(m[0].length) };
}

function unquote(v) {
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Description as Claude Code shows it: front matter `description`, else the first non-empty body line. */
function describe(text) {
  const { data, body } = parseFrontmatter(text);
  let description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) {
    const line = body.split(/\r?\n/).find((l) => l.trim()) ?? '';
    description = line.replace(/^#+\s*/, '').trim();
    if (description.length > 120) description = description.slice(0, 117) + '…';
  }
  return { description, argumentHint: data['argument-hint'] ? String(data['argument-hint']) : '', model: data.model ?? '', name: data.name ?? '' };
}

function readHead(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return '';
    if (st.size <= 64 * 1024) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function moveSync(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e?.code !== 'EXDEV' && e?.code !== 'EPERM') throw e;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Removes empty folders from `dir` up to (not including) `stop`. */
function pruneEmpty(dir, stop) {
  let d = dir;
  while (inside(stop, d)) {
    try {
      if (fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}

export function validateName(kind, name) {
  if (typeof name !== 'string' || !name) throw new Error(t('commands.nameRequired'));
  const segs = name.split(':');
  if (kind === 'skill' && segs.length > 1) throw new Error(t('commands.skillNameColon'));
  if (segs.length > MAX_DEPTH) throw new Error(t('commands.tooDeep'));
  for (const s of segs) {
    if (!SEG_RE.test(s)) throw new Error(t('commands.nameChars'));
  }
  // commands/**/skill.md is treated specially by Claude Code (SKILL.md matching is case-insensitive).
  if (kind === 'command' && segs.at(-1) === 'skill') throw new Error(t('commands.nameReserved'));
  return segs;
}

/** Where each agent keeps them: config folder name, commands folder, and whether projects can have commands. */
const LAYOUTS = {
  claude: { dir: '.claude', commands: 'commands', projectCommands: true },
  codex: { dir: '.codex', commands: 'prompts', projectCommands: false },
};

/** All operations bound to a home directory and an agent (injectable for tests). */
export function createCommandsApi({ home = os.homedir(), agent = 'claude' } = {}) {
  const layout = LAYOUTS[agent] ?? LAYOUTS.claude;
  const claudeHome = path.join(home, layout.dir);
  const trashDir = path.join(claudeHome, '.desk-trash');

  const projectBase = (cwd) => {
    if (!cwd) return null;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error(t('commands.badProjectFolder'));
    // A project opened at the home folder shares the user scope folder.
    if (norm(cwd) === norm(home)) return null;
    return path.join(path.resolve(cwd), layout.dir);
  };

  const roots = (cwd) => {
    const out = { user: { commands: path.join(claudeHome, layout.commands), skills: path.join(claudeHome, 'skills') } };
    const pb = projectBase(cwd);
    if (pb) out.project = { commands: layout.projectCommands ? path.join(pb, layout.commands) : null, skills: path.join(pb, 'skills') };
    return out;
  };

  /** Finds which scope/kind root contains `file`; throws when it is not a command .md or a skill SKILL.md. */
  function locate(file, cwd) {
    if (typeof file !== 'string' || !file || !path.isAbsolute(file)) throw new Error(t('commands.badPath'));
    if (file.split(/[\\/]/).includes('..')) throw new Error(t('commands.badPath'));
    const r = roots(cwd || null);
    for (const scope of ['user', 'project']) {
      if (!r[scope]) continue;
      const cRoot = r[scope].commands;
      if (cRoot && inside(cRoot, file)) {
        const rel = path.relative(cRoot, path.resolve(file)).split(/[\\/]/);
        if (rel.length > MAX_DEPTH || !/\.md$/i.test(rel.at(-1)) || /^skill\.md$/i.test(rel.at(-1))) break;
        if (rel.some((s) => s.startsWith('.'))) break;
        return { scope, kind: 'command', root: cRoot, name: rel.join(':').replace(/\.md$/i, ''), item: path.resolve(file) };
      }
      const sRoot = r[scope].skills;
      if (inside(sRoot, file)) {
        const rel = path.relative(sRoot, path.resolve(file)).split(/[\\/]/);
        if (rel.length !== 2 || rel[1] !== SKILL_FILE || rel[0].startsWith('.')) break;
        return { scope, kind: 'skill', root: sRoot, name: rel[0], item: path.join(sRoot, rel[0]) };
      }
    }
    throw new Error(t('commands.outsideRoots'));
  }

  function entry(scope, kind, name, file) {
    const d = describe(readHead(file));
    return { scope, kind, name, path: file, description: d.description, argumentHint: d.argumentHint };
  }

  function listCommands(scope, root) {
    const out = [];
    const walk = (dir, segs) => {
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory() || (e.isSymbolicLink() && safeIsDir(full))) {
          if (segs.length + 1 < MAX_DEPTH) walk(full, [...segs, e.name]);
        } else if (/\.md$/i.test(e.name) && !/^skill\.md$/i.test(e.name)) {
          out.push(entry(scope, 'command', [...segs, e.name.replace(/\.md$/i, '')].join(':'), full));
        }
      }
    };
    walk(root, []);
    return out;
  }

  function listSkills(scope, root) {
    const out = [];
    let ents = [];
    try {
      ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      if (!(e.isDirectory() || (e.isSymbolicLink() && safeIsDir(dir)))) continue;
      const file = path.join(dir, SKILL_FILE);
      if (fs.existsSync(file)) out.push(entry(scope, 'skill', e.name, file));
    }
    return out;
  }

  function list(cwd) {
    const r = roots(cwd || null);
    const out = [];
    for (const scope of ['user', 'project']) {
      if (!r[scope]) continue;
      out.push(...(r[scope].commands ? listCommands(scope, r[scope].commands) : []), ...listSkills(scope, r[scope].skills));
    }
    const order = { user: 0, project: 1 };
    return out.sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name));
  }

  function read(file, cwd) {
    const loc = locate(file, cwd);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw new Error(t('commands.notFound'));
    }
    if (!st.isFile()) throw new Error(t('commands.notAFile'));
    if (st.size > MAX_READ) throw new Error(t('commands.tooLargeRead'));
    const text = fs.readFileSync(file, 'utf8');
    return { text, scope: loc.scope, kind: loc.kind, name: loc.name, path: path.resolve(file), ...describe(text) };
  }

  function targetFor(scope, kind, name, cwd) {
    const r = roots(cwd || null);
    if (scope !== 'user' && scope !== 'project') throw new Error(t('commands.badScope'));
    if (kind !== 'command' && kind !== 'skill') throw new Error(t('commands.badKind'));
    if (scope === 'project' && !r.project) throw new Error(t(cwd ? 'commands.projectIsHome' : 'commands.noProject'));
    const segs = validateName(kind, name);
    if (kind === 'command') {
      const root = r[scope].commands;
      if (!root) throw new Error(t('commands.noProjectCommands'));
      return { root, file: path.join(root, ...segs.slice(0, -1), segs.at(-1) + '.md') };
    }
    const root = r[scope].skills;
    return { root, file: path.join(root, segs[0], SKILL_FILE) };
  }

  /**
   * Create: `{ scope, kind, name, cwd?, text }` (fails if it already exists unless `overwrite`).
   * Update: `{ path, cwd?, text }` (the file must already be a command/skill).
   */
  function write(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (typeof o.text !== 'string') throw new Error(t('commands.emptyContent'));
    if (Buffer.byteLength(o.text) > MAX_READ) throw new Error(t('commands.tooLarge'));
    let file;
    let created = false;
    if (o.path) {
      locate(o.path, o.cwd);
      file = path.resolve(o.path);
      if (!fs.existsSync(file)) throw new Error(t('commands.notFoundDeleted'));
    } else {
      const tgt = targetFor(o.scope, o.kind, o.name, o.cwd);
      file = tgt.file;
      const exists = fs.existsSync(o.kind === 'skill' ? path.dirname(file) : file);
      if (exists && !o.overwrite) throw new Error(t(o.kind === 'skill' ? 'commands.skillExists' : 'commands.commandExists', { name: o.name }));
      created = !fs.existsSync(file);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, o.text, 'utf8');
    const loc = locate(file, o.cwd);
    return { ...entry(loc.scope, loc.kind, loc.name, file), created };
  }

  function trashPath(loc) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${stamp}_${loc.scope}_${loc.kind}_${loc.name.replace(/:/g, '__')}${loc.kind === 'command' ? '.md' : ''}`;
    let p = path.join(trashDir, base);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(trashDir, `${i}_${base}`);
    return p;
  }

  /** Moves the command file (or the whole skill folder) to ~/.claude/.desk-trash. */
  function remove(file, cwd) {
    const loc = locate(file, cwd);
    if (!fs.existsSync(loc.item)) throw new Error(t('commands.notFound'));
    const to = trashPath(loc);
    moveSync(loc.item, to);
    pruneEmpty(path.dirname(loc.item), loc.root);
    return { ok: true, trashed: to };
  }

  /** Renames within the same scope/kind. For skills also updates `name:` in front matter when it matched the old name. */
  function rename(file, newName, cwd) {
    const loc = locate(file, cwd);
    if (!fs.existsSync(loc.item)) throw new Error(t('commands.notFound'));
    const tgt = targetFor(loc.scope, loc.kind, newName, cwd);
    const toItem = loc.kind === 'skill' ? path.dirname(tgt.file) : tgt.file;
    if (norm(toItem) === norm(loc.item)) {
      if (toItem !== loc.item) {
        // Case-only rename on a case-insensitive file system.
        const tmp = loc.item + '.desk-rename';
        fs.renameSync(loc.item, tmp);
        fs.renameSync(tmp, toItem);
      }
    } else {
      if (fs.existsSync(toItem)) throw new Error(t(loc.kind === 'skill' ? 'commands.skillExists' : 'commands.commandExists', { name: newName }));
      moveSync(loc.item, toItem);
      pruneEmpty(path.dirname(loc.item), loc.root);
    }
    if (loc.kind === 'skill') {
      try {
        const text = fs.readFileSync(tgt.file, 'utf8');
        const { data } = parseFrontmatter(text);
        if (data.name === loc.name) {
          fs.writeFileSync(tgt.file, text.replace(/^(---[ \t]*\r?\n[\s\S]*?^name:[ \t]*)(["']?)[^\r\n]*?\2[ \t]*$/m, `$1${newName}`), 'utf8');
        }
      } catch {}
    }
    const nl = locate(tgt.file, cwd);
    return entry(nl.scope, nl.kind, nl.name, tgt.file);
  }

  function paths(cwd) {
    const r = roots(cwd || null);
    return { home, trash: trashDir, ...r };
  }

  return { list, read, write, remove, rename, paths, locate };
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function register(ctx) {
  const apis = Object.fromEntries(Object.keys(LAYOUTS).map((a) => [a, createCommandsApi({ home: ctx.homeDir || os.homedir(), agent: a })]));
  const api = (agent) => apis[agent] ?? apis.claude;
  const changed = (detail) => {
    try {
      ctx.emit?.('cmd:changed', detail);
    } catch {}
  };
  ctx.handle('cmd:list', (cwd, agent) => api(agent).list(cwd || null));
  ctx.handle('cmd:paths', (cwd, agent) => api(agent).paths(cwd || null));
  ctx.handle('cmd:read', (file, cwd, agent) => api(agent).read(file, cwd || null));
  ctx.handle('cmd:write', (opts) => {
    const r = api(opts?.agent).write(opts);
    changed({ op: 'write', path: r.path });
    return r;
  });
  ctx.handle('cmd:delete', (file, cwd, agent) => {
    const r = api(agent).remove(file, cwd || null);
    changed({ op: 'delete', path: file });
    return r;
  });
  ctx.handle('cmd:rename', (file, newName, cwd, agent) => {
    const r = api(agent).rename(file, newName, cwd || null);
    changed({ op: 'rename', path: r.path, from: file });
    return r;
  });
}

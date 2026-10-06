// Git helpers for the changes panel. All commands run without a shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';

const MAX_BUFFER = 32 * 1024 * 1024;

function git(cwd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, timeout }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const msg = (stderr || stdout || err.message).toString().trim().split('\n').slice(-6).join('\n');
      reject(new Error(msg));
    });
  });
}

function inRepo(root, file) {
  const abs = path.resolve(root, file);
  if (!abs.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep.toLowerCase())) throw new Error('Path outside repository');
  return abs;
}

/** Stages the given paths and commits only them. */
export async function gitCommit(root, files, message) {
  if (!message?.trim()) throw new Error(t('git.emptyMessage'));
  if (!files?.length) throw new Error(t('git.noFiles'));
  files.forEach((f) => inRepo(root, f));
  await git(root, ['add', '-A', '--', ...files]);
  await git(root, ['commit', '-m', message.trim(), '--only', '--', ...files]);
  return (await git(root, ['log', '-1', '--format=%h %s'])).trim();
}

/** Pushes the current branch, creating the upstream on first push. */
export async function gitPush(root) {
  try {
    await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    await git(root, ['push'], 120000);
  } catch (e) {
    if (!/no upstream|@\{u\}|upstream/i.test(String(e.message))) throw e;
    await git(root, ['push', '-u', 'origin', 'HEAD'], 120000);
  }
  return true;
}

export async function gitPull(root) {
  await git(root, ['pull', '--ff-only'], 120000);
  return true;
}

/** Throws away local changes to one file (tracked: back to HEAD; untracked: deleted). */
export async function gitDiscard(root, file, untracked) {
  const abs = inRepo(root, file);
  if (untracked) fs.rmSync(abs, { recursive: true, force: true });
  else await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file]);
  return true;
}

export async function gitBranches(root) {
  const out = await git(root, ['branch', '--format=%(refname:short)']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function gitCheckout(root, branch, create) {
  if (!/^[\w./-]+$/.test(branch)) throw new Error(t('git.badBranch'));
  await git(root, create ? ['switch', '-c', branch] : ['switch', branch]);
  return true;
}

/** Short summary of the selected changes, used to draft a commit message. */
export async function gitDiffForMessage(root, files) {
  files.forEach((f) => inRepo(root, f));
  const head = await hasHead(root);
  const tracked = head ? await git(root, ['diff', 'HEAD', '--', ...files]).catch(() => '') : '';
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '--', ...files]).catch(() => ''))
    .split('\n')
    .filter(Boolean);
  let text = tracked;
  for (const f of untracked.slice(0, 20)) {
    try {
      const body = fs.readFileSync(inRepo(root, f), 'utf8').slice(0, 3000);
      text += `\n--- new file: ${f}\n${body}`;
    } catch {}
  }
  return text.slice(0, 24000);
}

async function hasHead(cwd) {
  try {
    await git(cwd, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function countLines(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return 0;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\u0000')) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

/** Changed files in the working tree relative to HEAD, with +/- counts. */
export async function gitStatus(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return { isRepo: false, files: [] };
  let root;
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return { isRepo: false, files: [] };
  }
  const head = await hasHead(cwd);
  const [statusRaw, numstatRaw, branch, sync] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '-unormal']),
    head ? git(root, ['diff', 'HEAD', '--numstat', '-z']).catch(() => '') : Promise.resolve(''),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()).catch(() => null),
    git(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
      .then((s) => {
        const [behind, ahead] = s.trim().split(/\s+/).map(Number);
        return { upstream: true, ahead, behind };
      })
      .catch(() => ({ upstream: false, ahead: 0, behind: 0 })),
  ]);

  const counts = new Map();
  const parts = numstatRaw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const m = p.match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!m) continue;
    let file = m[3];
    if (file === '') {
      i += 2;
      file = parts[i];
    }
    counts.set(file, { add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' });
  }

  const files = [];
  const entries = statusRaw.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.length < 4) continue;
    const xy = e.slice(0, 2);
    const file = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    const untracked = xy === '??';
    const c = counts.get(file) ?? (untracked ? { add: countLines(path.join(root, file)), del: 0 } : { add: 0, del: 0 });
    const status = untracked ? 'new' : xy.includes('D') ? 'deleted' : xy.includes('A') ? 'added' : xy[0] === 'R' ? 'renamed' : 'modified';
    files.push({ path: file, abs: path.join(root, file), status, untracked, ...c });
  }
  return { isRepo: true, root, branch, files, hasHead: head, ...sync };
}

/** Unified diff text for one file (untracked files come back as all-added content). */
export async function gitFileDiff(root, file, untracked) {
  const abs = path.resolve(root, file);
  if (!abs.toLowerCase().startsWith(path.resolve(root).toLowerCase())) throw new Error('Path outside repository');
  if (untracked) {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { kind: 'dir' };
    if (st.size > 512 * 1024) return { kind: 'too-large' };
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('\u0000')) return { kind: 'binary' };
    return { kind: 'new', text };
  }
  const args = (await hasHead(root)) ? ['diff', 'HEAD', '--', file] : ['diff', '--', file];
  return { kind: 'diff', text: await git(root, args) };
}

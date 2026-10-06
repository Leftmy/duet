// Isolated git worktrees for chats ("Worktree" mode). Each chat gets its own checkout and branch
// under ~/.claude-desk/worktrees; a small registry maps worktree paths back to their base repo.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from './i18n.mjs';

const HOME = path.join(os.homedir(), '.claude-desk', 'worktrees');

function git(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const msg = (stderr?.toString() || stdout?.toString() || err.message).trim().split('\n').slice(-8).join('\n');
        reject(new Error(msg));
      },
    );
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}
const gitText = async (cwd, args) => (await git(cwd, args)).toString().trim();

export function createWorktrees(registryFile) {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (reg) => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify(reg, null, 2));
  };
  const key = (p) => path.resolve(p).toLowerCase();

  return {
    /** Registry entry for a worktree path, if it is one of ours. */
    info(dir) {
      return dir ? read()[key(dir)] ?? null : null;
    },

    all() {
      return read();
    },

    async isRepo(cwd) {
      if (!cwd || !fs.existsSync(cwd)) return false;
      try {
        await gitText(cwd, ['rev-parse', '--verify', 'HEAD']);
        return true;
      } catch {
        return false;
      }
    },

    async create(cwd) {
      const base = await gitText(cwd, ['rev-parse', '--show-toplevel']);
      const baseCommit = await gitText(base, ['rev-parse', 'HEAD']);
      const baseBranch = await gitText(base, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12);
      const slug = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
      const repoName = path.basename(base).replace(/[^\w.-]+/g, '_');
      const dir = path.join(HOME, `${repoName}-${slug}`);
      const branch = `desk/${slug}`;
      fs.mkdirSync(HOME, { recursive: true });
      await gitText(base, ['worktree', 'add', '-b', branch, dir, baseCommit]);
      const entry = { path: dir, base: path.resolve(base), branch, baseCommit, baseBranch, createdAt: Date.now() };
      const reg = read();
      reg[key(dir)] = entry;
      write(reg);
      return entry;
    },

    /** Copies the worktree's changes (committed or not, including new files) into the base checkout. */
    async apply(dir) {
      const entry = this.info(dir);
      if (!entry || entry.removed) throw new Error(t('git.notActiveWorktree'));
      await git(dir, ['add', '-A']);
      const patch = await git(dir, ['diff', '--cached', '--binary', entry.baseCommit]);
      if (!patch.length) return { applied: false, files: 0 };
      const files = (await gitText(dir, ['diff', '--cached', '--name-only', entry.baseCommit])).split('\n').filter(Boolean);
      try {
        await git(entry.base, ['apply', '--3way', '--whitespace=nowarn', '-'], patch);
      } catch (e) {
        // --3way needs the blobs in the base index; fall back to a plain apply.
        try {
          await git(entry.base, ['apply', '--whitespace=nowarn', '-'], patch);
        } catch {
          throw e;
        }
      }
      return { applied: true, files: files.length, list: files };
    },

    async remove(dir, deleteBranch = true) {
      const entry = this.info(dir);
      if (!entry) throw new Error(t('git.notWorktree'));
      await gitText(entry.base, ['worktree', 'remove', '--force', entry.path]).catch(() => {});
      // The chat's Claude Code process may still be exiting and holding the folder; retry for a few seconds.
      for (let i = 0; i < 20 && fs.existsSync(entry.path); i++) {
        try {
          fs.rmSync(entry.path, { recursive: true, force: true });
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (fs.existsSync(entry.path)) throw new Error(t('git.folderBusy', { path: entry.path }));
      await gitText(entry.base, ['worktree', 'prune']).catch(() => {});
      if (deleteBranch) await gitText(entry.base, ['branch', '-D', entry.branch]).catch(() => {});
      // Keep a tombstone so the chat stays grouped under its project in the sidebar.
      const reg = read();
      reg[key(dir)] = { ...entry, removed: true };
      write(reg);
      return true;
    },
  };
}

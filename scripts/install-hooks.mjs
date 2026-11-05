import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Some Windows installations have Git installed without adding it to PATH.
export function findGit() {
  const candidates = ['git'];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) candidates.push(path.join(base, 'Git', 'cmd', 'git.exe'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
    }
  }
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return candidate;
  }
  throw new Error('Git is required to install Duet hooks. Install Git and run npm run hooks:install.');
}

export function installHooks(root) {
  // Source archives have no Git metadata. A worktree's .git may be a file.
  if (!fs.existsSync(path.join(root, '.git'))) {
    console.log('No Git checkout; skipping hook installation.');
    return;
  }
  const git = findGit();
  const result = spawnSync(git, ['config', '--local', 'core.hooksPath', '.githooks'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Could not configure Duet Git hooks.');
  console.log('Git hooks installed: pre-commit runs npm run verify.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    installHooks(fileURLToPath(new URL('../', import.meta.url)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

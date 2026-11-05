import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findGit, installHooks } from './install-hooks.mjs';

test('installed pre-commit verifies from the repository root and blocks failed checks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-hook-test-'));
  try {
    const root = path.join(temp, 'checkout with spaces');
    const bin = path.join(temp, 'bin');
    const log = path.join(temp, 'verification.log');
    fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'nested'));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(bin);
    fs.copyFileSync(new URL('../.githooks/pre-commit', import.meta.url), path.join(root, '.githooks/pre-commit'));
    fs.chmodSync(path.join(root, '.githooks/pre-commit'), 0o755);
    fs.copyFileSync(new URL('./install-hooks.mjs', import.meta.url), path.join(root, 'scripts/install-hooks.mjs'));
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\n{ pwd -W 2>/dev/null || pwd -P; printf "%s\\n" "$*"; } >> "$DUET_HOOK_TEST_LOG"\nexit "$DUET_HOOK_TEST_STATUS"\n', { mode: 0o755 });
    const git = findGit();
    const env = { ...process.env };
    // Isolate the fixture from the calling hook and from user Git configuration.
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_') || key.toUpperCase() === 'PATH') delete env[key];
    }
    Object.assign(env, {
      PATH: [bin, path.dirname(process.execPath), process.env.PATH || process.env.Path].join(path.delimiter),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'empty-gitconfig'),
      GIT_TERMINAL_PROMPT: '0', DUET_HOOK_TEST_LOG: log, DUET_HOOK_TEST_STATUS: '23',
    });
    const run = (...args) => spawnSync(git, args, { cwd: path.join(root, 'nested'), env, encoding: 'utf8', windowsHide: true });
    const ok = (...args) => {
      const result = run(...args);
      assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
      return result.stdout.trim();
    };
    ok('init', '..');
    ok('config', 'user.name', 'Hook fixture');
    ok('config', 'user.email', 'hook@example.invalid');
    ok('config', 'commit.gpgsign', 'false');
    const installed = spawnSync(process.execPath, [path.join(root, 'scripts/install-hooks.mjs')], {
      cwd: root, env, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(installed.status, 0, installed.error?.message || installed.stderr);
    assert.equal(ok('config', '--local', 'core.hooksPath'), '.githooks');
    fs.writeFileSync(path.join(root, 'change.txt'), 'fixture\n');
    ok('add', '--', '../change.txt');
    const failed = run('commit', '-m', 'must fail');
    assert.notEqual(failed.status, 0, 'verification failure must reject the commit');
    assert.notEqual(run('rev-parse', '--verify', 'HEAD').status, 0, 'failed verification must not create a commit');
    env.DUET_HOOK_TEST_STATUS = '0';
    ok('commit', '-m', 'verified change');
    assert.equal(ok('rev-list', '--count', 'HEAD'), '1');
    const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 4, 'verification must run once for each attempted commit');
    for (const offset of [0, 2]) {
      const normalized = lines[offset].replace(/^\/([a-z])\//i, '$1:/').replaceAll('\\', '/');
      assert.equal(normalized.toLowerCase(), root.replaceAll('\\', '/').toLowerCase());
      assert.equal(lines[offset + 1], 'run verify');
    }
    fs.writeFileSync(path.join(root, 'change.txt'), 'trailing whitespace \n');
    ok('add', '--', '../change.txt');
    assert.notEqual(run('commit', '-m', 'must reject whitespace').status, 0);
    assert.equal(ok('rev-list', '--count', 'HEAD'), '1');
    assert.equal(fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).length, 4,
      'staged whitespace errors must fail before running verification');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('hook installation supports a source archive without Git metadata', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-hook-archive-'));
  try {
    installHooks(temp);
    assert.equal(fs.existsSync(path.join(temp, '.git')), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

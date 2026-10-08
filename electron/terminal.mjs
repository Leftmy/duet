// Integrated terminals (node-pty: ConPTY on Windows, a pty on Linux/macOS). One pty per terminal tab in the renderer.
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { which } from './platform.mjs';

const require = createRequire(import.meta.url);
let pty = null;
function loadPty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

function defaultShell() {
  if (process.platform !== 'win32') return process.env.SHELL || (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  const pwsh = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find((p) => fs.existsSync(p)) ?? which('pwsh.exe');
  return pwsh ?? 'powershell.exe';
}

export function createTerminals({ emit }) {
  const terms = new Map();
  return {
    create({ id, cwd, cols, rows }) {
      if (terms.has(id)) return { id, shell: terms.get(id).shell };
      const shell = defaultShell();
      const p = loadPty().spawn(shell, [], {
        name: 'xterm-256color',
        cols: cols || 100,
        rows: rows || 30,
        cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
        env: { ...process.env, TERM_PROGRAM: 'duet' },
        useConpty: true,
      });
      p.onData((data) => emit('term:data', { id, data }));
      p.onExit(({ exitCode }) => {
        terms.delete(id);
        emit('term:exit', { id, exitCode });
      });
      terms.set(id, { p, shell });
      return { id, shell };
    },
    write(id, data) {
      terms.get(id)?.p.write(data);
    },
    resize(id, cols, rows) {
      try {
        terms.get(id)?.p.resize(Math.max(2, cols), Math.max(1, rows));
      } catch {}
    },
    kill(id) {
      try {
        terms.get(id)?.p.kill();
      } catch {}
      terms.delete(id);
    },
    killAll() {
      for (const id of [...terms.keys()]) this.kill(id);
    },
  };
}

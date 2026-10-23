// An isolated renderer with stub IPC: never imports the real core or provider modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-render-test-'));
const fixture = fileURLToPath(new URL('./fixtures/ui-runtime.cjs', import.meta.url));
const child = spawn(electron, [fixture, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let errors = '';
child.stdout.on('data', (s) => process.stdout.write(s));
child.stderr.on('data', (s) => { errors = (errors + s).slice(-5000); });
const timer = setTimeout(() => child.kill(), 60000);
try {
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error(`Isolated UI test failed (${code}):\n${errors}`);
} finally {
  clearTimeout(timer);
  // Only the verified temporary test directory is removed, after Electron exits.
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('duet-render-test-')) throw new Error('Unexpected test profile path');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

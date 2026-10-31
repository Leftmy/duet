// Creates a launcher for this checkout that starts the app without a console window.
// Windows: Desktop + Start menu shortcuts (make-shortcut.ps1). Linux: an applications-menu entry
// (~/.local/share/applications/duet.desktop) that desktop environments also offer for the dock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'win32') {
  execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'scripts', 'make-shortcut.ps1')], { stdio: 'inherit' });
  process.exit(0);
}

if (process.platform !== 'linux') {
  console.error('Shortcuts are supported on Windows and Linux.');
  process.exit(1);
}

const native = path.join(app, 'release', 'native', 'duet-native');
if (!fs.existsSync(native)) throw new Error(`Native build not found. Run 'npm run native:build' in ${app} first.`);

const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const dir = path.join(dataHome, 'applications');
fs.mkdirSync(dir, { recursive: true });
// Desktop entries split Exec on spaces; quote paths that contain them.
const q = (p) => (/[\s"]/.test(p) ? `"${p.replace(/(["\\$`])/g, '\\$1')}"` : p);
const file = path.join(dir, 'duet.desktop');
fs.writeFileSync(
  file,
  [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Duet',
    'Comment=Desktop UI for coding agents',
    `Exec=${q(native)} %U`,
    `Path=${app}`,
    `Icon=${path.join(app, 'build', 'icon.png')}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=Duet',
    '',
  ].join('\n'),
);
fs.chmodSync(file, 0o755);
try {
  execFileSync('update-desktop-database', [dir], { stdio: 'ignore' });
} catch {}
console.log(`Created ${file}`);

// Platform differences in one place: finding programs, terminals and editors on Windows, Linux and macOS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/** Full path of a program on PATH, or null. */
export function which(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  if (isWin) {
    // where.exe also finds app execution aliases (WindowsApps\wt.exe), which Node can't stat.
    try {
      return execFileSync('where.exe', [cmd], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim() || null;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mode & 0o111) return p;
    } catch {}
  }
  return null;
}

/** JetBrains Toolbox launcher scripts: Windows %LOCALAPPDATA%\JetBrains\Toolbox\scripts\*.cmd, Linux ~/.local/share/JetBrains/Toolbox/scripts/*. */
export function jetbrainsScriptsDir() {
  if (isWin) return path.join(process.env.LOCALAPPDATA ?? '', 'JetBrains', 'Toolbox', 'scripts');
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'JetBrains', 'Toolbox', 'scripts');
}

/**
 * Terminal emulators of a Linux desktop, in order of preference, with how each opens in a folder.
 * x-terminal-emulator is Debian/Ubuntu's alternatives link to the user's choice.
 */
const LINUX_TERMINALS = [
  ['x-terminal-emulator', (cwd) => ['--working-directory', cwd]],
  ['gnome-terminal', (cwd) => [`--working-directory=${cwd}`]],
  ['ptyxis', (cwd) => ['--new-window', '--working-directory', cwd]],
  ['konsole', (cwd) => ['--workdir', cwd]],
  ['xfce4-terminal', (cwd) => [`--working-directory=${cwd}`]],
  ['kitty', (cwd) => ['--directory', cwd]],
  ['alacritty', (cwd) => ['--working-directory', cwd]],
  ['wezterm', (cwd) => ['start', '--cwd', cwd]],
  ['tilix', (cwd) => [`--working-directory=${cwd}`]],
  ['xterm', () => []],
];

/** How to open a terminal in a folder here: { cmd, args(cwd) } or null. */
export function terminalLauncher() {
  if (isWin) {
    const wt = which('wt');
    return wt ? { cmd: wt, args: (cwd) => ['-d', cwd] } : null;
  }
  if (isMac) return { cmd: 'open', args: (cwd) => ['-a', 'Terminal', cwd] };
  for (const [name, args] of LINUX_TERMINALS) {
    const cmd = which(name);
    if (cmd) return { cmd, args };
  }
  return null;
}

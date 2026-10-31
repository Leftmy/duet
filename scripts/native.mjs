import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from './prepare-native.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const action = process.argv[2] || 'start';
const cargo = path.join(root, '.tools', 'cargo', 'bin');
const env = { ...process.env };
if (fs.existsSync(path.join(cargo, process.platform === 'win32' ? 'cargo.exe' : 'cargo'))) {
  env.CARGO_HOME = path.join(root, '.tools', 'cargo'); env.RUSTUP_HOME = path.join(root, '.tools', 'rustup');
  env.PATH = cargo + path.delimiter + (env.PATH || env.Path || '');
  if (process.platform === 'win32') { delete env.Path; delete env.path; }
}
async function run(bin, args, extra = {}) {
  const child = spawn(bin, args, { cwd: root, env, stdio: 'inherit', windowsHide: true, ...extra });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${path.basename(bin)} exited (${code})`);
}
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
if (action === 'build' || action === 'package' || action === 'dev') {
  await run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
  await prepareRuntime();
  const args = [cli, 'build'];
  if (action === 'package') args.push('--bundles', process.platform === 'win32' ? 'nsis' : 'deb,appimage');
  if (action !== 'package') args.push('--no-bundle');
  if (action === 'dev') args.push('--debug');
  await run(process.execPath, args);
  if (action !== 'dev') {
    const portable = path.resolve(root, process.env.DUET_NATIVE_PORTABLE_DIR || 'release/native');
    if (!portable.startsWith(path.join(root, 'release') + path.sep)) throw new Error('Unexpected portable output path');
    fs.rmSync(portable, { recursive: true, force: true });
    fs.mkdirSync(portable, { recursive: true });
    fs.copyFileSync(path.join(env.CARGO_TARGET_DIR || path.join(root, 'src-tauri/target'), 'release', process.platform === 'win32' ? 'duet-native.exe' : 'duet-native'), path.join(portable, process.platform === 'win32' ? 'duet-native.exe' : 'duet-native'));
    fs.cpSync(path.join(root, 'src-tauri/resources/native-runtime'), path.join(portable, 'runtime'), { recursive: true });
    if (process.platform !== 'win32') fs.chmodSync(path.join(portable, 'duet-native'), 0o755);
    console.log(`Portable native application: ${portable}`);
  }
}
if (action === 'start' || action === 'dev' || action === 'preview') {
  const executable=process.platform === 'win32' ? 'duet-native.exe' : 'duet-native';
  const compiled=path.join(env.CARGO_TARGET_DIR||path.join(root,'src-tauri/target'),action==='dev'?'debug':'release',executable);
  const candidates=[compiled,path.join(root,'release/native-providers',executable),path.join(root,'release/native-browser',executable),path.join(root,'release/native-steering',executable),path.join(root,'release/native-team',executable),path.join(root,'release/native-codex',executable),path.join(root,'release/native',executable),path.join(root,'release/native-rust-core',executable)];
  const binary=action==='dev'?compiled:candidates.filter(file=>fs.existsSync(file)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
  if (!binary||!fs.existsSync(binary)) throw new Error('Build the native version first: npm run native:build');
  if (action === 'dev') { env.DUET_NATIVE_PROJECT_ROOT = root; }
  else {
    const bundled=path.join(path.dirname(binary),'runtime');
    if(fs.existsSync(path.join(bundled,'manifest.json')))env.DUET_NATIVE_PROJECT_ROOT=bundled;
    else if(fs.existsSync(path.join(root,'src-tauri/resources/native-runtime/manifest.json')))env.DUET_NATIVE_PROJECT_ROOT=path.join(root,'src-tauri/resources/native-runtime');
  }
  if (action === 'preview' || action === 'dev') {
    const profile = path.join(os.tmpdir(), 'Duet-native-preview');
    fs.mkdirSync(profile, { recursive: true });
    const source = path.join(process.platform === 'win32' ? process.env.APPDATA : path.join(os.homedir(), '.config'), 'Duet', 'settings.json');
    const dest = path.join(profile, 'settings.json');
    if (!fs.existsSync(dest) && fs.existsSync(source)) {
      const settings = JSON.parse(fs.readFileSync(source, 'utf8'));
      fs.writeFileSync(dest, JSON.stringify({ ui: settings.ui, resolvedTheme: settings.resolvedTheme }));
    }
    env.DUET_NATIVE_USER_DATA = profile;
    env.DUET_NATIVE_PREVIEW = '1';
  }
  await run(binary, []);
}

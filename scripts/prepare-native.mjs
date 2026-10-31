import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);

// A native Claude Code executable is the only bundled provider dependency.
// Keep the previous sidecar resource directory intact while an old app may still use it.
export async function prepareRuntime(){
  const target=path.resolve(root,'src-tauri/resources/native-runtime');
  if(target!==path.join(root,'src-tauri','resources','native-runtime').replace(/[\\/]$/,''))throw new Error('Unexpected native runtime directory');
  fs.mkdirSync(path.join(target,'bin'),{recursive:true});
  const exe=process.platform==='win32'?'claude.exe':'claude';
  const packages=[`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl`];
  let packageFile;
  for(const name of packages){try{packageFile=require.resolve(name+'/package.json');break}catch{}}
  if(!packageFile)throw new Error('Install the native Claude Code platform package with npm ci');
  const pkg=JSON.parse(fs.readFileSync(packageFile,'utf8'));
  fs.copyFileSync(path.join(path.dirname(packageFile),exe),path.join(target,'bin',exe));
  if(process.platform!=='win32')fs.chmodSync(path.join(target,'bin',exe),0o755);
  for(const name of ['LICENSE.md','LICENSE','NOTICE']){const file=path.join(path.dirname(packageFile),name);if(fs.existsSync(file))fs.copyFileSync(file,path.join(target,name));}
  fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({core:'rust',nodeCore:false,claude:{package:pkg.name,version:pkg.version,executable:'bin/'+exe}},null,2)+'\n');
  for(const file of ['node.exe','node','desktop/sidecar.mjs','electron/main.mjs','node_modules'])if(fs.existsSync(path.join(target,file)))throw new Error('Legacy runtime leaked into Rust package: '+file);
  console.log('Native runtime prepared: Rust core + native Claude CLI; no Node, Electron or JS backend');
  return target;
}

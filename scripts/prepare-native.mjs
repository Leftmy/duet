import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);

// Provider executables are self-contained; the application backend stays native Rust.
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
  const pin=JSON.parse(fs.readFileSync(path.join(root,'desktop/kimi-version.json'),'utf8'));
  const [filename,sha256]=pin.targets[process.platform+'-'+process.arch]??[];
  if(!filename)throw new Error('Unsupported Kimi platform');
  const cached=path.join(root,'.tools','kimi-native',pin.version,filename);
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(!fs.existsSync(cached)||hash(cached)!==sha256){
    fs.mkdirSync(path.dirname(cached),{recursive:true});
    console.log('Downloading pinned Kimi Code '+pin.version+' for '+process.platform+'-'+process.arch);
    const response=await fetch('https://code.kimi.com/kimi-code/binaries/'+pin.version+'/'+filename);
    if(!response.ok)throw new Error('Kimi download HTTP '+response.status);
    const {Readable}=await import('node:stream');const {pipeline}=await import('node:stream/promises');
    await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(cached+'.partial'));
    if(hash(cached+'.partial')!==sha256)throw new Error('Kimi binary checksum mismatch');
    fs.renameSync(cached+'.partial',cached);
  }
  const kimiExe=process.platform==='win32'?'kimi.exe':'kimi';
  fs.copyFileSync(cached,path.join(target,'bin',kimiExe));
  if(process.platform!=='win32')fs.chmodSync(path.join(target,'bin',kimiExe),0o755);
  fs.copyFileSync(path.join(root,'desktop/KIMI-LICENSE'),path.join(target,'KIMI-LICENSE'));
  fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({core:'rust',nodeCore:false,kimi:{version:pin.version,sha256,executable:'bin/'+kimiExe},claude:{package:pkg.name,version:pkg.version,executable:'bin/'+exe}},null,2)+'\n');
  for(const file of ['node.exe','node','desktop/sidecar.mjs','electron/main.mjs','node_modules'])if(fs.existsSync(path.join(target,file)))throw new Error('Legacy runtime leaked into Rust package: '+file);
  console.log('Native runtime prepared: Rust core + native Claude and Kimi CLIs; no application JS backend');
  return target;
}

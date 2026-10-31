// Windows: compare the previous Tauri+Node core and Rust core with fresh identical profiles.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='win32')throw new Error('This private-memory benchmark requires Windows');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function measure(kind,port){
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'duet-shell-bench-'));
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({ui:{autoTitles:false,notifications:false}}));
  const env={...process.env,DUET_NATIVE_PREVIEW:'1',DUET_NATIVE_TEST:'1',DUET_NATIVE_USER_DATA:profile};
  delete env.DUET_NODE_BIN;delete env.DUET_NATIVE_PROJECT_ROOT;
  const bin=path.resolve(root,kind==='rust'?(process.env.DUET_BENCH_RUST||'release/native-rust-core/duet-native.exe'):(process.env.DUET_BENCH_NODE||'src-tauri/target/release/duet-native.exe'));
  const args=[];
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=`--remote-debugging-port=${port}`;
  if(kind==='node')env.DUET_NATIVE_PROJECT_ROOT=path.join(root,'src-tauri/resources/runtime');
  const child=spawn(bin,args,{cwd:root,env,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',x=>{errors=(errors+x).slice(-3000)});
  let ws;
  try{
    let page;
    for(let n=0;n<600;n++){
      try{page=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x=>x.type==='page');if(page)break}catch{}
      if(child.exitCode!==null)throw new Error(`${kind} exited: ${errors}`);await delay(100);
    }
    if(!page)throw new Error('No debugging target: '+errors);
    ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
    let id=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}};
    const rpc=(expression)=>new Promise((resolve,reject)=>{
      const n=++id;const t=setTimeout(()=>{pending.delete(n);reject(new Error('Benchmark evaluate timed out'))},10000);
      pending.set(n,m=>{clearTimeout(t);resolve(m.result?.result?.value)});
      ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
    });
    let ready=false;
    for(let n=0;n<600;n++){if(await rpc('Boolean(window.__deskStore?.getState().ready)')){ready=true;break}await delay(100)}
    if(!ready)throw new Error('Shell did not initialize: '+errors);
    await delay(5000);
    const script=`$all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${child.pid}); do { $added=$false; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$added=$true}} }while($added); @($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object {$p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;if($p){[pscustomobject]@{name=$_.Name;pid=$_.ProcessId;private=$p.PrivateMemorySize64}}}) | ConvertTo-Json -Compress`;
    const processes=JSON.parse(execFileSync('powershell',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true}));
    const result={kind,privateMiB:Math.round(processes.reduce((s,p)=>s+p.private,0)/1048576),corePrivateMiB:Math.round(processes.filter(p=>p.name!=='msedgewebview2.exe').reduce((s,p)=>s+p.private,0)/1048576),processes};
    if(kind==='rust'&&processes.some(p=>p.name==='node.exe'))throw new Error('Rust application still has an idle Node process');
    console.log(JSON.stringify(result));
    await rpc(`void window.__TAURI_INTERNALS__.invoke('window_control',{action:'close'})`);
    return result;
  }finally{
    ws?.close();await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);
    if(child.exitCode===null)child.kill();
  }
}
const old=await measure('node',9355);const native=await measure('rust',9356);
const comparison={savedMiB:old.privateMiB-native.privateMiB,reductionPercent:Math.round((1-native.privateMiB/old.privateMiB)*100),old,native};
fs.mkdirSync(path.join(root,'.tools'),{recursive:true});fs.writeFileSync(path.join(root,'.tools/rust-core-memory.json'),JSON.stringify(comparison,null,2)+'\n');
console.log(JSON.stringify({savedMiB:comparison.savedMiB,reductionPercent:comparison.reductionPercent}));

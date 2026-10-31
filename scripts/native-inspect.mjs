import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { testCodexUI } from './native-codex-ui.mjs';
import { testPasteUI } from './native-paste-ui.mjs';
import { testTeamUI } from './native-team-ui.mjs';
import { testSteeringUI } from './native-steering-ui.mjs';
import { testBrowserUI } from './native-browser-ui.mjs';
import { testRecoveryUI } from './native-recovery-ui.mjs';
import { createNativeFixtures } from './native-fixtures.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'duet-native-test-'));
let reportPermission;
const permissionResult=new Promise(resolve=>{reportPermission=resolve});
const server=createServer((req,res)=>{
  if(req.url.startsWith('/permission-result/')){reportPermission(req.url.split('/').at(-1));res.end('ok');return;}
  res.setHeader('Content-Type','text/html');
  const tab=new URL(req.url,'http://127.0.0.1').searchParams.get('tab');
  const title=['second','popup'].includes(tab)?'Duet tab '+tab:'Duet native browser test';
  res.end(`<!doctype html><title>${title}</title><style>body{background:#225588;color:white;font:24px sans-serif}</style><h1>NATIVE_BROWSER_OK</h1><input id="draft"><a id="popup" target="_blank" href="/?tab=popup">Popup</a><div style="height:1800px"></div><script>setTimeout(async()=>{let status='DENIED';try{await window.__TAURI_INTERNALS__.invoke('duet_invoke',{channel:'app:getSettings',args:[]});status='ALLOWED'}catch{}fetch('/permission-result/'+status)},100)</script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browserURL=`http://127.0.0.1:${server.address().port}/`;
fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({ui:{autoTitles:false,notifications:false}}));
const testTranscripts=path.join(profile,'transcripts');
fs.mkdirSync(path.join(testTranscripts,'project'),{recursive:true});
fs.writeFileSync(path.join(testTranscripts,'project','native-search-session.jsonl'),JSON.stringify({type:'user',uuid:'native-search-message',cwd:profile,timestamp:'2026-10-30T10:00:00Z',message:{content:'NATIVE_RUST_SEARCH_OK Привет'}})+'\n');
const built=process.argv.includes('--built');
const packaged=built||process.argv.includes('--packaged');
const cliFixtures=process.argv.includes('--fixtures')&&!process.argv.includes('--provider-smoke')?createNativeFixtures():null;
const testEnv={...process.env,...cliFixtures?.env};
delete testEnv.DUET_NATIVE_PROJECT_ROOT;delete testEnv.DUET_NODE_BIN;
// Use the native builder API: elevated WebView2 150+ ignores environment overrides.
delete testEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
const debugListener=createServer();
await new Promise(r=>debugListener.listen(0,'127.0.0.1',r));
const debugPort=debugListener.address().port;
await new Promise(r=>debugListener.close(r));
const child=spawn(process.env.DUET_NATIVE_TEST_BIN||path.join(root,built?'src-tauri/target/release/duet-native.exe':packaged?'release/native/duet-native.exe':'src-tauri/target/debug/duet-native.exe'),[],{windowsHide:true,env:{...testEnv,
  ...(!packaged?{DUET_NATIVE_PROJECT_ROOT:root,DUET_NODE_BIN:process.execPath}:{}),DUET_NATIVE_USER_DATA:profile,DUET_NATIVE_TEST:'1',DUET_NATIVE_PREVIEW:'1',DUET_NATIVE_TEST_TRANSCRIPTS:testTranscripts,
  DUET_NATIVE_INSPECT_PORT:String(debugPort)},stdio:['ignore','pipe','pipe']});
console.log(JSON.stringify({pid:child.pid,profile}));
child.stderr.on('data',data=>process.stderr.write(data));child.stdout.on('data',data=>process.stdout.write(data));
const timer=setTimeout(()=>{console.error('Native inspection deadline');child.kill();},process.argv.includes('--provider-smoke')?240000:90000);
try{
  let page;
  for(let n=0;n<200;n++){
    if(child.exitCode!==null)throw new Error('Native application exited before creating its webview');
    try{const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json();page=pages.find(p=>p.type==='page');if(page)break;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  if(!page)throw new Error('No native webview appeared');
  const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let next=0;const waiting=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}};
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('CDP timeout: '+method))},30000);waiting.set(id,value=>{clearTimeout(timer);resolve(value)});ws.send(JSON.stringify({id,method,params}));});
  await rpc('Runtime.enable');
  let ready=false;
  for(let n=0;n<700;n++){
    const status=await rpc('Runtime.evaluate',{expression:`Boolean(window.__deskStore?.getState().ready)`,returnByValue:true});
    if(status.result?.result?.value===true){ready=true;break;}
    await new Promise(r=>setTimeout(r,100));
  }
  console.log('Ready:',ready);
  const result=await rpc('Runtime.evaluate',{expression:`JSON.stringify({url:location.href,desk:!!window.desk,ready:window.__deskStore?.getState().ready,probeError:window.__deskStore?.getState().probeError,providers:Object.keys(window.__deskStore?.getState().providers||{})})`,awaitPromise:true,returnByValue:true});
  console.log(JSON.stringify(result));
  assert.equal(ready,true,'Native application did not initialize');
  const processScript=`$all=Get-CimInstance Win32_Process;$ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${child.pid});do{$added=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)-and $ids.Add([int]$p.ProcessId)){$added=$true}}}while($added);@($all|Where-Object {$ids.Contains([int]$_.ProcessId)}|ForEach-Object {@{name=$_.Name;command=$_.CommandLine}})|ConvertTo-Json -Compress`;
  const processes=JSON.parse(execFileSync('powershell',['-NoProfile','-Command',processScript],{encoding:'utf8',windowsHide:true}));
  // CI's explicitly configured fake provider CLIs use Node. A legacy core is never allowed.
  assert.ok(processes.filter(p=>p.name==='node.exe').every(p=>cliFixtures&&p.command?.includes(cliFixtures.root)),'Initialized native package must not retain a Node core');
  console.log(cliFixtures?'PASS: Node processes belong only to isolated CLI fixtures':'PASS: initialized application has no Node process');
  const evaluate=async(expression)=>{
    const answer=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(answer.result?.exceptionDetails)throw new Error(JSON.stringify(answer.result.exceptionDetails));
    return answer.result?.result?.value;
  };
  const controls=await evaluate(`(()=>{const bar=document.querySelector('.titlebar'),buttons=bar?.querySelector('[data-native-controls]');return {count:buttons?.children.length,rightGap:bar&&buttons?bar.getBoundingClientRect().right-buttons.getBoundingClientRect().right:null}})()`);
  assert.equal(controls.count,3,'Native titlebar must have three window controls');
  assert.ok(controls.rightGap!==null&&Math.abs(controls.rightGap)<=1,'Native window controls must reach the right edge: '+JSON.stringify(controls));
  console.log('PASS: native titlebar controls align with the right window edge');
  const waitWindowState=async(expected)=>{
    for(let n=0;n<100;n++){
      const actual=await evaluate(`(async()=>({os:await window.__TAURI_INTERNALS__.invoke('window_control',{action:'state'}),icon:document.querySelector('[data-window-action="maximize"]').dataset.icon,mode:document.querySelector('[data-window-action="maximize"]').dataset.windowState}))()`);
      if(Object.entries(expected).every(([key,value])=>actual.os[key]===value)&&actual.icon===(actual.os.maximized||actual.os.fullscreen?'restore':'maximize')&&actual.mode===(actual.os.fullscreen?'fullscreen':actual.os.maximized?'maximized':'normal'))return actual;
      await new Promise(r=>setTimeout(r,50));
    }
    throw new Error('Native window button did not synchronize: '+JSON.stringify(expected));
  };
  await waitWindowState({maximized:false,fullscreen:false});
  await evaluate(`document.querySelector('[data-window-action="maximize"]').click()`);
  await waitWindowState({maximized:true,fullscreen:false});
  await evaluate(`window.__TAURI_INTERNALS__.invoke('window_control',{action:'maximize'})`);
  await waitWindowState({maximized:false,fullscreen:false});
  await evaluate(`window.dispatchEvent(new Event('focus'));document.dispatchEvent(new KeyboardEvent('keydown',{key:'F11',bubbles:true}))`);
  await waitWindowState({fullscreen:true});
  await evaluate(`(()=>{const button=document.querySelector('[data-window-action="maximize"]');button.focus();button.dispatchEvent(new PointerEvent('pointerenter'));button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));return true})()`);
  await waitWindowState({maximized:false,fullscreen:false});
  const pointerFocus=await evaluate(`(()=>{const button=document.querySelector('[data-window-action="maximize"]');return {focused:document.activeElement===button,hovered:button.classList.contains('is-hovered')}})()`);
  assert.equal(pointerFocus.focused,false);assert.equal(pointerFocus.hovered,false);
  await evaluate(`(()=>{const button=document.querySelector('[data-window-action="maximize"]');button.focus();button.click();return true})()`);
  await waitWindowState({maximized:true,fullscreen:false});
  assert.equal(await evaluate(`document.activeElement===document.querySelector('[data-window-action="maximize"]')`),true,'Keyboard activation must retain focus');
  await evaluate(`document.querySelector('[data-window-action="maximize"]').click()`);
  await waitWindowState({maximized:false,fullscreen:false});
  await evaluate(`document.querySelector('[data-window-action="maximize"]').blur()`);
  console.log('PASS: maximize/restore, F11 full screen, external state changes and no stuck pointer focus');
  const providerAppearance=await evaluate(`({ids:[...document.querySelectorAll('.agents-usage .agent-mark')].map(x=>x.dataset.provider),icons:[...document.querySelectorAll('.agents-usage .agent-mark img')].map(x=>({loaded:x.complete&&x.naturalWidth>0,local:x.src.startsWith('data:')||new URL(x.src,location.href).origin===location.origin}))})`);
  assert.deepEqual(providerAppearance.ids,['claude','codex','antigravity']);assert.equal(providerAppearance.icons.length,3);assert.ok(providerAppearance.icons.every(x=>x.loaded&&x.local),'Provider icons must be bundled and decoded: '+JSON.stringify(providerAppearance));
  console.log('PASS: Claude / Codex / Antigravity order, bundled real logos and no Gemini');
  const usageLayout=await evaluate(`(()=>{const block=document.querySelector('.agents-usage');return {height:block?.getBoundingClientRect().height,rows:[...document.querySelectorAll('.agent-usage')].map(row=>({height:row.getBoundingClientRect().height,head:row.querySelector('.agent-usage-head').getBoundingClientRect().right,bars:[...row.querySelectorAll('.mini-bar')].map(bar=>bar.getBoundingClientRect().left)}))}})()`);
  assert.ok(usageLayout.height<=usageLayout.rows.length*36,'Account limit block must remain compact: '+JSON.stringify(usageLayout));
  assert.ok(usageLayout.rows.every(row=>row.height<=34&&row.bars[0]>=row.head),'Account labels must not overlap limit columns');
  console.log('PASS: compact account limits retain separate period columns:',JSON.stringify(usageLayout));
  const checkFile=path.join(profile,'check.txt');fs.writeFileSync(checkFile,'NATIVE_FILE_OK');
  const file=await evaluate(`window.desk.filesRead(${JSON.stringify(checkFile)})`);
  assert.ok(JSON.stringify(file).includes('NATIVE_FILE_OK'));
  await evaluate(`window.desk.filesWrite(${JSON.stringify(checkFile)},'RUST_FILE_WRITE_OK')`);
  assert.equal(fs.readFileSync(checkFile,'utf8'),'RUST_FILE_WRITE_OK');
  await evaluate(`(async()=>{window.__nativeFileChanged=new Promise(resolve=>{const off=window.desk.onFileChanged(p=>{if(p.path===${JSON.stringify(checkFile)}){off();resolve(true)}})});await window.desk.filesWatch(${JSON.stringify(checkFile)});return true})()`);
  fs.writeFileSync(checkFile,'NATIVE_FILE_OK');
  assert.equal(await evaluate(`window.__nativeFileChanged`),true);
  await evaluate(`window.desk.filesUnwatch(${JSON.stringify(checkFile)})`);
  const nativeSearch=await evaluate(`window.desk.call('search:query',{q:'NATIVE_RUST_SEARCH_OK ПРИВЕТ'})`);
  assert.equal(nativeSearch[0]?.uuid,'native-search-message');
  const nativeCore=await evaluate(`window.desk.call('desk:native-core')`);
  assert.equal(nativeCore.search.storage,'sqlite');assert.ok(nativeCore.nativeChannels.includes('search:query'));assert.ok(nativeCore.requests.rust>=6);
  assert.equal(nativeCore.legacyNodeCore,false);assert.equal(nativeCore.remainingNodeChannels.length,0);
  assert.ok(nativeCore.delivery.queuedBytes>=0&&nativeCore.delivery.queuedBytes<=nativeCore.delivery.maxBytes);
  console.log('PASS: Rust file read/write/watch, disk-backed Unicode search and no legacy command fallback');
  const terminal=await evaluate(`new Promise(async(resolve,reject)=>{const id='native-terminal-test';let output='';const off=window.desk.onTermData(p=>{if(p.id===id)output+=p.data});const exited=window.desk.onTermExit(p=>{if(p.id===id){off();exited();resolve(output.includes('NATIVE_PTY_OK'))}});try{await window.desk.termCreate({id,cwd:${JSON.stringify(profile)},cols:80,rows:24});await window.desk.termWrite(id,"Write-Output ('NATIVE_'+'PTY_OK'); exit\\r")}catch(e){off();exited();reject(e)}})`);
  assert.equal(terminal,true,'Native Rust PTY failed');
  console.log('PASS: file access and native Rust terminal');
  await evaluate(`(async()=>{await window.desk.browserSetBounds({x:650,y:100,width:500,height:600});await window.desk.browserSetVisible(true,'native-test');await window.desk.browserNavigate(${JSON.stringify(browserURL)},'native-test');return true})()`);
  let browser;
  for(let n=0;n<100;n++){
    browser=await evaluate(`window.desk.browserState('native-test')`);
    if(browser.title==='Duet native browser test')break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(browser.title,'Duet native browser test');
  const capture=await evaluate(`window.desk.browserScreenshot('native-test')`);
  assert.ok(capture?.startsWith('iVBOR'),'Native browser capture did not return a PNG');
  fs.writeFileSync(path.join(profile,'browser.png'),Buffer.from(capture,'base64'));
  console.log('PASS: native child webview navigation and page-only PNG capture');
  const denial=await Promise.race([permissionResult,new Promise(r=>setTimeout(()=>r('NO_RESULT'),5000))]);
  assert.equal(denial,'DENIED','Remote web pages must not reach application RPC');
  console.log('PASS: untrusted web content cannot call the agent/file service');
  const eagerPanels=await evaluate(`performance.getEntriesByType('resource').filter(x=>/\\/(FilesPanel|TerminalPanel|Settings)-/.test(x.name)).map(x=>x.name)`);
  assert.equal(eagerPanels.length,0,'Closed editor, terminal and settings must not load on startup');
  await evaluate(`window.__deskStore.setState({settingsOpen:true})`);
  let settingsLoaded=false;
  for(let n=0;n<100;n++){
    if(await evaluate(`!!document.querySelector('.settings-modal,.settings')`)){settingsLoaded=true;break;}
    await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(settingsLoaded,true,'Deferred settings did not open');
  await evaluate(`window.__deskStore.setState({settingsOpen:false});window.__deskStore.getState().openFile(${JSON.stringify(checkFile)})`);
  let editorLoaded=false;
  for(let n=0;n<100;n++){
    if(await evaluate(`document.querySelector('.cm-editor')?.textContent.includes('NATIVE_FILE_OK')`)){editorLoaded=true;break;}
    await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(editorLoaded,true,'Deferred file editor did not load its document');
  await evaluate(`window.__deskStore.getState().setSettings({changesOpen:false})`);
  console.log('PASS: heavy panels load on demand; settings and file editor open correctly');
  await testBrowserUI(evaluate,browserURL,profile,async()=>{const shot=await rpc('Page.captureScreenshot',{format:'png'});if(shot.result?.data){fs.writeFileSync(path.join(profile,'browser-tabs-sleep.png'),Buffer.from(shot.result.data,'base64'));console.log('Browser tab screenshot:',path.join(profile,'browser-tabs-sleep.png'));}});
  await testCodexUI(evaluate,profile);
  await testPasteUI(evaluate,profile);
  await testTeamUI(evaluate);
  await testSteeringUI(evaluate);
  await testRecoveryUI(evaluate);
  const stress=await evaluate(`(${(async function(){
    const store=window.__deskStore, before=store.getState(), id=before.activeId;
    const entries=Array.from({length:400},(_,n)=>({kind:'turn',id:'native-old'+n,provider:'claude',done:true,startedAt:n,items:[{kind:'text',id:'prior'+n,text:'Previous response',confirmed:true}]}));
    entries.push({kind:'turn',id:'native-live',provider:'claude',done:false,startedAt:1000,items:[]});
    const agents=Object.fromEntries(Array.from({length:200},(_,n)=>['native-a'+n,{id:'native-a'+n,name:'Agent '+n,prompt:'',color:n,status:'running',startedAt:Date.now(),toolUses:0,items:[]}]));
    store.setState({threads:{[id]:{...before.threads[id],entries,agents,status:'running'}},panelTab:'agents'});
    let commits=0;const off=store.subscribe((next,prev)=>{if(next.threads!==prev.threads)commits++});
    const started=performance.now();
    for(let n=0;n<10000;n+=128){
      window.__duetDeliver('agent:events',Array.from({length:Math.min(128,10000-n)},(_,k)=>({threadId:id,ev:{type:'text',agent:'native-a'+((n+k)%200),id:'answer',text:'x',mode:'delta'}})));
    }
    for(let n=0;n<500;n++){
      if(store.getState().threads[id].agents['native-a199'].items.at(-1)?.text==='x'.repeat(50))break;
      await new Promise(r=>setTimeout(r,10));
    }
    await new Promise(r=>setTimeout(r,100));
    const thread=store.getState().threads[id];
    const result={complete:Object.values(thread.agents).every(a=>a.items.at(-1)?.text==='x'.repeat(50)),sameHistory:thread.entries===entries,commits,ms:Math.round(performance.now()-started),mountedTurns:document.querySelectorAll('.turn').length,failed:!!document.querySelector('.ui-failure')};
    off();store.setState({threads:before.threads,activeId:before.activeId,panelTab:before.panelTab});return result;
  }).toString()})()`);
  assert.equal(stress.complete,true);assert.equal(stress.sameHistory,true);assert.equal(stress.failed,false);assert.ok(stress.mountedTurns<=40);assert.ok(stress.commits<200);
  console.log('PASS: native UI 200 agents / 10000 events:',JSON.stringify(stress));
  if(process.argv.includes('--provider-smoke')){
    await evaluate(`window.desk.closeThread('native-test')`);
    await evaluate(`(()=>{const s=window.__deskStore;const id=s.getState().newThread(${JSON.stringify(profile)});s.getState().switchProvider(id,'codex');window.__nativeSmoke=id;s.getState().send(id,'Reply with exactly DUET_NATIVE_SUBSCRIPTION_OK. Do not use tools or read files.',[]);return true})()`);
    const waitTurn=async()=>{
      for(let n=0;n<1200;n++){
        const state=await evaluate(`(()=>{const t=window.__deskStore.getState().threads[window.__nativeSmoke];return {status:t.status,error:t.entries.at(-1)?.error,text:t.entries.at(-1)?.items?.filter(x=>x.kind==='text').map(x=>x.text).join(''),sessionId:t.sessionId}})()`);
        if(state.status==='idle')return state;
        await new Promise(r=>setTimeout(r,100));
      }throw new Error('Native provider turn timed out');
    };
    const first=await waitTurn();assert.ok(first.text?.includes('DUET_NATIVE_SUBSCRIPTION_OK'),JSON.stringify(first));
    await evaluate(`window.__deskStore.getState().send(window.__nativeSmoke,'What exact token did you reply with? Reply with that token only. No tools.',[])`);
    const second=await waitTurn();assert.equal(second.sessionId,first.sessionId);assert.ok(second.text?.includes('DUET_NATIVE_SUBSCRIPTION_OK'));
    await evaluate(`window.desk.closeThread(window.__nativeSmoke)`);
    await evaluate(`window.desk.deleteSession(${JSON.stringify(first.sessionId)},${JSON.stringify(profile)},'codex')`);
    console.log('PASS: real subscription response and multi-turn context through the native shell (test session archived)');
  }
  const screenshot=await rpc('Page.captureScreenshot',{format:'png'});
  if(screenshot.result?.data){fs.writeFileSync(path.join(profile,'ui.png'),Buffer.from(screenshot.result.data,'base64'));console.log('Screenshot:',path.join(profile,'ui.png'));}
  await rpc('Runtime.evaluate',{expression:`window.__TAURI_INTERNALS__.invoke('window_control',{action:'close'})`,awaitPromise:false});
  ws.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);
  assert.equal(child.exitCode,0,'Native application must exit normally after closing its main window');
  console.log('PASS: native shutdown exits normally');
}finally{clearTimeout(timer);server.close();if(child.exitCode===null)child.kill();}

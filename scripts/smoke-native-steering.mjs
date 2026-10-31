// Opt-in real subscription verification. Creates and archives only this test's sessions.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('../',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'duet-team-subscription-'));
const env={...process.env,DUET_DRIVER_EVENTS:'1',DUET_DRIVER_HOME:os.homedir()};delete env.DUET_CLAUDE_BIN;delete env.DUET_CODEX_BIN;
const child=spawn(path.join(repo,'src-tauri/target/debug/examples/core_driver'+(process.platform==='win32'?'.exe':'')),[root],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
const pending=[],events=[],listeners=[],sessions=new Map(),roots=[];let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-8000));
const call=(channel,...args)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('IPC timeout '+channel)),150000);pending.push({resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});child.stdin.write(JSON.stringify({channel,args})+'\n');});
createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);if(!message.event){const req=pending.shift();return message.error?req.reject(Error(message.error)):req.resolve(message.result);}
 events.push(message);const p=message.payload,ev=p?.ev;
 if(ev?.type==='session')sessions.set(ev.sessionId,roots.find(r=>r.threadId===p.threadId)?.provider);
 if(ev?.type==='agent'&&ev.sessionId&&ev.provider)sessions.set(ev.sessionId,ev.provider);
 if(message.event==='agent:permission'){
  const own=roots.some(r=>r.threadId===p.threadId),internal=String(p.toolName).startsWith('mcp__desk-agents__');
  void call('agent:respondPermission',{threadId:p.threadId,reqId:p.reqId,decision:own&&internal?'allow':'deny',message:'Only internal team tools are allowed in this read-only smoke.'}).catch(()=>{});
 }
 for(const fn of [...listeners])fn();
});
function wait(predicate){if(events.some(predicate))return Promise.resolve(events.find(predicate));return new Promise((resolve,reject)=>{const fn=()=>{const hit=events.find(predicate);if(hit){clearTimeout(timer);listeners.splice(listeners.indexOf(fn),1);resolve(hit)}};const timer=setTimeout(()=>{listeners.splice(listeners.indexOf(fn),1);reject(Error('Real team timeout '+JSON.stringify(events.slice(-5))+' '+stderr));},180000);listeners.push(fn);});}
try{
 for(const provider of ['claude','codex']){
  const token=randomUUID().replaceAll('-','').slice(0,12),spec={threadId:'steer-smoke-'+randomUUID(),provider,cwd:root,model:'default',permissionMode:'plan'};roots.push(spec);
  console.log('Starting real steering smoke:',provider);const at=events.length;
  await call('agent:send',{...spec,text:'Explain briefly why 2+2 equals 4. Do not use any tools, files or network.'});
  await wait(e=>events.indexOf(e)>=at&&e.payload?.threadId===spec.threadId&&e.payload.ev?.type==='step');
  const uuid=randomUUID(),sentAt=Date.now();await call('agent:send',{...spec,uuid,priority:'next',text:'Additional instruction: include exactly NOTE_'+token+' in your final answer. Do not use tools.'});
  const receipt=await wait(e=>e.payload?.threadId===spec.threadId&&e.payload.ev?.type==='message.receipt'&&e.payload.ev.id===uuid);
  assert.equal(receipt.payload.ev.status,'accepted',JSON.stringify(receipt));
  const result=await wait(e=>events.indexOf(e)>=at&&e.payload?.threadId===spec.threadId&&e.payload.ev?.type==='turn.end'&&e.payload.ev.text?.includes('NOTE_'+token));assert.equal(result.payload.ev.isError,false,JSON.stringify(result));
  assert.ok(!events.slice(at).some(e=>e.event==='agent:closed'&&e.payload.threadId===spec.threadId));
  console.log('PASS real',provider,'mid-turn accepted in',receipt.payload.ev.timestamp-sentAt,'ms, answer includes follow-up');await call('agent:closeThread',spec.threadId);
 }
}finally{
 for(const spec of roots){try{await call('agent:closeThread',spec.threadId)}catch{}}
 for(const [sid,provider]of sessions){if(!provider)continue;try{await call('agent:deleteSession',sid,root,provider)}catch(e){console.error('Own session cleanup:',sid,e.message)}}
 child.stdin.end();await new Promise(r=>child.once('exit',r));console.log('Own team smoke data:',root);
}

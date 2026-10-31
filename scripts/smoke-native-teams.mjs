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
  const token=randomUUID().replaceAll('-','').slice(0,12),other=provider==='claude'?'codex':'claude',spec={threadId:'team-smoke-'+randomUUID(),provider,cwd:root,model:'default',permissionMode:'plan'};roots.push(spec);
  const task=`This is an isolated Duet integration test. Do not edit files, use shell, browse, read secrets or delegate. Call the desk-agents message_agent tool exactly once with run_id=parent and message=ACK_${token}. Then finish with CHILD_${token}.`;
  const prompt=`Read-only Duet integration test. Do not use files, shell or network. Use the desk-agents run_agent tool exactly once with agent=${other}, read_only=true, background=false and this exact task: ${task}\nAfter it completes, call desk-agents agent_events once with after=0 and limit=10 to verify its event stream. If the child is still running, use wait_agent. Your final answer must contain ROOT_${token}, the child's CHILD token and the received ACK token. Do not create more than one child.`;
  console.log('Starting real team smoke:',provider,'→',other);
  const at=events.length;await call('agent:send',{...spec,text:prompt});const end=await wait(e=>events.indexOf(e)>=at&&e.payload?.threadId===spec.threadId&&e.payload.ev?.type==='turn.end');
  assert.equal(end.payload.ev.isError,false,JSON.stringify(end));assert.match(end.payload.ev.text,new RegExp('ROOT_'+token));assert.match(end.payload.ev.text,new RegExp('CHILD_'+token));assert.match(end.payload.ev.text,new RegExp('ACK_'+token));
  const own=events.slice(at).filter(e=>e.payload?.threadId===spec.threadId);
  assert.ok(own.some(e=>e.payload.ev?.type==='agent.msg'&&e.payload.ev.text==='ACK_'+token&&e.payload.ev.dir==='from'),'Child message never reached root');
  assert.ok(own.some(e=>e.payload.ev?.type==='tool'&&e.payload.ev.name?.endsWith('__agent_events')),'Root did not read the event stream');
  console.log('PASS real',provider,'↔',other,'delegation, child message, full event replay and root response');await call('agent:closeThread',spec.threadId);
 }
}finally{
 for(const spec of roots){try{await call('agent:closeThread',spec.threadId)}catch{}}
 for(const [sid,provider]of sessions){if(!provider)continue;try{await call('agent:deleteSession',sid,root,provider)}catch(e){console.error('Own session cleanup:',sid,e.message)}}
 child.stdin.end();await new Promise(r=>child.once('exit',r));console.log('Own team smoke data:',root);
}

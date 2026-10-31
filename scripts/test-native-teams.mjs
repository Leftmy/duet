// Native Rust transport with deterministic CLI peers. No real subscriptions or user projects.
import {createNativeFixtures} from './native-fixtures.mjs';
import fs from 'node:fs';
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('../',import.meta.url)),{root,env}=createNativeFixtures();
const child=spawn(path.join(repo,'src-tauri/target/debug/examples/core_driver'+(process.platform==='win32'?'.exe':'')),[root],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-8000));const pending=[],events=[],listeners=[];
createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);if(message.event){events.push(message);for(const listener of [...listeners])listener();}else{const request=pending.shift();if(message.error)request.reject(Error(message.error));else request.resolve(message.result);}});
function call(channel,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Core IPC timeout '+channel+' '+stderr)),20000);pending.push({resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});child.stdin.write(JSON.stringify({channel,args})+'\n');});}
function wait(predicate,ms=15000){const hit=events.find(predicate);if(hit)return Promise.resolve(hit);return new Promise((resolve,reject)=>{const listener=()=>{const hit=events.find(predicate);if(hit){clearTimeout(timer);listeners.splice(listeners.indexOf(listener),1);resolve(hit)}};const timer=setTimeout(()=>{listeners.splice(listeners.indexOf(listener),1);reject(Error('Team event timeout '+JSON.stringify(events.slice(-5))+' '+stderr));},ms);listeners.push(listener);});}
async function stable(thread){for(let n=0;n<150;n++){const length=events.length;await new Promise(r=>setTimeout(r,20));const own=events.filter(e=>e.payload?.threadId===thread&&!e.payload.ev?.agent&&['step','turn.end'].includes(e.payload.ev?.type));if(own.at(-1)?.payload.ev.type!=='step'&&events.length===length)return;}throw Error('Root never became idle');}
async function operation(thread,provider,name,args={},cancel=false){await stable(thread);const at=events.length;await call('agent:send',{threadId:thread,provider,cwd:root,permissionMode:'plan',text:'TEAM '+JSON.stringify({name,args,cancel})});const end=await wait(e=>events.indexOf(e)>=at&&e.payload?.threadId===thread&&e.payload.ev?.type==='turn.end'&&e.payload.ev.text?.startsWith('TEAM_RESULT '));assert.equal(end.payload.ev.isError,false,JSON.stringify(end));const text=end.payload.ev.text.slice('TEAM_RESULT '.length);try{return JSON.parse(text)}catch{return {tool_error:text}}}
try{
 for(const parentProvider of ['claude','codex']){
  const id='team-'+parentProvider,other=parentProvider==='claude'?'codex':'claude';
  const direct=await operation(id,parentProvider,'run_agent',{agent:other,task:'TEAM_CHILD_MESSAGE'});assert.equal(direct.status,'done');assert.match(direct.text,/TEAM_CHILD_DONE/);assert.ok(direct.events.some(e=>e.event?.type==='message.sent'));
  assert.ok(direct.events.some(e=>e.event?.type==='message.queued'&&e.event.message?.text==='CHILD_TO_PARENT_OK'),'inline waits deliver child messages without a duplicate wake-up turn');
  const nested=await operation(id,parentProvider,'run_agent',{agent:other,task:'TEAM_NEST'});assert.equal(nested.status,'done');assert.match(nested.text,/TEAM_NEST_DONE/);
  const replay=await operation(id,parentProvider,'agent_events',{after:0,limit:200});assert.ok(replay.events.some(e=>e.event?.type==='message.sent'&&e.event.text==='GRANDCHILD_TO_ROOT_OK'));assert.ok(replay.events.some(e=>e.parent_id&&e.parent_id!==id));
  const catalogue=await operation(id,parentProvider,'list_agents');assert.ok(catalogue.agents.length>=4);assert.equal(catalogue.root,id);
  const denied=await operation(id,parentProvider,'message_agent',{run_id:'other-user-chat',message:'forbidden'});assert.match(denied.tool_error,/Unknown run_id in this team/);
  const started=Date.now();const cancelled=await operation(id,parentProvider,'agent_events',{after:9007199254740000,timeout_sec:60},true);assert.equal(cancelled.status,'cancelled');assert.ok(Date.now()-started<2000);
  console.log('PASS',parentProvider,'↔',other,'parent messages, nested/root events, cancellation and family isolation');
  await call('agent:closeThread',id);
 }
 const id='team-concurrent';let provider='claude';
 const held=await operation(id,provider,'run_agent',{agent:'codex',task:'TEAM_HOLD',background:true});assert.equal(held.status,'running');
 const queued=await operation(id,provider,'message_agent',{run_id:held.run_id,message:'ROOT_TO_BUSY_CHILD_OK'});assert.equal(queued.status,'queued');
 const sibling=await operation(id,provider,'run_agent',{agent:'claude',task:'TEAM '+JSON.stringify({name:'message_agent',args:{run_id:held.run_id,message:'SIBLING_TO_CHILD_OK'}})});assert.equal(sibling.status,'done');
 const waiting=await operation(id,provider,'list_agents');assert.ok(waiting.agents.some(a=>a.run_id===held.run_id&&a.queued_messages>=1),JSON.stringify(waiting));
 await stable(id);await call('desk:switch-provider',{threadId:id,provider:'codex'});provider='codex';
 const switched=await operation(id,provider,'list_agents');assert.ok(switched.agents.some(a=>a.run_id===held.run_id),'hot switch retains delegated work');
 await wait(e=>e.payload?.threadId===id&&e.payload.ev?.type==='text'&&e.payload.ev.agent&&e.payload.ev.text?.includes('ROOT_TO_BUSY_CHILD_OK'));
 const all=await operation(id,provider,'agent_events',{after:0,limit:200});const target=all.events.filter(e=>e.run_id===held.run_id);
 assert.ok(target.some(e=>e.event.type==='codex.state'&&e.event.state?.plan)||target.some(e=>JSON.stringify(e).includes('CHILD_PLAN_OK')),'plan reaches the root journal');
 assert.ok(target.some(e=>e.event.type==='tool.output'&&e.event.chunk==='CHILD_OUTPUT_OK'));
 assert.ok(target.some(e=>e.event.type==='message.delivered'));
 assert.ok(target.some(e=>JSON.stringify(e).includes('SIBLING_TO_CHILD_OK')));
 for(const leaf of ['antigravity']){const result=await operation(id,provider,'run_agent',{agent:leaf,task:'leaf fixture task'});assert.equal(result.status,'done');assert.match(result.text,/leaf fixture task/);}
 const disabled=await operation(id,provider,'run_agent',{agent:'gemini',task:'must not launch'});assert.match(disabled.tool_error,/Invalid input agent/);
 const stopped=await operation(id,provider,'run_agent',{agent:'codex',task:'TEAM_HOLD_LONG',background:true});
 const session=await wait(e=>e.payload?.threadId===id&&e.payload.ev?.type==='agent'&&e.payload.ev.runId===stopped.run_id&&e.payload.ev.sessionId);
 await call('agent:send',{threadId:id,delegate:stopped.run_id,text:'OLD_UI_PENDING'});
 const stopAt=events.length;const stopping=call('agent:stopTask',id,stopped.run_id);
 await wait(e=>events.indexOf(e)>=stopAt&&e.payload?.threadId===id&&e.payload.ev?.runId===stopped.run_id&&e.payload.ev.status==='stopped');
 // Release startup only after observing stop: no timing assumptions or retries.
 fs.writeFileSync(path.join(root,'codex-start-release-'+session.payload.ev.sessionId),'release');
 await stopping;
 await new Promise(r=>setTimeout(r,50));
 assert.ok(!events.slice(stopAt).some(e=>e.payload?.threadId===id&&((e.payload.ev?.runId===stopped.run_id&&e.payload.ev.status==='running')||(e.payload.ev?.agent===session.payload.ev.id&&e.payload.ev.type==='step'))),'Stopped agent must reject late startup/step callbacks');
 const tracePath=path.join(root,'codex-control-trace.jsonl');let trace=[];for(let n=0;n<100;n++){trace=fs.existsSync(tracePath)?fs.readFileSync(tracePath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];if(trace.some(e=>e.method==='thread/unsubscribe'&&e.params.threadId===session.payload.ev.sessionId))break;await new Promise(r=>setTimeout(r,10));}
 const own=trace.filter(e=>e.params.threadId===session.payload.ev.sessionId);assert.deepEqual(own.slice(-2).map(e=>e.method),['turn/interrupt','thread/unsubscribe']);
 const resumedAt=events.length;await call('agent:send',{threadId:id,delegate:stopped.run_id,text:'UI_AGENT_RESUMED_OK'});
 await wait(e=>events.indexOf(e)>=resumedAt&&e.payload?.threadId===id&&e.payload.ev?.type==='text'&&e.payload.ev.agent&&e.payload.ev.text?.includes('UI_AGENT_RESUMED_OK'));
 assert.ok(!events.slice(resumedAt).some(e=>e.payload.ev?.type==='text'&&e.payload.ev.agent&&e.payload.ev.text?.includes('OLD_UI_PENDING')));
 await call('agent:closeThread',id);const status=await call('desk:native-core');assert.equal(status.agents.liveRuns,0);assert.equal(status.agents.pendingPermissions,0);
 console.log('PASS busy mailboxes, sibling delivery, root wake-up, live plans/output, three enabled providers, provider hot switch, UI messaging and native Codex interrupt-before-unsubscribe');
 child.stdin.end();await new Promise(r=>child.once('exit',r));assert.equal(child.exitCode,0,stderr);
}finally{if(child.exitCode===null)child.kill();console.log('Team fixtures:',root);}

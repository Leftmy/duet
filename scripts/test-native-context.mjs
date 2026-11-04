import {createNativeFixtures} from './native-fixtures.mjs';
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('../',import.meta.url)),{root,env}=createNativeFixtures();
const binary=path.join(repo,'src-tauri/target/debug/examples/core_driver'+(process.platform==='win32'?'.exe':''));
let child,pending=[],events=[],listeners=[],stderr='';
function start(){child=spawn(binary,[root],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.on('data',b=>stderr=(stderr+b).slice(-6000));createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.event){events.push(m);for(const fn of [...listeners])fn();}else{const p=pending.shift();if(m.error)p.reject(Error(m.error));else p.resolve(m.result);}});}
function call(channel,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Context IPC timeout '+channel+' '+stderr)),15000);pending.push({resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});child.stdin.write(JSON.stringify({channel,args})+'\n');});}
function wait(predicate){const hit=events.find(predicate);if(hit)return Promise.resolve(hit);return new Promise((resolve,reject)=>{const listener=()=>{const hit=events.find(predicate);if(hit){clearTimeout(timer);listeners.splice(listeners.indexOf(listener),1);resolve(hit);}};const timer=setTimeout(()=>{listeners.splice(listeners.indexOf(listener),1);reject(Error('Context event timeout '+JSON.stringify(events.slice(-3))+' '+stderr));},15000);listeners.push(listener);});}
const api=(id,provider,action,extra={})=>call('desk:context',{threadId:id,provider,action,cwd:root,...extra});
async function send(id,provider,text,extra={}){const at=events.length;await call('agent:send',{threadId:id,provider,text,cwd:root,model:'fake-model',permissionMode:'default',...extra});return wait(e=>events.indexOf(e)>=at&&e.payload?.threadId===id&&e.payload.ev?.type==='turn.end');}
const inputs=()=>fs.readFileSync(path.join(root,'context-inputs.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
async function jobState(id,provider,job,status){for(let n=0;n<150;n++){const value=await api(id,provider,'job',{job_id:job});if(value.status===status)return value;if(value.status==='failed')throw Error(value.error);await new Promise(r=>setTimeout(r,20));}throw Error('Context job never reached '+status);}
async function seed(id,provider,extra=''){await send(id,provider,'CTX_SEED_LOG'+extra);const view=await api(id,provider,'inspect');const tool=view.blocks.find(b=>b.kind==='tool');assert.ok(tool,'Seed must capture a complete tool/result block for '+provider);assert.equal(tool.sealed,true);return {view,tool};}
start();
try{
 for(const provider of ['claude','codex','antigravity']){
  const id='context-'+provider,{view,tool}=await seed(id,provider);
  const oldSid=events.find(e=>e.payload?.threadId===id&&e.payload.ev?.type==='session').payload.ev.sessionId;
  await assert.rejects(api(id,provider,'edit',{expected_revision:view.revision,operations:[{action:'archive',ids:[view.blocks.find(b=>b.kind==='user').id]}]}),/protected/i);
  const response=await send(id,provider,'CONTEXT '+JSON.stringify({name:'edit',args:{expected_revision:view.revision,operations:[{action:'archive',ids:[tool.id]}]}}));
  assert.match(response.payload.ev.text,/CONTEXT_RESULT /,JSON.stringify(response.payload.ev));
  const parsed=JSON.parse(response.payload.ev.text.split('CONTEXT_RESULT ')[1]);assert.ok(parsed.job_id,JSON.stringify(parsed));
  await jobState(id,provider,parsed.job_id,'applied');
  await wait(e=>events.indexOf(e)>events.indexOf(response)&&e.payload?.threadId===id&&e.payload.ev?.type==='turn.end'&&!e.payload.ev.contextCheckpoint);
  const after=await api(id,provider,'inspect');assert.ok(after.revision>view.revision);assert.equal(after.managed,true);
  const rebuilt=inputs().find(i=>i.provider===provider&&i.text.includes('<duet_context_packet'));
  assert.ok(rebuilt,'Must actually rebuild the native provider input');assert.equal(rebuilt.text.includes('CONTEXT_OBSOLETE_CANARY'),false);assert.match(rebuilt.text,/KEEP_FACT/);
  const replacement=events.find(e=>e.payload?.threadId===id&&e.payload.ev?.contextReplacement)?.payload.ev;assert.ok(replacement);assert.equal(replacement.previousSessionId,oldSid);assert.notEqual(replacement.sessionId,oldSid);
  assert.match((await api(id,provider,'read',{id:tool.id})).text,/CONTEXT_OBSOLETE_CANARY/);
  const target=provider==='claude'?'codex':'claude';
  await call('desk:switch-provider',{threadId:id,provider:target,previousProvider:provider,previousSessionId:replacement.sessionId,cwd:root});
  const beforeSwitch=inputs().length;await send(id,target,'CTX_SWITCHED');const switched=inputs().slice(beforeSwitch).find(i=>i.provider===target);assert.ok(switched.text.includes('<duet_context_packet'));assert.equal(switched.text.includes('CONTEXT_OBSOLETE_CANARY'),false);
  await call('desk:switch-provider',{threadId:id,provider,previousProvider:target,resume:oldSid,cwd:root});
  const beforeBack=inputs().length;await send(id,provider,'CTX_BACK');assert.equal(inputs().slice(beforeBack).find(i=>i.provider===provider).text.includes('CONTEXT_OBSOLETE_CANARY'),false,'Returning to an old provider must not resurrect pruned data');
  const currentSid=events.filter(e=>e.payload?.threadId===id&&e.payload.ev?.type==='session').at(-1).payload.ev.sessionId;
  await call('desk:switch-provider',{threadId:id,provider:target,previousProvider:provider,previousSessionId:currentSid,cwd:root});
  await send(id,target,'CTX_INTERVENING_PROVIDER_MESSAGE');
  await call('desk:switch-provider',{threadId:id,provider,previousProvider:target,resume:currentSid,cwd:root});
  const beforeCurrent=inputs().length;await send(id,provider,'CTX_RETURN_TO_CURRENT_SID');
  assert.match(inputs().slice(beforeCurrent).find(i=>i.provider===provider).text,/CTX_INTERVENING_PROVIDER_MESSAGE/,'Returning to a previously current SID must include intervening provider messages');
  const undo=await api(id,provider,'restore',{job_id:parsed.job_id});await jobState(id,provider,undo.job_id,'ready');
  const beforeUndo=inputs().length;await send(id,provider,'CTX_RESTORED');await jobState(id,provider,undo.job_id,'applied');assert.ok(inputs().slice(beforeUndo).find(i=>i.provider===provider).text.includes('CONTEXT_OBSOLETE_CANARY'));
  await call('agent:closeThread',id);
  console.log('PASS '+provider+': model command, actual context exclusion, same-chat rotation, hot switch/back and undo');
 }
 for(const compressor of ['claude','codex','antigravity']){
  const id='compress-'+compressor,{view,tool}=await seed(id,'claude');
  const job=await api(id,'claude','edit',{expected_revision:view.revision,operations:[{action:'compress',ids:[tool.id],compressor:{provider:compressor,model:'fake-small'},target_tokens:800,preserve:['KEEP_FACT']}]});
  await jobState(id,'claude',job.job_id,'ready');const trace=inputs().find(i=>i.provider===compressor&&i.text.includes('Create a compact factual record'));
  assert.ok(trace,'Compressor must use requested subscription CLI '+compressor);
  if(compressor!=='codex')assert.ok(trace.args.includes('fake-small'));
  if(compressor==='claude')assert.ok(trace.args.includes('--tools'));
  if(compressor==='antigravity'){assert.ok(trace.args.includes('--settings'));assert.match(trace.args.join(' '),/write_file\(\*\)/);}
  const before=inputs().length;await send(id,'claude','CTX_AFTER_COMPRESSION');await jobState(id,'claude',job.job_id,'applied');
  const prompt=inputs().slice(before).find(i=>i.provider==='claude').text;assert.equal(prompt.includes('CONTEXT_OBSOLETE_CANARY'),false);assert.match(prompt,/KEEP_FACT/);
  await call('agent:closeThread',id);console.log('PASS selected '+compressor+' compressor, subscription auth, reduction and provenance');
 }
 const failed='failed-compression',{view:failedView,tool:failedTool}=await seed(failed,'claude',' CTX_COMPRESSION_FAIL');
 const failure=await api(failed,'claude','edit',{expected_revision:failedView.revision,operations:[{action:'compress',ids:[failedTool.id],compressor:{provider:'claude',model:'fake-small'},target_tokens:800}]});
 for(let n=0;n<100;n++){const j=await api(failed,'claude','job',{job_id:failure.job_id});if(j.status==='failed')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal((await api(failed,'claude','inspect')).revision,failedView.revision);assert.match((await api(failed,'claude','read',{id:failedTool.id})).text,/CONTEXT_OBSOLETE_CANARY/);await call('agent:closeThread',failed);
 console.log('PASS failed compression preserves original projection and sources');
 const cancelled='cancel-compression',{view:cancelView,tool:cancelTool}=await seed(cancelled,'claude',' CTX_DELAY');
 const cancelJob=await api(cancelled,'claude','edit',{expected_revision:cancelView.revision,operations:[{action:'compress',ids:[cancelTool.id],compressor:{provider:'claude',model:'fake-small'},target_tokens:800}]});
 for(let n=0;n<100;n++){if(inputs().some(i=>i.text.includes('Create a compact factual record')&&i.text.includes('CTX_DELAY')))break;await new Promise(r=>setTimeout(r,20));}
 await call('agent:interrupt',cancelled);
 assert.equal((await api(cancelled,'claude','job',{job_id:cancelJob.job_id})).status,'failed');
 assert.equal((await api(cancelled,'claude','inspect')).revision,cancelView.revision);
 await send('unrelated-after-cancel','codex','UNRELATED_STILL_WORKS');
 await call('agent:closeThread','unrelated-after-cancel');await call('agent:closeThread',cancelled);
 console.log('PASS stopping a context owner cancels its compressor without blocking unrelated chats');
 const persist='persistent-context',{view:persistView,tool:persistTool}=await seed(persist,'claude');
 const persisted=await api(persist,'claude','edit',{expected_revision:persistView.revision,operations:[{action:'archive',ids:[persistTool.id]}]});await jobState(persist,'claude',persisted.job_id,'ready');await send(persist,'claude','CTX_PERSIST');await jobState(persist,'claude',persisted.job_id,'applied');
 const sid=events.filter(e=>e.payload?.threadId===persist&&e.payload.ev?.type==='session').at(-1).payload.ev.sessionId;
 child.stdin.end();await new Promise(r=>child.once('exit',r));assert.equal(child.exitCode,0,stderr);pending=[];events=[];listeners=[];start();
 const reopened=await api(sid,'claude','inspect',{resume:sid});assert.equal(reopened.managed,true);assert.equal(reopened.blocks.some(b=>b.id===persistTool.id),false);assert.match((await api(sid,'claude','read',{id:persistTool.id})).text,/CONTEXT_OBSOLETE_CANARY/);
 await send(sid,'claude','CTX_REOPENED',{resume:sid});await call('agent:closeThread',sid);
 child.stdin.end();await new Promise(r=>child.once('exit',r));assert.equal(child.exitCode,0,stderr);
 console.log('PASS context aliases, active projection and archives survive restart without a new chat');
}finally{if(child.exitCode===null)child.kill();console.log('Context fixtures:',root);}

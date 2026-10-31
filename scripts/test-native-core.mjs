import {createNativeFixtures} from './native-fixtures.mjs';
// Real Rust core + deterministic subprocess fixtures. No user accounts, projects or running app are touched.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url));const {root,env}=createNativeFixtures();
const binary=path.join(repo,'src-tauri/target/debug/examples/core_driver'+(process.platform==='win32'?'.exe':''));const child=spawn(binary,[root],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',b=>{stderr+=b});const pending=[];const events=[];const updates=[];
createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.event){events.push(m);for(const fn of [...updates])fn();}else{const p=pending.shift();if(m.error)p.reject(new Error(m.error));else p.resolve(m.result)}});
function call(channel,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Core timeout: '+channel+' '+stderr)),15000);pending.push({resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});child.stdin.write(JSON.stringify({channel,args})+'\n')})}
function wait(predicate,ms=15000){if(events.some(predicate))return Promise.resolve(events.find(predicate));return new Promise((resolve,reject)=>{const done=()=>{const hit=events.find(predicate);if(hit){clearTimeout(timer);updates.splice(updates.indexOf(done),1);resolve(hit)}};const timer=setTimeout(()=>{updates.splice(updates.indexOf(done),1);reject(new Error('Event timeout '+JSON.stringify(events.slice(-6))+' '+stderr))},ms);updates.push(done)})}
const end=(thread,index=0)=>wait(m=>m.event==='agent:event'&&m.payload.threadId===thread&&m.payload.ev.type==='turn.end'&&events.filter(e=>e.event==='agent:event'&&e.payload.threadId===thread&&e.payload.ev.type==='turn.end').indexOf(m)>=index);
const send=(thread,provider,text,more={})=>call('agent:send',{threadId:thread,provider,cwd:root,text,permissionMode:'default',...more});
try{
 const probe=await call('agent:probe',true);for(const id of ['claude','codex','antigravity'])assert.equal(probe.providers[id].available,true,JSON.stringify(probe.providers[id]));assert.equal(probe.providers.gemini,undefined);await assert.rejects(send('disabled-gemini','gemini','must not start'),/Gemini is disabled/);await assert.rejects(call('agent:usage','gemini'),/Gemini is disabled/);await assert.rejects(call('desk:switch-provider',{threadId:'disabled-switch',provider:'gemini'}),/Gemini is disabled/);console.log('PASS enabled providers and disabled Gemini launch/usage/switch');
 for(const id of ['claude','codex','antigravity']){await send(id,id,'first');let e=await end(id);assert.equal(e.payload.ev.isError,false,JSON.stringify(e));assert.match(e.payload.ev.text,/first/);await send(id,id,'second');e=await end(id,1);assert.equal(e.payload.ev.isError,false,JSON.stringify(e));assert.match(e.payload.ev.text,/second/);}
 console.log('PASS native streaming and two-turn sessions for all three enabled providers');
 const codexSession=events.find(e=>e.payload?.threadId==='codex'&&e.payload.ev?.type==='session').payload.ev.sessionId;await call('agent:closeThread','codex');await send('codex','codex','resumed after close',{resume:codexSession});assert.match((await end('codex',2)).payload.ev.text,/resumed after close/);console.log('PASS native Codex close/resume keeps the same session');
 for(const id of ['claude','codex']){const thread=id+'-approval';await send(thread,id,'approve');const req=await wait(e=>e.event==='agent:permission'&&e.payload.threadId===thread);assert.equal(await call('agent:respondPermission',{threadId:'wrong',reqId:req.payload.reqId,decision:'allow'}),false);assert.equal(await call('agent:respondPermission',{threadId:thread,reqId:req.payload.reqId,decision:'allow'}),true);const result=await end(thread);assert.match(result.payload.ev.text,/allow|accept/);}
 console.log('PASS native permission broker and chat ownership');
 await send('patch-approval','codex','approve-patch');const patch=await wait(e=>e.event==='agent:permission'&&e.payload.threadId==='patch-approval');assert.equal(patch.payload.input.file_path,'fixture.rs');assert.equal(patch.payload.input.diff,'-old\n+new');await call('agent:respondPermission',{threadId:'patch-approval',reqId:patch.payload.reqId,decision:'deny'});await end('patch-approval');await call('agent:closeThread','patch-approval');
 await send('cancel-approval','claude','approve');const cancelled=await wait(e=>e.event==='agent:permission'&&e.payload.threadId==='cancel-approval');await call('agent:closeThread','cancel-approval');await wait(e=>e.event==='agent:permission-cancel'&&e.payload.reqId===cancelled.payload.reqId);await send('cancel-approval','codex','successor');assert.match((await end('cancel-approval')).payload.ev.text,/successor/);await call('agent:closeThread','cancel-approval');
 console.log('PASS native patch approval preview, cancellation and replacement run isolation');
 for(const kind of ['permissions','form','questions','legacy']){
  const thread='codex-'+kind;await send(thread,'codex',thread);const req=await wait(e=>e.event==='agent:permission'&&e.payload.threadId===thread);
  const updatedInput=kind==='form'?{content:{label:'Typed answer',count:2}}:kind==='questions'?{answerValues:{q1:['One, two'],q2:['secret, preserved']}}:{permissions:{fileSystem:{write:['/unrequested']}}};
  await call('agent:respondPermission',{threadId:thread,reqId:req.payload.reqId,decision:'allow',updatedInput});
  const reply=JSON.parse((await end(thread)).payload.ev.text);
  if(kind==='permissions'){assert.equal(reply.permissions.network.enabled,true);assert.equal(reply.permissions.fileSystem.write,null);assert.equal(reply.scope,'turn');}
  if(kind==='form'){assert.equal(reply.action,'accept');assert.deepEqual(reply.content,updatedInput.content);}
  if(kind==='questions'){assert.deepEqual(reply.answers.q1.answers,['One, two']);assert.deepEqual(reply.answers.q2.answers,['secret, preserved']);}
  if(kind==='legacy')assert.equal(reply.decision,'approved');await call('agent:closeThread',thread);
 }
 console.log('PASS Codex permission subsets, MCP typed forms, duplicate question titles, secrets and legacy approvals');
 const action=(name,more={})=>call('desk:codex',{threadId:'codex',action:name,...more});
 await action('compact');await end('codex',3);assert.equal((await call('desk:native-core')).agents.running,0);
 await action('review',{target:{type:'uncommittedChanges'}});assert.match((await end('codex',4)).payload.ev.text,/Review complete/);
 const goal=await action('goal/set',{objective:'Explicit user fixture goal',tokenBudget:1000});assert.equal(goal.goal.objective,'Explicit user fixture goal');assert.equal((await action('goal/set',{status:'paused'})).goal.status,'paused');await action('goal/clear');assert.equal((await action('goal/get')).goal,null);
 assert.equal((await action('mcp')).data[0].name,'fixture-mcp');assert.match((await action('mcp/login',{name:'fixture-mcp'})).authorizationUrl,/example.invalid/);
  assert.equal((await action('apps')).data[0].id,'fixture-app');assert.equal((await action('hooks')).data[0].hooks[0].key,'fixture-hook');
  assert.equal((await action('skill/config',{path:'/fixture/SKILL.md',enabled:false})).effectiveEnabled,false);
 await send('skill-input','codex','Use $native-skill');assert.match((await end('skill-input')).payload.ev.text,/Native skill selected/);await call('agent:closeThread','skill-input');
 assert.equal((await call('desk:codex',{action:'validate-form',schema:{type:'object',required:['enabled'],properties:{enabled:{type:'boolean'}}},content:{enabled:false}})).valid,true);
 await assert.rejects(call('desk:codex',{action:'validate-form',schema:{type:'object',required:['enabled']},content:{}}),/Required field/);
 console.log('PASS Codex compaction completion, review output, explicit goals, MCP discovery/OAuth and native skill inputs');
 await send('delegation','claude','delegate');const delegated=await end('delegation');assert.match(delegated.payload.ev.text,/Codex: child task/);assert.ok(events.some(e=>e.payload?.threadId==='delegation'&&e.payload.ev?.agent==='delegate-1'));console.log('PASS Claude MCP bridge delegates to native Codex and returns child transcript');
 await call('desk:switch-provider',{threadId:'claude',provider:'codex'});await send('claude','codex','hot switch');assert.match((await end('claude',2)).payload.ev.text,/hot switch/);console.log('PASS native hot switch on the same chat');
 const command=await call('cmd:write',{scope:'user',kind:'skill',name:'native-skill',text:'---\ndescription: Native fixture\n---\nBody'});assert.equal(command.description,'Native fixture');assert.equal((await call('cmd:list',null,'claude')).length,1);assert.ok((await call('cmd:delete',command.path)).ok);
 assert.equal((await call('agent:listSessions')).filter(s=>s.provider==='gemini'||s.provider==='antigravity').length,1);const stats=await call('stats:summary',30);assert.ok(stats.turns.length>=3);assert.equal(stats.turns.find(t=>t.turns===2).models[0].input,10);console.log('PASS native journals, usage deltas and command editor');
 for(const id of ['claude','codex','antigravity','gemini','claude-approval','codex-approval','delegation'])await call('agent:closeThread',id);
 assert.equal((await call('desk:native-core')).agents.liveRuns,0);child.stdin.end();await new Promise(r=>child.once('exit',r));assert.equal(child.exitCode,0,stderr);console.log('PASS native process cleanup');
}finally{if(child.exitCode===null){child.kill();}console.log('Fixtures:',root)}

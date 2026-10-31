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
 for(const provider of ['claude','codex']){
  const id='steer-'+provider;await send(id,provider,'STEER_HOLD_DELAY');
  const uuids=[];
  for(let n=0;n<3;n++){const uuid=crypto.randomUUID();uuids.push(uuid);await send(id,provider,'NOTE_'+n,{uuid,priority:'next'});}
  for(const uuid of uuids){const accepted=await wait(e=>e.payload?.threadId===id&&e.payload.ev?.type==='message.receipt'&&e.payload.ev.id===uuid&&e.payload.ev.status==='accepted');assert.ok(!events.some(e=>e.payload?.threadId===id&&e.payload.ev?.type==='turn.end'&&events.indexOf(e)<events.indexOf(accepted)),'Receipt must arrive while original generation is still working');}
  const result=await end(id);assert.match(result.payload.ev.text,/NOTE_0 \| NOTE_1 \| NOTE_2/);assert.ok(!events.some(e=>e.event==='agent:closed'&&e.payload.threadId===id));await call('agent:closeThread',id);
  console.log('PASS',provider,'FIFO mid-turn sends acknowledge before completion, without waiting for a model step');
 }
 const id='rejected-steer';await send(id,'codex','STEER_HOLD');const rejected=crypto.randomUUID();await send(id,'codex','STEER_REJECT',{uuid:rejected,priority:'next'});await wait(e=>e.payload?.threadId===id&&e.payload.ev?.type==='message.receipt'&&e.payload.ev.id===rejected&&e.payload.ev.status==='failed');
 assert.ok(!events.some(e=>e.event==='agent:closed'&&e.payload.threadId===id));assert.equal((await call('desk:native-core')).agents.running,1);
 const corrected=crypto.randomUUID();await send(id,'codex','AFTER_REJECT_OK',{uuid:corrected,priority:'next'});await wait(e=>e.payload?.threadId===id&&e.payload.ev?.id===corrected&&e.payload.ev.status==='accepted');assert.match((await end(id)).payload.ev.text,/AFTER_REJECT_OK/);await call('agent:closeThread',id);
 console.log('PASS rejected follow-up leaves the active Codex run and subsequent messages intact');
 const race='steer-finish-race';await send(race,'codex','STEER_HOLD_RACE_DELAY');const uuid=crypto.randomUUID();await send(race,'codex','RACE_NOTE_OK',{uuid,priority:'next'});await wait(e=>e.payload?.threadId===race&&e.payload.ev?.id===uuid&&e.payload.ev.status==='accepted');assert.match((await end(race)).payload.ev.text,/RACE_NOTE_OK/);
 await new Promise(r=>setTimeout(r,180));assert.equal(events.filter(e=>e.payload?.threadId===race&&e.payload.ev?.type==='turn.end').length,1);assert.ok(!events.some(e=>e.event==='agent:closed'&&e.payload.threadId===race));await call('agent:closeThread',race);
 console.log('PASS late start/completion notifications and steer-at-completion preserve one chat and deliver the follow-up once');
 child.stdin.end();await new Promise(r=>child.once('exit',r));assert.equal(child.exitCode,0,stderr);
}finally{if(child.exitCode===null)child.kill();console.log('Steering fixtures:',root);}

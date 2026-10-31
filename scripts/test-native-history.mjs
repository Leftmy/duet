// Frozen saved-event contracts, plus native paging, archival journals and compaction branches.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url));const root=fs.mkdtempSync(path.join(os.tmpdir(),'duet-rust-history-'));const claude=path.join(root,'home/.claude/projects/fixture');const codex=path.join(root,'home/.codex/sessions/2026/10/30');fs.mkdirSync(claude,{recursive:true});fs.mkdirSync(codex,{recursive:true});
function write(file,rows){fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n')}
const goldens=JSON.parse(fs.readFileSync(new URL('./fixtures/history-goldens.json',import.meta.url),'utf8'));
const sid=randomUUID(),rows=goldens.claude.rows,childRows=goldens.subagent.rows;
write(path.join(claude,sid+'.jsonl'),rows);
const sub=path.join(claude,sid,'subagents');fs.mkdirSync(sub,{recursive:true});write(path.join(sub,'agent-native-child.jsonl'),childRows);fs.writeFileSync(path.join(sub,'agent-native-child.meta.json'),JSON.stringify({toolUseId:'spawn'}));
const cid=randomUUID(),rid=randomUUID();
const hydrate=(rows,id)=>rows.map(row=>row.type==='session_meta'?{...row,payload:{...row.payload,id,cwd:root}}:row);
const rawFile=path.join(codex,'rollout-fixture-'+cid+'.jsonl');write(rawFile,hydrate(goldens.codexRaw.rows,cid));
const recordedFile=path.join(codex,'rollout-fixture-'+rid+'.jsonl');write(recordedFile,hydrate(goldens.codexRecorded.rows,rid));
const env={...process.env,CODEX_HOME:path.join(root,'home/.codex'),CLAUDE_CONFIG_DIR:path.join(root,'home/.claude')};delete env.DUET_DRIVER_HOME;delete env.DUET_DRIVER_EVENTS;const driver=spawn(path.join(repo,'src-tauri/target/debug/examples/core_driver'+(process.platform==='win32'?'.exe':'')),[root],{env,windowsHide:true});const pending=[];let stderr='';driver.stderr.on('data',b=>stderr+=b);createInterface({input:driver.stdout}).on('line',line=>{const v=JSON.parse(line);const p=pending.shift();v.error?p.reject(new Error(v.error)):p.resolve(v.result)});const call=(channel,...args)=>new Promise((resolve,reject)=>{pending.push({resolve,reject});driver.stdin.write(JSON.stringify({channel,args})+'\n')});
function normalize(events){return events.map(e=>{e=structuredClone(e);for(const key of Object.keys(e))if(e[key]===null||e[key]===undefined)delete e[key];if(['text','thinking'].includes(e.type))e.id='content';if(e.type!=='user'&&e.type!=='mark')delete e.timestamp;if(e.images)for(const i of e.images)delete i.id;return e})}
try{
 assert.deepEqual(normalize(await call('agent:loadSession',sid,null,null,'claude')),goldens.claude.events);console.log('PASS Claude saved events: messages, marks, thinking, tools, receipts, resumption, notifications, dropped agents');
 assert.deepEqual(normalize(await call('agent:loadSession',cid,null,null,'codex')),goldens.codexRaw.events);console.log('PASS raw Codex saved tools, shell results, patch and plans');
 assert.deepEqual(normalize(await call('agent:loadSession',rid,null,null,'codex')),goldens.codexRecorded.events);console.log('PASS recorded Codex items');
 const page=await call('agent:loadSubagentPage',sid,null,'claude','spawn',{limit:40});assert.equal(page.found,true);assert.deepEqual(normalize(page.events),goldens.subagent.events);assert.equal((await call('agent:loadSubagentPage',sid,null,'claude','missing',{})).found,false);console.log('PASS selected subagent transcript, parent mapping and handback');
 const tail=await call('agent:loadSessionPage',sid,null,null,'claude',{limit:1});assert.equal(tail.events.filter(e=>e.type==='user').length,1);assert.ok(tail.previous>1);const context=await call('desk:history-context',[{sessionId:sid,provider:'claude',cursor:tail.previous}]);assert.match(context,/Привет/);assert.match(context,/echo test/);console.log('PASS whole-turn history pages preserve older handoff context on disk');
 const fork=await call('agent:fork',{sessionId:sid,cwd:'',uuid:rows.at(-1).uuid,provider:'claude'});assert.notEqual(fork,sid);assert.deepEqual(normalize((await call('agent:loadSubagentPage',fork,null,'claude','spawn',{})).events),normalize(page.events));console.log('PASS native Claude fork preserves selected helper history');
 for(const provider of ['antigravity','gemini']){
  const dir=path.join(root,'data',provider);fs.mkdirSync(dir,{recursive:true});const meta={sessionId:(provider==='antigravity'?'agy-':'gem-')+randomUUID(),provider,cwd:root,title:'Legacy first turn',createdAt:1,lastModified:4};fs.writeFileSync(path.join(dir,meta.sessionId+'.json'),JSON.stringify(meta));
  const events=[{type:'user',uuid:randomUUID(),text:'Original goal',timestamp:1},{type:'text',id:'a',text:'First answer',mode:'final',timestamp:2},{type:'turn.end',text:'First answer'},{type:'user',uuid:randomUUID(),text:'Second request',timestamp:3},{type:'text',id:'b',text:'Second answer',mode:'final',timestamp:4},{type:'turn.end',text:'Second answer'}];
  write(path.join(dir,meta.sessionId+'.jsonl'),events);
  assert.deepEqual(await call('agent:loadSession',meta.sessionId,null,null,provider),events);
  await call('agent:rewindConversation',{threadId:'legacy-'+provider,provider,sessionId:meta.sessionId,dropTurns:1});
  assert.deepEqual(await call('agent:loadSession',meta.sessionId,null,null,provider),events.slice(0,3));
 }
 console.log('PASS existing Antigravity/Gemini journals and native rollback keep the previous format');
}finally{driver.stdin.end();await new Promise(r=>driver.once('exit',r));assert.equal(driver.exitCode,0,stderr);console.log('History fixtures:',root)}

// Actual Rust core, isolated CLI fixtures and temporary data only.
import {createNativeFixtures} from './native-fixtures.mjs';
import fs from 'node:fs';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {createInterface} from 'node:readline';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('../',import.meta.url)),{root,env}=createNativeFixtures();
const binary=path.join(repo,'src-tauri/target/debug/examples/core_driver'+(process.platform==='win32'?'.exe':''));let child,pending=[],events=[],listeners=[],stderr='';
function start(){child=spawn(binary,[root],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.on('data',b=>stderr=(stderr+b).slice(-6000));createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.event){events.push(m);for(const fn of [...listeners])fn();}else{const p=pending.shift();if(m.error)p.reject(Error(m.error));else p.resolve(m.result);}});}
function call(channel,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Workbench IPC timeout '+channel+' '+stderr)),15000);pending.push({resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});child.stdin.write(JSON.stringify({channel,args})+'\n');});}
function wait(predicate){const hit=events.find(predicate);if(hit)return Promise.resolve(hit);return new Promise((resolve,reject)=>{const listener=()=>{const hit=events.find(predicate);if(hit){clearTimeout(timer);listeners.splice(listeners.indexOf(listener),1);resolve(hit);}};const timer=setTimeout(()=>{listeners.splice(listeners.indexOf(listener),1);reject(Error('Workbench event timeout '+JSON.stringify(events.slice(-4))+' '+stderr));},15000);listeners.push(listener);});}
const api=(action,extra={})=>call('desk:workbench',{action,...extra});
const send=(id,provider,text,extra={})=>call('agent:send',{threadId:id,provider,text,cwd:root,model:'fake-model',permissionMode:'default',uuid:crypto.randomUUID(),...extra});
const event=(id,type,after=0)=>wait(e=>events.indexOf(e)>=after&&e.payload?.threadId===id&&e.payload.ev?.type===type);
async function idle(id){for(let n=0;n<200;n++){const row=(await api('inspect')).tasks.find(t=>t.id===id);if(row&&!row.working&&!row.queued)return;await new Promise(r=>setTimeout(r,10));}throw Error('Agent never became idle '+id);}
async function close(id){await call('agent:closeThread',id);}
start();
try{
 await api('limits',{limits:{total:1,project:1,team:1,provider:1,memoryMb:0}});
 await send('held','claude','STEER_HOLD');await event('held','step');
 await send('cancelled','codex','MUST_NOT_RUN');await send('next','antigravity','QUEUED_PROVIDER_OK');
 const queued=await api('inspect');assert.equal(queued.active,1);assert.equal(queued.queued,2);assert.ok(!queued.tasks.find(t=>t.id==='cancelled').pid,'Queued turn must not launch a CLI');assert.equal(queued.recovery.length,0,'Live queued input is not advertised for recovery');assert.ok(queued.resources.rssBytes>1024*1024);
 await call('agent:interrupt','cancelled');assert.equal((await api('inspect')).queued,1);
 const receipt=crypto.randomUUID();await send('held','claude','NOTE_DURING_HOLD',{priority:'next',uuid:receipt});await wait(e=>e.payload?.threadId==='held'&&e.payload.ev?.id===receipt&&e.payload.ev.status==='accepted');
 assert.ok(!events.some(e=>e.payload?.threadId==='held'&&e.payload.ev?.type==='turn.end'),'Queued other chats must not block steering');
 await event('next','turn.end');assert.ok(!events.some(e=>e.payload?.threadId==='cancelled'&&e.payload.ev?.type==='session'));await close('held');await close('cancelled');await close('next');
 console.log('PASS shared provider capacity, no process before admission, cancellation and active-turn steering');
 await send('permission','claude','approve');const approval=await wait(e=>e.event==='agent:permission'&&e.payload.threadId==='permission');
 fs.mkdirSync(path.join(root,'other-project'),{recursive:true});await send('other','codex','STEER_HOLD',{cwd:path.join(root,'other-project')});await event('other','step');assert.equal((await api('inspect')).active,1,'Approval waits release capacity');
 await call('agent:respondPermission',{threadId:'permission',reqId:approval.payload.reqId,decision:'allow'});await event('other','turn.end');await event('permission','turn.end');await close('permission');await close('other');
 console.log('PASS approval wait releases capacity and the answered turn resumes with a reserved slot');
 const rootId='one-slot-team';await send(rootId,'claude','TEAM '+JSON.stringify({name:'run_agent',args:{agent:'codex',task:'TEAM_CHILD_TO_ROOT'}}));
 const created=await wait(e=>e.payload?.threadId===rootId&&e.payload.ev?.type==='agent'&&e.payload.ev.runId);const childId=created.payload.ev.runId;
 await wait(e=>e.payload?.threadId===rootId&&e.payload.ev?.type==='turn.end'&&e.payload.ev.waitingAgents===true);
 await wait(e=>e.payload?.threadId===rootId&&e.payload.ev?.type==='agent'&&e.payload.ev.runId===childId&&e.payload.ev.status==='done');
 await wait(e=>e.payload?.threadId===rootId&&e.payload.ev?.type==='turn.end'&&!e.payload.ev.waitingAgents);
 assert.equal((await api('inspect')).tasks.find(t=>t.id===childId).role,'reviewer');await close(rootId);
 console.log('PASS one-slot delegation yields without deadlock, stays working and wakes the same parent');
 await send('readonly','claude','INITIAL');await event('readonly','turn.end');await idle('readonly');await api('role',{threadId:'readonly',role:'researcher'});
 await assert.rejects(call('agent:configure',{threadId:'readonly',provider:'claude',permissionMode:'bypassPermissions'}),/role|writes/i);
 let at=events.length;await send('readonly','claude','approve',{permissionMode:'bypassPermissions'});const rejected=await event('readonly','turn.end',at);assert.match(rejected.payload.ev.text,/deny/);assert.ok(!events.slice(at).some(e=>e.event==='agent:permission'));
 const inputs=fs.readFileSync(path.join(root,'context-inputs.jsonl'),'utf8').trim().split('\n').map(JSON.parse);const ro=inputs.filter(x=>x.provider==='claude'&&x.text==='approve').at(-1);assert.ok(ro.args.includes('--strict-mcp-config'));assert.ok(ro.args.includes('Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion,ExitPlanMode'));const readonlySid=events.find(e=>e.payload?.threadId==='readonly'&&e.payload.ev?.type==='session').payload.ev.sessionId;await idle('readonly');at=events.length;await send('readonly','codex','SWITCH_ROLE');await event('readonly','turn.end',at);assert.equal((await api('inspect')).tasks.find(t=>t.id==='readonly').role,'researcher');await close('readonly');
 console.log('PASS read-only roles survive permission overrides and deny write approvals at the native boundary');
 for(const provider of ['codex','antigravity']){
  const id='readonly-'+provider;at=events.length;await send(id,provider,'INITIAL');await event(id,'turn.end',at);await idle(id);await api('role',{threadId:id,role:'reviewer'});
  at=events.length;await send(id,provider,'approve',{permissionMode:'bypassPermissions'});const result=await event(id,'turn.end',at);assert.ok(!events.slice(at).some(e=>e.event==='agent:permission'));
  if(provider==='codex'){assert.match(result.payload.ev.text,/decline/);const trace=fs.readFileSync(path.join(root,'codex-launch-trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(trace.some(x=>x.method==='thread/resume'&&x.params.sandbox==='read-only'&&x.params.config?.apps?._default?.enabled===false&&x.params.config?.features?.multi_agent===false&&x.params.config?.features?.apply_patch_freeform===false));}
  else {const trace=fs.readFileSync(path.join(root,'context-inputs.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.provider===provider).at(-1);assert.ok(trace.args.includes('--settings'));assert.match(trace.args.join(' '),/write_file\(\*\)/);}
  await close(id);
 }
 console.log('PASS native Codex sandbox and Antigravity CLI permissions enforce reviewer roles');
 const repository=path.join(root,'isolated-repo');fs.mkdirSync(repository);const git=(...args)=>execFileSync('git',args,{cwd:repository,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});git('init');git('config','core.autocrlf','false');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(repository,'source.txt'),'ORIGINAL\n');git('add','.');git('commit','-m','base');
 const writer='writer-parent';at=events.length;await send(writer,'claude','TEAM '+JSON.stringify({name:'run_agent',args:{agent:'codex',role:'executor',workspace:'isolated',task:'TEAM_HOLD',background:true}}),{cwd:repository});
 const writerEvent=await wait(e=>events.indexOf(e)>=at&&e.payload?.threadId===writer&&e.payload.ev?.type==='agent'&&e.payload.ev.runId);const writerId=writerEvent.payload.ev.runId;
 let workspace;for(let n=0;n<150;n++){const task=(await api('inspect')).tasks.find(t=>t.id===writerId);if(task?.cwd&&task.cwd!==repository){workspace=task.cwd;break;}await new Promise(r=>setTimeout(r,20));}assert.ok(workspace);assert.ok(path.resolve(workspace).toLowerCase().startsWith((path.resolve(root,'home','.claude-desk','worktrees')+path.sep).toLowerCase()),workspace);assert.equal(fs.readFileSync(path.join(workspace,'source.txt'),'utf8'),'ORIGINAL\n');fs.writeFileSync(path.join(workspace,'source.txt'),'CHILD CHANGE\n');assert.equal(fs.readFileSync(path.join(repository,'source.txt'),'utf8'),'ORIGINAL\n');
 await wait(e=>e.payload?.threadId===writer&&e.payload.ev?.type==='agent'&&e.payload.ev.runId===writerId&&e.payload.ev.status==='done');await close(writer);
 console.log('PASS parallel executors receive an isolated managed worktree and leave the parent checkout untouched');

 await api('pause');await send('restart-queued','codex','RECOVERY_EXACT_TEXT');assert.equal((await api('inspect')).queued,1);
 // Simulate a crash: shutdown deliberately cancels queued work, so terminate only this fixture process.
 child.kill();await new Promise(r=>child.once('exit',r));pending=[];events=[];listeners=[];start();
 const recovered=await api('inspect');assert.equal(recovered.recovery.length,1);assert.equal(recovered.active,0);const row=recovered.recovery[0];assert.equal(row.preview,'RECOVERY_EXACT_TEXT');
 const draft=await api('recovery',{ticket:row.ticket,threadId:'restored-draft'});assert.equal(draft.messages[0].text,'RECOVERY_EXACT_TEXT');assert.equal((await api('inspect')).active,0,'Restoring a draft cannot run a model automatically');
 at=events.length;await send('restored-draft','codex',draft.messages[0].text,{_recoveryTicket:row.ticket});await event('restored-draft','turn.end',at);assert.equal((await api('inspect')).recovery.length,0);await close('restored-draft');
 console.log('PASS unsent input survives a crash, is recovered explicitly and retires only after transport acknowledgement');
 at=events.length;await send('reopened-old-session','claude','approve',{resume:readonlySid,permissionMode:'bypassPermissions'});const reopened=await event('reopened-old-session','turn.end',at);assert.match(reopened.payload.ev.text,/deny/);assert.equal((await api('inspect')).tasks.find(t=>t.id==='reopened-old-session').role,'researcher');await close('reopened-old-session');console.log('PASS roles follow provider switches and reopening an older session after restart');
 child.stdin.end();await new Promise(r=>child.once('exit',r));assert.equal(child.exitCode,0,stderr);
}finally{if(child.exitCode===null)child.kill();console.log('Workbench fixtures:',root);}

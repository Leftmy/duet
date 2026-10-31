import assert from 'node:assert/strict';
import test from 'node:test';
import { createCore } from '../electron/core/runs.mjs';

function fixture() {
  const runs=[],events=[];
  const provider={id:'claude',label:'Claude',caps:{modes:['default']},open(spec,sink){
    const run={spec,sink,closed:false,send(){},configure(){},close(){this.closed=true;sink.closed();}};
    runs.push(run);return run;
  }};
  const core=createCore({registry:{get:()=>provider,all:()=>[provider]},emit:(...args)=>events.push(args)});
  const start=(id='chat')=>{
    core.send({threadId:id,provider:'claude',text:'task',cwd:'/test'});
    const run=runs.at(-1);run.sink.event({type:'session',sessionId:'saved-'+id});return run;
  };
  const trim=()=>core.trimIdleRuns({maxIdleMs:1000,now:Date.now()+60000});
  return {core,runs,events,start,trim};
}
test('idle trim preserves active turns and resumes closed SDKs from saved history',()=>{
  const {core,start,trim,runs,events}=fixture();const first=start();
  assert.deepEqual(trim(),[]);assert.equal(first.closed,false);
  first.sink.event({type:'turn.end'});
  assert.deepEqual(trim(),['chat']);assert.equal(first.closed,true);
  assert.equal(events.filter(([name])=>name==='agent:closed').length,0,'idle release is not a stopped chat');
  core.send({threadId:'chat',provider:'claude',text:'continue',cwd:'/test'});
  assert.equal(runs.at(-1).spec.resume,'saved-chat');
  assert.equal(core.isRunning('chat'),true);
  core.closeAll();
});
test('native background agents and tasks prevent eviction until they finish',()=>{
  const {core,start,trim}=fixture();const run=start();
  run.sink.event({type:'agent',id:'helper',name:'Helper'});
  run.sink.event({type:'task',op:'start',id:'job',background:true});
  run.sink.event({type:'turn.end'});assert.deepEqual(trim(),[]);
  run.sink.event({type:'agent',id:'helper',status:'done'});assert.deepEqual(trim(),[]);
  run.sink.event({type:'task',op:'end',id:'job',status:'completed'});
  assert.deepEqual(trim(),['chat']);core.closeAll();
});
test('pending approvals and delegated runs prevent idle eviction',async()=>{
  const {core,start,trim,events,runs}=fixture();const parent=start();
  const approval=parent.sink.approval({toolName:'Bash',input:{command:'test'}});
  parent.sink.event({type:'turn.end'});assert.deepEqual(trim(),[]);
  const request=events.find(([name])=>name==='agent:permission')[1];
  core.respondPermission({threadId:'chat',reqId:request.reqId,decision:'deny'});await approval;
  const {runId}=core.spawnAgent({parentId:'chat',toolUseId:'helper',provider:'claude',prompt:'work'});
  const helper=runs.at(-1);helper.sink.event({type:'session',sessionId:'helper-session'});
  assert.deepEqual(trim(),[]);
  helper.sink.event({type:'turn.end',text:'done'});
  assert.deepEqual(new Set(trim()),new Set(['chat',runId]));core.closeAll();
});
test('idle cleanup can be disabled and does not evict a recently completed run',()=>{
  const {core,start}=fixture();const run=start();run.sink.event({type:'turn.end'});
  assert.deepEqual(core.trimIdleRuns({maxIdleMs:0}),[]);
  assert.deepEqual(core.trimIdleRuns({maxIdleMs:60000}),[]);assert.equal(run.closed,false);core.closeAll();
});

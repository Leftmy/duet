import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const calls=[];
  const window={__TAURI_INTERNALS__:{invoke:async(command,payload)=>{calls.push({command,payload});return true;}}};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/preload.js',import.meta.url),'utf8').replace('__DUET_PLATFORM__',JSON.stringify('win32')),{window,EventTarget});
  return {window,desk:window.desk,calls};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('native bridge invokes the host directly with the complete pager and file contracts',async()=>{
  const {desk,calls}=fixture();
  assert.equal(desk.platform,'win32');assert.equal(desk.nativeHistoryPaging,true);
  await desk.send({threadId:'chat',text:'note'});
  await desk.loadSessionPage('session','/project',null,'codex',{before:10,limit:40});
  await desk.loadSubagentPage('session','/project','claude','child',{limit:40});
  await desk.browserControl({action:'sleep-tab',tabId:'tab'},'chat');
  assert.deepEqual(plain(calls.map(c=>c.payload.channel)),['agent:send','agent:loadSessionPage','agent:loadSubagentPage','browser:control']);
  assert.ok(calls.every(c=>c.command==='duet_invoke'));
  assert.deepEqual(plain(calls[1].payload.args),['session','/project',null,'codex',{before:10,limit:40}]);
  assert.equal(desk.getPathForFile({__duetPath:'/project/file.md'}),'/project/file.md');
  assert.equal(desk.getPathForFile({}),'');
  await assert.rejects(desk.call('browser:control'),/Channel not allowed/);
  await desk.call('desk:native-core');
  assert.equal(calls.at(-1).payload.channel,'desk:native-core');
});

test('single/batched event subscriptions preserve ordering and unsubscribe completely',()=>{
  const {window,desk}=fixture();const batches=[],singles=[];
  const offBatch=desk.onEvents(batch=>batches.push(plain(batch)));
  const offSingle=desk.onEvent(payload=>singles.push(plain(payload)));
  const a={threadId:'chat',ev:{type:'text',text:'a'}},b={threadId:'chat',ev:{type:'turn.end'}};
  window.__duetDeliver('agent:event',a);window.__duetDeliver('agent:events',[a,b]);
  assert.deepEqual(batches,[[a],[a,b]]);assert.deepEqual(singles,[a,a,b]);
  offBatch();offSingle();window.__duetDeliver('agent:events',[b]);
  assert.equal(batches.length,2);assert.equal(singles.length,3);
  let count=0;const off=desk.subscribe('desk:example',()=>count++);
  window.__duetDeliver('desk:example',{});off();window.__duetDeliver('desk:example',{});assert.equal(count,1);
});

test('notifications use the native host without a JavaScript background runtime',async()=>{
  const {window,calls}=fixture();assert.equal(await window.Notification.requestPermission(),'granted');
  new window.Notification('Fixture',{body:'Body'});
  assert.deepEqual(plain(calls[0]),{command:'duet_invoke',payload:{channel:'desk:notification',args:[{title:'Fixture',body:'Body'}]}});
});

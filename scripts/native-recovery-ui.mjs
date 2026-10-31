import assert from 'node:assert/strict';

/** Synthetic running chat in the isolated native inspection profile. */
export async function testRecoveryUI(evaluate) {
  const wait=async(expression)=>{for(let n=0;n<150;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,40));}throw Error('Native recovery timeout: '+expression);};
  await evaluate(`(()=>{const s=window.__deskStore;window.__recoveryBefore=s.getState();window.__recoveryStops=0;window.__recoveryClose=window.desk.closeThread;window.__recoveryInterrupt=window.desk.interrupt;window.desk.closeThread=async()=>{window.__recoveryStops++;};window.desk.interrupt=async()=>{window.__recoveryStops++;};const id=s.getState().newThread();window.__recoveryChat=id;const t=s.getState().threads[id];s.setState({settings:{...s.getState().settings,changesOpen:false},threads:{...s.getState().threads,[id]:{...t,status:'running',entries:[{kind:'turn',id:'broken-view',done:false,items:null}],agents:{child:{id:'child',name:'Recovery fixture',status:'running',startedAt:Date.now(),items:[],toolUses:0}}}}});return true})()`);
  await wait(`Boolean(document.querySelector('[data-ui-recover]'))`);
  await evaluate(`document.querySelector('[data-ui-recover]').click()`);
  await wait(`!document.querySelector('.ui-failure')`);
  assert.equal(await evaluate(`window.__deskStore.getState().threads[window.__recoveryChat].status`),'running');
  await evaluate(`window.__duetDeliver('agent:events',[{threadId:window.__recoveryChat,ev:{type:'text',agent:'child',id:'after-recovery',text:'STILL_DELIVERING',mode:'delta'}}])`);
  await wait(`window.__deskStore.getState().threads[window.__recoveryChat].agents.child.items.at(-1)?.text==='STILL_DELIVERING'`);
  assert.equal(await evaluate(`window.__recoveryStops`),0);
  await evaluate(`(()=>{window.desk.closeThread=window.__recoveryClose;window.desk.interrupt=window.__recoveryInterrupt;const b=window.__recoveryBefore;window.__deskStore.setState({threads:b.threads,activeId:b.activeId,settings:b.settings});return true})()`);
  console.log('PASS: native React error recovery keeps running chats and event subscriptions without interrupting a provider');
}

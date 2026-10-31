import assert from 'node:assert/strict';
// Isolated WebView test; transport writes are replaced before interacting with the form.
export async function testTeamUI(evaluate){
 const wait=async(test)=>{for(let n=0;n<150;n++){if(await evaluate(test))return;await new Promise(r=>setTimeout(r,40));}throw Error('Team UI did not reach expected state: '+test);};
 await evaluate(`(()=>{const s=window.__deskStore;window.__teamUIBefore=s.getState();window.__teamCall=window.desk.call;window.__teamStop=window.desk.stopTask;window.desk.call=async(name,...args)=>{if(name==='agent:send'&&args[0].delegate){window.__teamSent=args[0];return true;}return window.__teamCall(name,...args)};window.desk.stopTask=async(id,run)=>{window.__teamStopped={id,run};return true};const id=s.getState().newThread();window.__teamUIId=id;s.setState({activeId:id,split:null,panelTab:'agents',focusAgent:'team-ui-agent',settings:{...s.getState().settings,changesOpen:true,agentsCollapsed:false},threads:{...s.getState().threads,[id]:{...s.getState().threads[id],entries:[{kind:'user',id:'team-ui-prompt',text:'Team UI fixture',ts:Date.now()}],agents:{'team-ui-agent':{id:'team-ui-agent',runId:'sub-ui-run',name:'UI_TEAM_FIXTURE',prompt:'Fixture',status:'running',provider:'codex',items:[],startedAt:Date.now(),toolUses:0,color:0,background:true}}}}});return true})()`);
 await wait(`Boolean(document.querySelector('.agent-message-form input'))`);
 await evaluate(`(()=>{const input=document.querySelector('.agent-message-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'UI_TEAM_MESSAGE_OK');input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
 await new Promise(r=>setTimeout(r,40));await evaluate(`document.querySelector('.agent-message-form').requestSubmit()`);
 await wait(`window.__teamSent?.text==='UI_TEAM_MESSAGE_OK'`);
 const message=await evaluate(`window.__teamSent`);assert.equal(message.delegate,'sub-ui-run');assert.equal(message.threadId,await evaluate(`window.__teamUIId`));
 await evaluate(`document.querySelector('.agent-head .tone-danger').click()`);await wait(`Boolean(window.__teamStopped)`);assert.equal((await evaluate(`window.__teamStopped`)).run,'sub-ui-run');
 await evaluate(`(()=>{const s=window.__deskStore,b=window.__teamUIBefore;window.desk.call=window.__teamCall;window.desk.stopTask=window.__teamStop;s.setState({threads:b.threads,activeId:b.activeId,split:b.split,panelTab:b.panelTab,focusAgent:b.focusAgent,settings:b.settings});return true})()`);
 console.log('PASS: agent panel sends to the selected run and stops that branch');
}

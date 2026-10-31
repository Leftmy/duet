import assert from 'node:assert/strict';
export async function testSteeringUI(evaluate){
 const wait=async(test)=>{for(let n=0;n<150;n++){if(await evaluate(test))return;await new Promise(r=>setTimeout(r,40));}throw Error('Steering UI timeout: '+test);};
 await evaluate(`(()=>{const s=window.__deskStore;window.__steerBefore=s.getState();window.__steerSend=window.desk.send;window.desk.send=async payload=>{window.__steerPayload=payload;return true};const id=s.getState().newThread();window.__steerChat=id;s.setState({activeId:id,split:null,settings:{...s.getState().settings,followUp:'steer',changesOpen:false},threads:{...s.getState().threads,[id]:{...s.getState().threads[id],provider:'codex',status:'running',entries:[{kind:'user',id:'steer-user',text:'Work in progress',ts:Date.now()},{kind:'turn',id:'steer-turn',provider:'codex',done:false,startedAt:Date.now(),items:[{kind:'thinking',id:'still-thinking',text:'THINKING_STAYS_ACTIVE',startedAt:Date.now(),confirmed:false}]}]}}});return true})()`);
 await wait(`Boolean(document.querySelector('.composer-input'))`);
 await evaluate(`(()=>{const input=document.querySelector('.composer-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'FOLLOWUP_WHILE_THINKING');input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
 await new Promise(r=>setTimeout(r,50));await evaluate(`document.querySelector('.composer-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
 await wait(`Boolean(document.querySelector('.steer-row[data-delivery="sending"]'))`);
 assert.equal(await evaluate(`window.__deskStore.getState().threads[window.__steerChat].entries.at(-1).items[0].endedAt===undefined`),true);
 await wait(`window.__steerPayload?.text==='FOLLOWUP_WHILE_THINKING'`);const original=await evaluate(`window.__steerPayload.uuid`);
 await evaluate(`(()=>{const s=window.__deskStore,id=window.__steerChat,t=s.getState().threads[id];s.setState({threads:{...s.getState().threads,[id]:{...t,entries:t.entries.map(e=>e.kind==='turn'?{...e,items:e.items.map(i=>i.kind==='steer'?{...i,delivery:'failed',delivered:false,error:'UI_STEER_FAILURE'}:i)}:e)}}});return true})()`);
 await wait(`Boolean(document.querySelector('.steer-row [role="alert"]'))`);await evaluate(`document.querySelector('.steer-row button').click()`);
 await wait(`window.__steerPayload.uuid!==${JSON.stringify(original)}`);assert.equal(await evaluate(`document.querySelectorAll('.steer-row').length`),1);
 await evaluate(`(()=>{const s=window.__deskStore,id=window.__steerChat,t=s.getState().threads[id];s.setState({threads:{...s.getState().threads,[id]:{...t,status:'idle',entries:t.entries.map(e=>e.kind==='turn'?{...e,done:true,items:[...e.items.map(i=>i.kind==='steer'?{...i,delivery:'accepted',delivered:true}:i),{kind:'tool',id:'later-tool',name:'Read',input:{},status:'done',startedAt:1},{kind:'text',id:'final-answer',text:'FINAL_ANSWER_STAYS_VISIBLE',confirmed:true}]}:e)}}});return true})()`);
 await wait(`Boolean(document.querySelector('.worked'))&&document.body.textContent.includes('FINAL_ANSWER_STAYS_VISIBLE')`);
 assert.equal(await evaluate(`Boolean(document.querySelector('.steer-row[data-delivery="accepted"]'))`),true);
 await evaluate(`(()=>{const s=window.__deskStore,b=window.__steerBefore;window.desk.send=window.__steerSend;s.setState({threads:b.threads,activeId:b.activeId,split:b.split,settings:b.settings});return true})()`);
 console.log('PASS: main-chat follow-up is visible during thinking, retries in the same chat and stays visible after step collapse');
}

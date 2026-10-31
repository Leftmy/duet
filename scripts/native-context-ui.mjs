import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
export async function testContextUI(evaluate,profile,fixtureRoot,binary){
 const wait=async condition=>{for(let n=0;n<250;n++){if(await evaluate(condition))return;await new Promise(r=>setTimeout(r,20));}throw Error('Context UI timeout: '+condition+' '+JSON.stringify(await evaluate(`(()=>{const s=window.__deskStore.getState(),t=s.threads[window.__contextChat];return {active:s.activeId,id:window.__contextChat,status:t?.status,session:t?.sessionId,dom:document.body.textContent.slice(-1700),items:t?.entries.filter(e=>e.kind==='turn').map(e=>e.items.map(i=>({kind:i.kind,text:i.text?.slice(0,100)}))),toasts:s.toasts,entries:t?.entries.map(e=>({kind:e.kind,text:e.kind==='user'?e.text:undefined,error:e.kind==='turn'?e.error:undefined})),send:String(window.desk.send).slice(0,180)}})()`)));};
 await evaluate(`(()=>{const s=window.__deskStore;window.__contextBefore=s.getState();s.setState({activeId:'',split:null,settings:{...s.getState().settings,changesOpen:false}});const id=s.getState().newThread(${JSON.stringify(profile)});window.__contextChat=id;s.setState({threads:{...s.getState().threads,[id]:{...s.getState().threads[id],provider:'claude'}}});s.getState().send(id,'CTX_SEED_LOG',[]);return true})()`);
 await wait(`window.__deskStore.getState().threads[window.__contextChat]?.status==='idle'&&document.body.textContent.includes('KEEP_FACT')`);
 await evaluate(`document.querySelector('[data-context-manager-toggle]').click()`);
 await wait(`Boolean(document.querySelector('[data-context-manager] .context-block'))`);
 const tool=await evaluate(`(()=>{const row=[...document.querySelectorAll('[data-context-block]')].find(row=>row.querySelector('strong').textContent.includes('tool'));row.querySelector('input').click();return row.dataset.contextBlock})()`);assert.ok(tool);
 await evaluate(`(()=>{const panel=document.querySelector('[data-context-manager]');[...panel.querySelectorAll('button')].find(b=>b.textContent==='Archive').click();return true})()`);
 await wait(`document.querySelector('.context-jobs')?.textContent.includes('Ready')`);
 const previous=await evaluate(`window.__deskStore.getState().threads[window.__contextChat].sessionId`);
 await evaluate(`window.__deskStore.getState().send(window.__contextChat,'CTX_UI_CONTINUE',[])`);
 await wait(`window.__deskStore.getState().threads[window.__contextChat].status==='idle'&&window.__deskStore.getState().threads[window.__contextChat].sessionId!==${JSON.stringify(previous)}`);
 const rotated=await evaluate(`window.__deskStore.getState().threads[window.__contextChat].sessionId`);
 assert.equal(await evaluate(`window.__deskStore.getState().settings.links[${JSON.stringify(rotated)}]===${JSON.stringify(previous)}`),true,'Internal rotation retains one linked application chat');
 if(!await evaluate(`Boolean(document.querySelector('[data-context-manager]'))`))await evaluate(`document.querySelector('[data-context-manager-toggle]').click()`);
 await wait(`document.querySelector('.context-jobs')?.textContent.includes('Applied')`);
 assert.equal(await evaluate(`Boolean(document.querySelector('[data-context-block="${tool}"]'))`),false,'Archived block disappears from active projection');
 await evaluate(`(()=>{const select=document.querySelector('[data-context-manager] select');select.value='archived';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
 await wait(`Boolean(document.querySelector('[data-context-block="${tool}"]'))`);
 await evaluate(`(()=>{const panel=document.querySelector('[data-context-manager]');[...panel.querySelectorAll('button')].find(b=>b.textContent==='Undo').click();return true})()`);
 await wait(`document.querySelector('.context-jobs')?.textContent.includes('Ready')`);
 await evaluate(`window.__deskStore.getState().send(window.__contextChat,'CTX_UI_RESTORED',[])`);
 await wait(`window.__deskStore.getState().threads[window.__contextChat].status==='idle'`);
 await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
 // AGY fallback is the same native executable in CLI mode; it must never open another UI.
 await evaluate(`(()=>{const s=window.__deskStore;s.setState({activeId:''});const id=s.getState().newThread(${JSON.stringify(profile)});window.__contextAgy=id;s.setState({threads:{...s.getState().threads,[id]:{...s.getState().threads[id],provider:'antigravity'}}});s.getState().send(id,'CTX_SEED_LOG',[]);return true})()`);
 await wait(`window.__deskStore.getState().threads[window.__contextAgy]?.status==='idle'`);
 const view=await evaluate(`window.desk.call('desk:context',{action:'inspect',threadId:window.__contextAgy,provider:'antigravity'})`);
 const agyTool=view.blocks.find(b=>b.kind==='tool');assert.ok(agyTool);
 const trace=fs.readFileSync(path.join(fixtureRoot,'context-inputs.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(i=>i.provider==='antigravity').at(-1);
 const endpoint=/--context-client '(http[^']+)'/.exec(trace.text)?.[1];assert.ok(endpoint);
 const read=spawnSync(binary,['--context-client',endpoint,'read',JSON.stringify({id:agyTool.id})],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(read.status,0,read.stderr);assert.match(JSON.parse(read.stdout).result.text,/CONTEXT_OBSOLETE_CANARY/);
 const foreign=spawnSync(binary,['--context-client',endpoint,'read',JSON.stringify({id:tool})],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(foreign.status,1);assert.match(JSON.parse(foreign.stdout).error,/this chat/);
 await evaluate(`(()=>{const s=window.__deskStore,b=window.__contextBefore;window.desk.closeThread(window.__contextChat);window.desk.closeThread(window.__contextAgy);s.setState({threads:b.threads,activeId:b.activeId,split:b.split,settings:b.settings,panelTab:b.panelTab});return true})()`);
 console.log('PASS: native context panel archive/undo, stable chat aliases and actual Rust AGY command with cross-chat denial');
}

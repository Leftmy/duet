import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
export async function testWorkbenchUI(evaluate,profile){
 const wait=async code=>{for(let i=0;i<300;i++){if(await evaluate(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Workbench UI timeout '+code+' '+await evaluate(`document.querySelector('[data-workbench]')?.textContent`));};
 const a=path.join(profile,'attention-a'),b=path.join(profile,'attention-b');fs.mkdirSync(a);fs.mkdirSync(b);
 await evaluate(`(async()=>{window.__workbenchBefore=window.__deskStore.getState();window.__workbenchLimits=(await window.desk.call('desk:workbench',{action:'inspect'})).limits;const s=window.__deskStore;const a=s.getState().newThread(${JSON.stringify(a)});window.__workbenchA=a;await s.getState().send(a,'approve',[]);const b=s.getState().newThread(${JSON.stringify(b)});window.__workbenchB=b;await s.getState().send(b,'approve',[]);return true})()`);
 await wait(`window.__deskStore.getState().threads[window.__workbenchA].approvals.length===1&&window.__deskStore.getState().threads[window.__workbenchB].approvals.length===1`);
 await evaluate(`document.querySelector('[data-workbench-toggle]').click()`);await wait(`document.querySelectorAll('.workbench-inbox-item').length===2`);
 await evaluate(`document.querySelector('.workbench-detail .approval-actions .btn.primary').click()`);
 await wait(`document.querySelectorAll('.workbench-inbox-item').length===1`);
 await evaluate(`document.querySelector('.workbench-detail .approval-actions .btn.primary').click()`);
 await wait(`document.querySelectorAll('.workbench-inbox-item').length===0`);
 await evaluate(`(()=>{[...document.querySelectorAll('.workbench-tabs button')].find(b=>b.textContent==='Tasks').click();return true})()`);
 await wait(`document.querySelectorAll('.workbench-table tbody tr').length>=2`);
 await wait(`!document.querySelector('[data-task="'+window.__workbenchA+'"] select').disabled`);
 await evaluate(`(()=>{const e=document.querySelector('[data-task="'+window.__workbenchA+'"] select');e.value='researcher';e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
 await wait(`window.__deskStore.getState().threads[window.__workbenchA].role==='researcher'`);
 await evaluate(`(()=>{[...document.querySelectorAll('.workbench-actions button')].find(b=>b.textContent==='Pause new starts').click();return true})()`);
 await wait(`document.querySelector('.workbench-actions').textContent.includes('Resume queue')`);
 await evaluate(`window.__deskStore.getState().send(window.__workbenchB,'QUEUED_UI_CANCEL',[])`);
 await wait(`document.querySelector('[data-task="'+window.__workbenchB+'"] td:nth-child(2)').textContent.includes('Queued')`);
 await evaluate(`document.querySelector('[data-task="'+window.__workbenchB+'"] td:nth-child(2) button').click()`);
 await wait(`window.__deskStore.getState().threads[window.__workbenchB].status==='idle'`);
 await evaluate(`window.desk.call('desk:workbench',{action:'resume'})`);
 // Actual Git conflict preview from two independent native chats/worktrees.
 const repo=path.join(profile,'conflict-repo'),left=path.join(profile,'conflict-left'),right=path.join(profile,'conflict-right');fs.mkdirSync(repo);
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git(repo,'init');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(repo,'conflict.txt'),'base\n');git(repo,'add','.');git(repo,'commit','-m','base');git(repo,'worktree','add','-b','left',left);git(repo,'worktree','add','-b','right',right);fs.writeFileSync(path.join(left,'conflict.txt'),'left\n');fs.writeFileSync(path.join(right,'conflict.txt'),'right\n');const before=git(left,'status','--porcelain=v1');
 await evaluate(`(async()=>{const s=window.__deskStore;const ids=[];for(const cwd of ${JSON.stringify([left,right])}){s.setState({activeId:''});const id=s.getState().newThread(cwd);ids.push(id);await s.getState().send(id,'INITIAL_CONFLICT_TASK',[]);}window.__workbenchConflictIds=ids;return true})()`);
 await wait(`window.__workbenchConflictIds.every(id=>window.__deskStore.getState().threads[id].status==='idle')`);
 await evaluate(`(()=>{[...document.querySelectorAll('.workbench-tabs button')].find(b=>b.textContent==='Conflicts').click();return true})()`);
 await wait(`[...document.querySelectorAll('[data-workbench] button')].some(b=>b.textContent==='Check workspaces')`);
 await evaluate(`[...document.querySelectorAll('[data-workbench] button')].find(b=>b.textContent==='Check workspaces').click()`);
 await wait(`document.querySelector('.workbench-conflict')?.textContent.includes('conflict.txt')`);assert.equal(git(left,'status','--porcelain=v1'),before);
 await evaluate(`(async()=>{const s=window.__deskStore,b=window.__workbenchBefore;for(const id of [window.__workbenchA,window.__workbenchB,...window.__workbenchConflictIds])await window.desk.closeThread(id);await window.desk.call('desk:workbench',{action:'limits',limits:window.__workbenchLimits});document.querySelector('[data-workbench] button[aria-label="Close"]').click();s.setState({threads:b.threads,activeId:b.activeId,split:b.split,settings:b.settings,panelTab:b.panelTab});return true})()`);
 console.log('PASS: unified native approvals, role enforcement UI, queue cancel and real Git conflict preview without index changes');
}

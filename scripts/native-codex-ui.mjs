import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Called only against the isolated native-inspect window.
export async function testCodexUI(evaluate,profile){
  const left=path.join(profile,'left project'),right=path.join(profile,'right project');
  fs.mkdirSync(left,{recursive:true});fs.mkdirSync(right,{recursive:true});
  const file=path.join(left,'link target.md');fs.writeFileSync(file,Array.from({length:30},(_,i)=>`LINK_LINE_${i+1}`).join('\n'));
  fs.writeFileSync(path.join(left,'local image.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));
  const href=file.replaceAll('\\','/')+':12:3';
  const markdown=['# Heading',`[Absolute file](<${href}>)`,'[Relative file](<./link%20target.md#L5>)','[Section](#heading)','[Website](https://example.invalid/codex)','![Local result](<./local%20image.png>)'].join('\n\n');
  await evaluate(`(()=>{const s=window.__deskStore;window.__codexUIBefore=s.getState();const a=s.getState().newThread(${JSON.stringify(left)}),b=s.getState().newThread(${JSON.stringify(right)});window.__codexTestIds=[a,b];s.setState({threads:{...s.getState().threads,[a]:{...s.getState().threads[a],provider:'codex',entries:[{kind:'turn',id:'codex-links-turn',provider:'codex',items:[{kind:'text',id:'codex-links-text',text:${JSON.stringify(markdown)},confirmed:true}],startedAt:Date.now(),done:true}]},[b]:{...s.getState().threads[b],provider:'codex'}},split:[a,b],activeId:b});return true})()`);
  const wait=async(test,label)=>{for(let i=0;i<150;i++){if(await evaluate(test))return;await new Promise(r=>setTimeout(r,50));}throw Error(label);};
  await wait(`Boolean([...document.querySelectorAll('.md a')].find(a=>a.textContent==='Absolute file'))`,'Markdown did not render');
  await evaluate(`[...document.querySelectorAll('.md a')].find(a=>a.textContent==='Absolute file').click()`);
  await wait(`window.__deskStore.getState().editorLocation?.line===12`,'Absolute file link did not open line 12');
  const opened=await evaluate(`(()=>{const s=window.__deskStore.getState();return{path:s.editorActive,line:s.editorLocation.line,column:s.editorLocation.column,active:s.activeId,expected:window.__codexTestIds[1]}})()`);
  assert.equal(opened.path,file);assert.equal(opened.line,12);assert.equal(opened.column,3);assert.equal(opened.active,opened.expected);
  await wait(`Boolean(document.querySelector('.cm-activeLine')?.textContent.includes('LINK_LINE_12'))`,'Editor cursor did not move to the linked line');
  await evaluate(`[...document.querySelectorAll('.md a')].find(a=>a.textContent==='Relative file').click()`);
  await wait(`window.__deskStore.getState().editorLocation?.line===5`,'Relative file did not resolve from the source chat');assert.equal(await evaluate(`window.__deskStore.getState().editorActive`),file);
  await evaluate(`(()=>{window.__testExternal=window.desk.openExternal;window.desk.openExternal=async url=>{window.__lastExternal=url};[...document.querySelectorAll('.md a')].find(a=>a.textContent==='Website').click();return true})()`);
  await wait(`window.__lastExternal==='https://example.invalid/codex'`,'Web link did not reach native opener');await evaluate(`window.desk.openExternal=window.__testExternal`);
  await evaluate(`[...document.querySelectorAll('.md a')].find(a=>a.textContent==='Section').click()`);assert.equal(await evaluate(`Boolean(document.querySelector('[data-md-heading="heading"]'))`),true);
  await wait(`Boolean(document.querySelector('.md-img[src^="data:image/png;base64,"]'))`,'Local Markdown image was not loaded');
  console.log('PASS: Markdown clicks, split-chat cwd, editor line/column, website routing, anchors and local images');
  await evaluate(`(()=>{const s=window.__deskStore;window.__originalRespond=window.desk.respondPermission;window.desk.respondPermission=async p=>{window.__codexResponse=p;return true};const id=window.__codexTestIds[1];s.setState({split:null,activeId:id,threads:{...s.getState().threads,[id]:{...s.getState().threads[id],approvals:[{reqId:'codex-form-ui',toolName:'CodexMcpForm',canAlways:false,input:{mode:'form',serverName:'fixture-mcp',message:'NATIVE_FORM_FIXTURE',requestedSchema:{type:'object',required:['name','count'],properties:{name:{type:'string',title:'Fixture name'},count:{type:'integer',minimum:1,default:2}}}}}]}}});return true})()`);
  await wait(`Boolean(document.querySelector('form.approval'))`,'MCP form did not render');
  await evaluate(`(()=>{const input=document.querySelector('form.approval input[type="text"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Typed native answer');input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await new Promise(r=>setTimeout(r,60));await evaluate(`document.querySelector('form.approval').requestSubmit()`);
  await wait(`window.__codexResponse?.reqId==='codex-form-ui'`,'Typed MCP response did not reach broker');assert.deepEqual(await evaluate(`window.__codexResponse.updatedInput.content`),{name:'Typed native answer',count:2});
  console.log('PASS: typed MCP form validates in Rust and submits structured approval data');
  await evaluate(`(()=>{const s=window.__deskStore,id=window.__codexTestIds[1];window.__codexCall=window.desk.call;window.desk.call=async(name,...args)=>{if(name==='desk:codex'&&args[0].action==='mcp')return{data:[{name:'UI_MCP_FIXTURE',tools:{echo:{description:'Tool visible in the catalog'}},authStatus:'notLoggedIn'}],nextCursor:null};return window.__codexCall(name,...args)};s.setState({threads:{...s.getState().threads,[id]:{...s.getState().threads[id],approvals:[]}},codexPanel:{threadId:id,tab:'mcp',seq:1}});return true})()`);
  await wait(`document.querySelector('[data-codex-controls]')?.textContent.includes('UI_MCP_FIXTURE')`,'Native MCP catalog did not render');
  assert.equal(await evaluate(`document.querySelector('[data-codex-controls]')?.textContent.includes('1 tools')`),true);
  await evaluate(`(()=>{window.desk.call=window.__codexCall;document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`);
  await evaluate(`(()=>{const s=window.__deskStore,b=window.__codexUIBefore;window.desk.respondPermission=window.__originalRespond;s.setState({threads:b.threads,activeId:b.activeId,split:b.split,panelTab:b.panelTab,editorFiles:b.editorFiles,editorActive:b.editorActive,editorLocation:b.editorLocation,settings:b.settings,codexPanel:b.codexPanel});return true})()`);
  console.log('PASS: Codex slash panel opens and renders the native MCP tool catalog');
}

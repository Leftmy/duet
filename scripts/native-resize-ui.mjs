import assert from 'node:assert/strict';

export async function testResizeUI(evaluate,rpc,profile) {
  const wait=async condition=>{for(let i=0;i<200;i++){if(await evaluate(condition))return;await new Promise(r=>setTimeout(r,20));}throw Error('Resize UI timeout: '+condition);};
  const width=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width`);
  const drag=async(id,delta,cancel=false)=>{
    const point=await evaluate(`(()=>{const r=document.querySelector('[data-resize="${id}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+Math.min(70,r.height/2)}})()`);
    await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+delta,y:point.y,button:'left',buttons:1});
    await new Promise(r=>setTimeout(r,60));
    if(cancel)await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+delta,y:point.y,button:'left',clickCount:1});
    await wait(`!document.body.dataset.resizing`);
  };
  await evaluate(`(()=>{const s=window.__deskStore;window.__resizeBefore=s.getState();s.setState({split:null,settings:{...s.getState().settings,sidebarOpen:true,changesOpen:false,layoutSizes:{}}});return true})()`);
  await wait(`Boolean(document.querySelector('[data-resize="sidebar"]'))`);
  const before=await width('.sidebar');await drag('sidebar',85);
  const after=await width('.sidebar');assert.ok(after>before+65,{before,after});
  const persisted=await evaluate(`window.desk.getSettings()`);assert.ok(Math.abs(persisted.layoutSizes.sidebar-after)<2,'Drag persists via native settings');
  await drag('sidebar',70,true);assert.ok(Math.abs(await width('.sidebar')-after)<2,'Escape rolls back the drag');
  await evaluate(`window.__deskStore.getState().setSettings({sidebarOpen:false})`);await wait(`!document.querySelector('[data-resize="sidebar"]')`);
  await evaluate(`window.__deskStore.getState().setSettings({sidebarOpen:true})`);await wait(`document.querySelector('.sidebar').getBoundingClientRect().width>${after-2}`);
  await evaluate(`document.querySelector('[data-resize="sidebar"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await wait(`Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width-264)<2`);
  // Separate widths per right-hand tab, plus a real drag inside the file editor.
  await evaluate(`(()=>{const s=window.__deskStore;const id=s.getState().newThread(${JSON.stringify(profile)});window.__resizeChat=id;s.setState({activeId:id,panelTab:'files'});s.getState().setSettings({changesOpen:true});return true})()`);
  await wait(`Boolean(document.querySelector('[data-resize="filesTree"]'))`);
  const panel=await width('.changes');await drag('panel.files',95);assert.ok(await width('.changes')<panel-60,'Dragging the left edge shrinks the right panel');
  const tree=await width('.files-tree');await drag('filesTree',-45);assert.ok(await width('.files-tree')<tree-30,'File tree resizes independently');
  const filesWidth=await width('.changes');
  await evaluate(`(()=>{const h=document.querySelector('[data-resize="panel.files"]');h.focus();h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true})()`);
  assert.ok(await width('.changes')<filesWidth-12,'Keyboard arrows resize with the correct edge direction');
  await evaluate(`window.__deskStore.getState().setSettings({layoutSizes:{...window.__deskStore.getState().settings.layoutSizes,'panel.files':${filesWidth}}})`);
  await evaluate(`window.__deskStore.getState().setPanelTab('terminal')`);await wait(`Boolean(document.querySelector('[data-resize="panel.terminal"]'))`);
  await drag('panel.terminal',60);
  await evaluate(`window.__deskStore.getState().setPanelTab('files')`);await wait(`Boolean(document.querySelector('[data-resize="filesTree"]'))`);
  assert.ok(Math.abs(await width('.changes')-filesWidth)<2,'Panel tabs remember independent sizes');
  await evaluate(`(()=>{const s=window.__deskStore;s.getState().setPanelTab('browser');window.__resizeVisibility=[];window.__resizeVisible=window.desk.browserSetVisible;window.desk.browserSetVisible=(...a)=>{window.__resizeVisibility.push(a[0]);return window.__resizeVisible(...a)};return true})()`);
  await wait(`Boolean(document.querySelector('[data-resize="panel.browser"]'))`);
  await new Promise(r=>setTimeout(r,150));
  await drag('panel.browser',65);
  await wait(`window.__resizeVisibility.includes(false)&&window.__resizeVisibility.at(-1)===true`);
  assert.equal(await evaluate(`(async()=>(await window.desk.browserScreenshot(window.__resizeChat)).startsWith('iVBOR'))()`),true,'Native browser is usable after resizing across its surface');
  await evaluate(`window.desk.browserSetVisible=window.__resizeVisible;window.__deskStore.getState().setPanelTab('files')`);
  await wait(`Boolean(document.querySelector('[data-resize="filesTree"]'))`);
  // A mounted pane clamps when the viewport narrows, while retaining its preference.
  await rpc('Emulation.setDeviceMetricsOverride',{width:820,height:720,deviceScaleFactor:1,mobile:false});
  await wait(`document.querySelector('.main').getBoundingClientRect().width<650`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.thread-main').getBoundingClientRect().width>200`),true,'Narrow viewport keeps chat usable without horizontal overflow');
  await rpc('Emulation.clearDeviceMetricsOverride');
  await evaluate(`(()=>{const s=window.__deskStore;const a=window.__resizeChat;const b='resize-peer';s.setState({threads:{...s.getState().threads,[b]:{...s.getState().threads[a],id:b}},split:[a,b],activeId:a,settings:{...s.getState().settings,changesOpen:false}});return true})()`);
  await wait(`Boolean(document.querySelector('[data-resize="split"]'))`);
  const split=await width('.split-pane');await drag('split',80);assert.ok(await width('.split-pane')>split+55,'Split chats have an adjustable divider');
  await evaluate(`(()=>{const s=window.__deskStore,b=window.__resizeBefore;window.desk.closeThread(window.__resizeChat);s.setState({threads:b.threads,activeId:b.activeId,split:b.split,panelTab:b.panelTab});s.getState().setSettings({sidebarOpen:b.settings.sidebarOpen,changesOpen:b.settings.changesOpen,layoutSizes:b.settings.layoutSizes??{}});return true})()`);
  console.log('PASS: real pointer resizing, native persistence/reopen, Escape/reset, independent panel/tree/split sizes and narrow-window limits');
}

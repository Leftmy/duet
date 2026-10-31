import assert from 'node:assert/strict';

// Uses only the isolated inspection profile and its local HTTP fixture.
export async function testBrowserUI(evaluate, browserURL, profile, captureSleep) {
  const wait = async (condition, label) => {
    for (let n = 0; n < 150; n++) { const result = await condition(); if (result) return result; await new Promise(r => setTimeout(r, 50)); }
    throw Error('Browser UI timeout: ' + label+' '+JSON.stringify(await evaluate(`({activeId:window.__deskStore.getState().activeId,dom:document.querySelector('.browser')?.textContent,states:document.querySelectorAll('.browser-tabs [role=tab]').length,uiError:document.querySelector('.browser-notice')?.textContent})`))+' '+JSON.stringify(await state()));
  };
  const key = await evaluate(`(()=>{window.__browserBefore=window.__deskStore.getState();const s=window.__deskStore;const id=s.getState().newThread(${JSON.stringify(profile)});s.setState({panelTab:'browser'});s.getState().setSettings({changesOpen:true});return id})()`);
  const call = (action, extra = {}) => evaluate(`window.desk.browserControl(${JSON.stringify({action,...extra})},${JSON.stringify(key)})`);
  const state = () => evaluate(`window.desk.browserState(${JSON.stringify(key)})`);
  await wait(() => evaluate(`document.querySelectorAll('.browser-tabs [role=tab]').length===1`), 'initial tab strip');
  await evaluate(`window.desk.browserNavigate(${JSON.stringify(browserURL)},${JSON.stringify(key)})`);
  await wait(async () => (await state()).title === 'Duet native browser test', 'first page');
  const first = (await state()).activeTabId;
  await evaluate(`document.querySelector('.browser-tabbar > button').click()`);
  await wait(async () => (await state()).tabs.length === 2, 'new tab button');
  const second = (await state()).activeTabId;
  await evaluate(`window.desk.browserNavigate(${JSON.stringify(browserURL+'?tab=second')},${JSON.stringify(key)})`);
  await wait(async () => (await state()).title === 'Duet tab second', 'second page');
  await call('select-tab', {tabId:first});
  assert.equal((await state()).url,browserURL);
  assert.equal((await state()).tabs.find(t=>t.id===second).url,browserURL+'?tab=second');

  const targetedRead=await call('test-tool',{tool:{action:'read_page',tab_id:second}});
  assert.equal(targetedRead.title,'Duet tab second');assert.equal((await state()).activeTabId,first);
  const pageEval = async (url, code) => {
    const snapshot=await state();const tab=snapshot.tabs.find(t=>t.url===url);assert.ok(tab,'Native tab exists: '+url);
    return call('test-tool',{tool:{action:'run_js',tab_id:tab.id,code}});
  };
  await pageEval(browserURL,`document.cookie='duet_browser_fixture=kept; path=/';window.scrollTo(0,300);true`);
  await call('test-tool',{tool:{action:'click',tab_id:first,selector:'#popup'}});
  await wait(async () => (await state()).tabs.length === 3, 'target blank creates third tab');
  await wait(async () => (await state()).title === 'Duet tab popup', 'popup navigation');
  assert.equal((await state()).tabs.find(t=>t.id===first).url,browserURL);
  await call('close-tab');
  await call('select-tab',{tabId:first});
  await pageEval(browserURL,`const input=document.querySelector('#draft');input.value='UNSAVED';input.dispatchEvent(new Event('input',{bubbles:true}));true`);
  const protectedResult=await evaluate(`window.desk.browserControl({action:'sleep-tab',tabId:${JSON.stringify(first)}},${JSON.stringify(key)}).then(()=> 'UNEXPECTED',e=>String(e))`);
  assert.match(protectedResult,/Protected tab: input/);
  await evaluate(`document.querySelector('.browser-bar button[aria-label="Sleep tab"],.browser-bar button[aria-label="Усыпить вкладку"]').click()`);
  await wait(()=>evaluate(`Boolean(document.querySelector('.modal.confirm')) || Boolean(document.querySelector('[role=dialog]'))`),'protected form confirmation');
  // Cancel through the dialog store's rendered cancel control, without discarding the input.
  const cancelled=await evaluate(`(()=>{const dialog=document.querySelector('.modal.confirm');const buttons=[...(dialog?.querySelectorAll('button')||[])];const cancel=buttons.find(b=>/cancel|отмен/i.test(b.textContent));if(!cancel)return false;cancel.click();return true})()`);
  assert.equal(cancelled,true,'Protected tab confirmation is cancellable');
  assert.equal((await state()).sleeping,false);
  await pageEval(browserURL,`document.querySelector('#draft').value='';window.__duetBrowserGuard.dirty=false;document.body.insertAdjacentHTML('beforeend','<select><option>Default</option><option>Other</option></select>');window.scrollTo(0,300);true`);
  await evaluate(`document.querySelector('.browser-bar button[aria-label="Sleep tab"],.browser-bar button[aria-label="Усыпить вкладку"]').click()`);
  await wait(()=>evaluate(`Boolean(document.querySelector('.browser-sleep-card'))`),'sleep placeholder');
  assert.equal((await state()).sleeping,true);
  if(captureSleep)await captureSleep();
  const beforeWake=(await state()).tabs.find(t=>t.id===first);assert.equal(beforeWake.sleepReason,'manual');
  await evaluate(`document.querySelector('.browser-sleep-card button').click()`);
  await wait(async()=>(await state()).title==='Duet native browser test'&&!(await state()).loading,'wake reload');
  const restored=await wait(async()=>{const value=await pageEval(browserURL,`({scroll:scrollY,cookie:document.cookie,draft:document.querySelector('#draft').value})`);return value.scroll>=290&&value;},'scroll restoration');
  assert.match(restored.cookie,/duet_browser_fixture=kept/);assert.equal(restored.draft,'');
  await call('pin-tab',{tabId:first,pinned:true});
  await call('select-tab',{tabId:second});
  const pinned=await call('sleep-inactive');assert.equal(pinned.tabs.find(t=>t.id===first).sleeping,false);
  await call('pin-tab',{tabId:first,pinned:false});
  const sleeping=await call('sleep-inactive');assert.equal(sleeping.tabs.find(t=>t.id===first).sleeping,true);
  await call('close-tab',{tabId:second});
  assert.equal((await state()).activeTabId,first);assert.equal((await state()).sleeping,false,'Closing selected tab wakes its sleeping neighbor');
  await evaluate(`(async()=>{await window.desk.closeThread(${JSON.stringify(key)});const before=window.__browserBefore;window.__deskStore.setState({threads:before.threads,activeId:before.activeId,panelTab:before.panelTab});window.__deskStore.getState().setSettings({changesOpen:false});delete window.__browserBefore;return true})()`);
  console.log('PASS: native browser tabs, target blank, protected input/cancel, actual WebView disposal, cookie/scroll wake, pinning and sleeping neighbor');
}

import assert from 'node:assert/strict';
// Operates only on the native-inspect fixture window and its disposable provider homes.
export async function testKimiUI(evaluate,profile){
 const wait=async(expression,label)=>{for(let n=0;n<160;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw Error(label);};
 await evaluate(`(()=>{window.__kimiUIBefore=window.__deskStore.getState();const s=window.__deskStore,id=s.getState().newThread(${JSON.stringify(profile)});window.__kimiUITest=id;s.getState().switchProvider(id,'kimi');s.setState({split:null,activeId:id});s.getState().send(id,'KIMI_NATIVE_UI_FIXTURE',[]);return true})()`);
 await wait(`(()=>{const t=window.__deskStore.getState().threads[window.__kimiUITest];return t?.status==='idle'&&t.entries.some(e=>e.kind==='turn'&&e.items.some(i=>i.kind==='text'&&i.text.includes('KIMI_NATIVE_UI_FIXTURE')));})()`,'Kimi chat did not stream to native UI');
 await evaluate(`document.querySelector('button[aria-label="Kimi Code"]').click()`);
 await wait(`Boolean(document.querySelector('[data-kimi-controls]'))`,'Kimi controls did not open');
 await evaluate(`document.querySelector('[data-kimi-tab="skills"]').click()`);
 await wait(`document.querySelector('[data-kimi-controls]')?.textContent.includes('fixture-skill')`,'Kimi skills did not load through Rust');
 await evaluate(`document.querySelector('[data-kimi-tab="mcp"]').click()`);
 await wait(`document.querySelector('[data-kimi-controls]')?.textContent.includes('fixture-mcp')`,'Kimi MCP catalog did not load');
 await evaluate(`document.querySelector('[data-kimi-tab="account"]').click()`);
 await wait(`Boolean(document.querySelector('[data-kimi-login="logout"]'))`,'Kimi account did not report fixture OAuth');
 await evaluate(`document.querySelector('[data-kimi-login="logout"]').click()`);
 await wait(`Boolean(document.querySelector('[data-kimi-login="start"]:not(:disabled)'))`,'Kimi fixture sign-out UI did not update');
 await evaluate(`document.querySelector('[data-kimi-login="start"]').click()`);
 await wait(`document.querySelector('[data-kimi-account]')?.textContent.includes('FIXTURE')`,'Kimi device code did not appear');
 await wait(`Boolean(document.querySelector('[data-kimi-login="logout"]'))`,'Kimi device login polling did not update account');
 assert.equal(await evaluate(`document.querySelectorAll('[data-kimi-controls] [role="alert"]').length`),0);
 await evaluate(`(async()=>{await window.desk.closeThread(window.__kimiUITest);const s=window.__deskStore;s.setState(window.__kimiUIBefore);return true;})()`);
 console.log('PASS: Kimi native streaming UI, tools/skills/MCP controls and subscription device-login lifecycle');
}

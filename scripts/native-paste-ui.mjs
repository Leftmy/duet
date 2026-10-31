import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Runs only inside the inspector's separate profile/window.
export async function testPasteUI(evaluate, profile) {
  const wait = async condition => {
    for (let n = 0; n < 150; n++) { if (await evaluate(condition)) return; await new Promise(r => setTimeout(r, 30)); }
    throw new Error('Native paste UI timeout: ' + condition);
  };
  const source = 'NATIVE_LARGE_PASTE_SOURCE\r\nПривет 🦀\rline\n'.repeat(100);
  await evaluate(`(()=>{const s=window.__deskStore;window.__pasteBefore=s.getState();window.__pasteSend=window.desk.send;window.desk.send=async payload=>{window.__pastePayload=payload;return true};s.setState({activeId:'',split:null,settings:{...s.getState().settings,changesOpen:false}});const id=s.getState().newThread(${JSON.stringify(profile)});window.__pasteChat=id;s.setState({threads:{...s.getState().threads,[id]:{...s.getState().threads[id],provider:'claude',draft:'Please inspect this log'}}});return true})()`);
  await wait(`document.querySelector('.composer-input')?.value==='Please inspect this log'`);
  assert.equal(await evaluate(`(()=>{const ta=document.querySelector('.composer-input'),data=new DataTransfer();data.setData('text/plain','short text');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});ta.dispatchEvent(event);return event.defaultPrevented})()`), false, 'Small paste keeps the browser default');
  assert.equal(await evaluate(`(()=>{const ta=document.querySelector('.composer-input'),data=new DataTransfer();data.setData('text/plain',${JSON.stringify(source)});const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});ta.dispatchEvent(event);return event.defaultPrevented})()`), true);
  await wait(`Boolean(window.__deskStore.getState().threads[window.__pasteChat]?.draftTextFiles?.[0]?.path)&&Boolean(document.querySelector('.composer [data-pasted-file]'))`);
  const file = await evaluate(`window.__deskStore.getState().threads[window.__pasteChat].draftTextFiles[0]`);
  assert.ok(path.resolve(file.path).startsWith(path.resolve(profile) + path.sep), 'Native paste stays in the isolated test profile');
  assert.equal(fs.readFileSync(file.path, 'utf8'), source, 'The Rust writer preserves Unicode and line endings');
  assert.equal(file.bytes, Buffer.byteLength(source));
  assert.equal(file.source, undefined);
  assert.equal(await evaluate(`document.querySelector('.composer-input').value`), 'Please inspect this log');
  await evaluate(`document.querySelector('.composer .pasted-text-open').click()`);
  await wait(`window.__deskStore.getState().editorActive===${JSON.stringify(file.path)}`);
  await evaluate(`window.__deskStore.getState().setSettings({changesOpen:false})`);
  await evaluate(`(()=>{const s=window.__deskStore;s.setState({activeId:''});window.__pasteOther=s.getState().newThread(${JSON.stringify(profile)});return true})()`);
  await wait(`!document.querySelector('.composer [data-pasted-file]')`);
  await evaluate(`window.__deskStore.getState().activate(window.__pasteChat)`);
  await wait(`Boolean(document.querySelector('.composer [data-pasted-file]'))&&document.querySelector('.composer-input')?.value==='Please inspect this log'`);
  await evaluate(`document.querySelector('.composer .send-btn').click()`);
  await wait(`Boolean(window.__pastePayload)&&Boolean(document.querySelector('.user-bubble [data-pasted-file]'))`);
  const payload = await evaluate(`window.__pastePayload`);
  assert.match(payload.text, /Please inspect this log/);
  assert.match(payload.text, /pasted-text-[\da-f-]+\.txt/);
  assert.equal(payload.text.includes('NATIVE_LARGE_PASTE_SOURCE'), false);
  assert.equal(await evaluate(`document.querySelector('.composer-input').value`), '');
  assert.equal(await evaluate(`document.querySelectorAll('.composer [data-pasted-file]').length`), 0);
  assert.equal(fs.readFileSync(file.path, 'utf8'), source, 'Sending keeps the referenced file available');
  await evaluate(`(()=>{const s=window.__deskStore,b=window.__pasteBefore;window.desk.send=window.__pasteSend;s.setState({threads:b.threads,activeId:b.activeId,split:b.split,settings:b.settings,panelTab:b.panelTab,editorFiles:b.editorFiles,editorActive:b.editorActive,editorLocation:b.editorLocation});return true})()`);
  console.log('PASS: real clipboard paste → Rust UTF-8 file → compact card, open, chat switch and reference-only send');
}

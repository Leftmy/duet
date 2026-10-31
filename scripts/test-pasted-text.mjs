// Synthetic pasted data only; no provider process or user profile is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';

const sent = [];
let save;
globalThis.document = { documentElement: {}, hidden: false };
globalThis.window = { addEventListener() {}, desk: new Proxy({
  getSettings: async () => ({ autoTitles: false, notifications: false }), setSettings: async () => {},
  onEvents: () => {}, probe: async () => ({ models: [], providers: Object.fromEntries(['claude', 'codex', 'antigravity'].map(id => [id, { available: true, models: [], caps: { steer: id !== 'antigravity' } }])) }),
  listSessions: async () => [], wtAll: async () => ({}), configure: async () => true,
  send: async payload => { sent.push(payload); return true; },
  call: async (channel, ...args) => channel === 'fs:pasteText' ? save(...args) : channel === 'win:list' ? [] : true,
}, { get: (target, key) => target[key] ?? (() => () => {}) }) };

const vite = await createServer({ server: { middlewareMode: true, ws: false }, appType: 'custom' });
try {
  const { useStore: store } = await vite.ssrLoadModule('/src/store.ts');
  const { shouldAttachPaste, withPastedText, splitPastedText } = await vite.ssrLoadModule('/src/lib/pasted-text.ts');
  assert.equal(shouldAttachPaste('x'.repeat(3999)), false);
  assert.equal(shouldAttachPaste('x'.repeat(4000)), true);
  assert.equal(shouldAttachPaste(Array(49).fill('line').join('\r\n')), false);
  assert.equal(shouldAttachPaste(Array(50).fill('line').join('\r')), true);
  assert.equal(shouldAttachPaste(''), false);
  const fixture = (text, dir = 'C:/Users/тест #?% (a)[b]/attachments') => {
    const name = `pasted-text-${randomUUID()}.txt`;
    return { name, path: `${dir}/${name}`, lines: text.split(/\r\n|\r|\n/).length, bytes: Buffer.byteLength(text) };
  };
  const example = { ...fixture('x'), id: 'any' };
  const ref = withPastedText('Check this\n', [example]);
  assert.equal(splitPastedText(ref).text, 'Check this');
  assert.equal(splitPastedText(ref).files[0].path, example.path);
  assert.equal(splitPastedText('Ordinary [link](https://example.com)').text, 'Ordinary [link](https://example.com)');
  assert.equal(splitPastedText(ref + '\nExtra note').files.length, 0, 'Only a complete generated attachment trailer is collapsed');

  await store.getState().init();
  const newChat = (provider = 'claude') => {
    store.setState({ activeId: '' });
    const id = store.getState().newThread('');
    store.setState(s => ({ threads: { ...s.threads, [id]: { ...s.threads[id], provider, loaded: true } } }));
    return id;
  };
  const thread = id => store.getState().threads[id];
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
    assert.fail('Pasted-text state transition timed out');
  };
  let resolveSave;
  save = () => new Promise(resolve => { resolveSave = resolve; });
  const id = newChat();
  const source = 'PRIVATE_LARGE_PASTE_NOT_IN_PROMPT\r\n'.repeat(180);
  const saving = store.getState().pasteText(id, source);
  assert.equal(thread(id).draftTextFiles[0].pending, true);
  store.getState().send(id, 'note', []);
  assert.equal(sent.length, 0, 'Sending waits for the file to be written');
  const other = newChat();
  resolveSave(fixture(source));
  await saving;
  assert.equal(store.getState().activeId, other);
  assert.equal(thread(other).draftTextFiles?.length ?? 0, 0);
  assert.equal(thread(id).draftTextFiles[0].source, undefined, 'Raw source is released after saving');
  assert.equal(thread(id).draftTextFiles[0].pending, undefined);

  save = async () => { throw new Error('Synthetic disk failure'); };
  await store.getState().pasteText(other, source);
  const failed = thread(other).draftTextFiles[0];
  assert.equal(failed.source, source, 'Write failures keep recoverable text');
  store.getState().send(other, 'blocked', []);
  assert.equal(sent.length, 0);
  save = async text => fixture(text);
  await store.getState().pasteText(other, failed.source, failed.id);
  assert.equal(thread(other).draftTextFiles.length, 1, 'Retry replaces the failed card');
  assert.equal(thread(other).draftTextFiles[0].error, undefined);

  save = () => new Promise(resolve => { resolveSave = resolve; });
  const removing = store.getState().pasteText(other, source);
  const pending = thread(other).draftTextFiles.at(-1);
  store.getState().removePastedText(other, pending.id);
  resolveSave(fixture(source));
  await removing;
  assert.equal(thread(other).draftTextFiles.length, 1, 'A late save cannot resurrect a removed attachment');

  save = async text => fixture(text, '/home/test user/attachments');
  for (const provider of ['claude', 'codex', 'antigravity']) {
    const chat = newChat(provider);
    await store.getState().pasteText(chat, source);
    await store.getState().pasteText(chat, 'SECOND_SOURCE_SENT_ONLY_BY_REFERENCE\n'.repeat(60));
    const count = sent.length;
    store.getState().send(chat, 'Inspect these logs', []);
    await wait(() => sent.length > count);
    const payload = sent.at(-1);
    assert.equal(payload.provider, provider);
    assert.equal(payload.text.includes(source), false);
    assert.equal(payload.text.includes('SECOND_SOURCE_SENT_ONLY_BY_REFERENCE'), false);
    assert.equal(splitPastedText(payload.text).files.length, 2);
    assert.equal(splitPastedText(payload.text).text, 'Inspect these logs');
    assert.equal(thread(chat).draftTextFiles.length, 0);
  }

  const queued = newChat('antigravity');
  store.setState(s => ({ threads: { ...s.threads, [queued]: { ...thread(queued), status: 'running' } } }));
  await store.getState().pasteText(queued, source);
  const beforeQueue = sent.length;
  store.getState().send(queued, '', []);
  assert.equal(sent.length, beforeQueue);
  assert.equal(splitPastedText(thread(queued).queue[0].text).files.length, 1, 'Attachment-only messages can be queued');
  assert.equal(thread(queued).queue[0].text.includes(source), false);

  const steering = newChat('codex');
  store.setState(s => ({ settings: { ...s.settings, followUp: 'steer' }, threads: { ...s.threads, [steering]: { ...thread(steering), status: 'running' } } }));
  await store.getState().pasteText(steering, source);
  const beforeSteer = sent.length;
  store.getState().send(steering, 'While thinking', []);
  await wait(() => sent.length > beforeSteer);
  assert.equal(sent.at(-1).priority, 'next');
  assert.equal(splitPastedText(sent.at(-1).text).files.length, 1);
  assert.equal(sent.at(-1).text.includes(source), false);
  console.log('PASS: paste thresholds, exact file references, concurrent drafts/removal, failure/retry, all providers, queue and steering');
} finally { await vite.close(); }
// Store initialization installs the same usage-refresh interval as the real UI.
process.exit(0);

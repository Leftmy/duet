// Synthetic agent traffic only: no application process, provider or user profile is touched.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';
import { createEventBatcher } from '../electron/core/event-batch.mjs';

let deliver, subscriptions = 0;
const calls = [];
globalThis.document = { documentElement: {}, hidden: false };
globalThis.window = { addEventListener() {}, desk: new Proxy({
  getSettings: async () => ({ autoTitles: false, notifications: false }),
  setSettings: async () => {},
  onEvents: (cb) => { subscriptions++; deliver = cb; },
  probe: async () => ({ models: [], providers: {} }), listSessions: async () => [], wtAll: async () => ({}),
  contextUsage: async () => null, usage: async () => null,
  call: async (name) => name === 'win:list' ? [] : true,
  send: async (payload) => { calls.push(payload); return true; },
}, { get: (target, key) => target[key] ?? (() => () => {}) }) };
const vite = await createServer({ server: { middlewareMode: true, ws: false }, appType: 'custom' });
try {
  const { useStore: store } = await vite.ssrLoadModule('/src/store.ts');
  const { applyEvent } = await vite.ssrLoadModule('/src/lib/reduce.ts');
  const { toolDiff, diffStats, buildDiff } = await vite.ssrLoadModule('/src/lib/tools.ts');
  const { collectChanges } = await vite.ssrLoadModule('/src/lib/changes.ts');
  await store.getState().init();
  const id = store.getState().activeId;
  const original = store.getState().threads[id];
  const edits = Array.from({ length: 60 }, (_, i) => ({ kind: 'tool', name: 'Edit', id: `edit${i}`, status: 'done', input: {
    file_path: `/src/file${i}.ts`, old_string: Array.from({ length: 160 }, (_, j) => `old ${i} ${j}`).join('\n'),
    new_string: Array.from({ length: 160 }, (_, j) => `new ${i} ${j}`).join('\n'),
  } }));
  const thread = { ...original, status: 'running', entries: [{ kind: 'turn', id: 'lead', items: edits, done: false, startedAt: 1000 }],
    agents: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`a${i}`, { id: `a${i}`, name: `Agent ${i}`, prompt: '', color: i, status: 'running', startedAt: 1000, items: [], toolUses: 0 }])) };
  store.setState({ threads: { [id]: thread } });
  const files = collectChanges(thread);
  assert.equal(files.length, 60);
  const afterAgent = applyEvent(thread, { type: 'text', agent: 'a0', id: 'answer', text: 'x', mode: 'delta' });
  assert.strictEqual(afterAgent.entries, thread.entries);
  assert.strictEqual(collectChanges(afterAgent), files);
  assert.strictEqual(toolDiff(edits[0]), toolDiff({ ...edits[0], result: 'new output' }));
  assert.notStrictEqual(toolDiff(edits[0]), toolDiff({ ...edits[0], input: { ...edits[0].input, new_string: 'changed' } }));
  const started = performance.now();
  for (let i = 0; i < 5; i++) for (const edit of edits) diffStats(toolDiff(edit));
  console.log(`Cached diffs, 5 token frames: ${(performance.now() - started).toFixed(2)} ms`);

  let commits = 0, batches = 0;
  const off = store.subscribe((s, prev) => { if (s.threads !== prev.threads) commits++; });
  const queue = createEventBatcher((batch) => { batches++; deliver(batch); });
  const eventStart = performance.now();
  for (let n = 0; n < 10000; n++) queue.push({ threadId: id, ev: { type: 'text', agent: `a${n % 200}`, id: 'answer', text: 'x', mode: 'delta', timestamp: 1000 + n } });
  queue.flush();
  off();
  const state = store.getState().threads[id];
  for (const a of Object.values(state.agents)) assert.equal(a.items[0].text, 'x'.repeat(50));
  assert.strictEqual(state.entries, thread.entries);
  assert.equal(commits, batches);
  assert.ok(commits < 100, 'thousands of agent tokens must not become thousands of store commits');
  console.log(`200 agents / 10000 events: ${commits} UI commits, ${Math.round(performance.now() - eventStart)} ms`);
  await store.getState().init();
  assert.equal(subscriptions, 1, 'view recovery must not duplicate subscriptions');
  assert.strictEqual(store.getState().threads[id], state, 'view recovery must preserve running chats');

  // Coalesce only adjacent fragments with identical ownership; never cross finals or results.
  const sent = [];
  const q = createEventBatcher((batch) => sent.push(...batch), { maxText: 10 });
  const payload = (ev) => ({ threadId: id, ev });
  q.push(payload({ type: 'text', id: 's', mode: 'delta', text: 'a' }));
  q.push(payload({ type: 'text', id: 's', mode: 'delta', text: 'b' }));
  q.push(payload({ type: 'text', id: 's', mode: 'final', text: 'ab' }));
  q.push(payload({ type: 'text', agent: 'other', id: 's', mode: 'delta', text: 'c' }));
  q.push(payload({ type: 'tool.delta', id: 'json', json: '{"a":' }));
  q.push(payload({ type: 'tool.delta', id: 'json', json: '1}' }));
  q.push(payload({ type: 'tool.output', id: 'log', chunk: 'one' }));
  q.push(payload({ type: 'tool.output', id: 'log', chunk: 'two' }));
  q.push(payload({ type: 'turn.end' }));
  assert.equal(sent[0].ev.text, 'ab');
  assert.equal(sent[1].ev.mode, 'final');
  assert.equal(sent[2].ev.agent, 'other');
  assert.equal(sent[3].ev.json, '{"a":1}');
  assert.equal(sent[4].ev.chunk, 'onetwo');
  assert.equal(sent.at(-1).ev.type, 'turn.end');
  q.flush();

  // Terminal events flush preceding tokens before queued follow-ups are dispatched.
  store.setState({ threads: { [id]: { ...state, queue: [{ id: 'queued', text: 'next', images: [] }] } } });
  deliver([{ threadId: id, ev: { type: 'text', id: 'lead-answer', text: 'done', mode: 'final' } },
    { threadId: id, ev: { type: 'turn.end', text: 'done' } }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.at(-1).text, 'next');
  assert.equal(store.getState().threads[id].entries.at(-3).items.at(-1).text, 'done');

  const before = Array.from({ length: 5000 }, (_, n) => `before-${n}`).join('\n');
  const after = Array.from({ length: 5000 }, (_, n) => `after-${n}`).join('\n');
  const boundedStart = performance.now();
  const bounded = buildDiff(before, after);
  assert.equal(diffStats(bounded).add, 5000);
  assert.equal(diffStats(bounded).del, 5000);
  assert.ok(bounded.some((line) => line.type === 'sep' && line.text.includes('full before/after')));
  assert.ok(performance.now() - boundedStart < 2000, 'pathological diff must have a bounded cost');
  const multi = toolDiff({ name: 'MultiEdit', input: { edits: [{ old_string: '', new_string: 'line\n'.repeat(150000) }] } });
  assert.equal(diffStats(multi).add, 150000, 'large MultiEdit must not overflow the JS argument stack');
  console.log('PASS: immutable history, cached diffs, batched ordering, queued follow-up, safe remount and bounded large diffs');
} finally { await vite.close(); }
process.exit(0);

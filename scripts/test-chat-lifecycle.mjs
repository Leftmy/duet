// No real providers or user settings: exercise UI state transitions and core run isolation.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createCore } from '../electron/core/runs.mjs';
import { historyEvents } from '../electron/providers/claude/translate.mjs';

const calls = [];
let event;
const sessions = [
  { sessionId: 'a', provider: 'claude', title: 'Same title', cwd: '/project', lastModified: 300 },
  { sessionId: 'b', provider: 'codex', title: 'Same title', cwd: '/project', lastModified: 200 },
  { sessionId: 'fork', provider: 'claude', title: 'Same title (fork)', cwd: '/project', lastModified: 400 },
];
const history = (provider, times) => times.flatMap((timestamp) => [
  { type: 'user', text: `${provider}-${timestamp}`, images: [], timestamp },
  { type: 'text', id: `${provider}-${timestamp}`, text: 'answer', mode: 'final', timestamp: timestamp + 1 },
]);
globalThis.document = { documentElement: {}, hidden: false };
globalThis.window = { addEventListener() {}, desk: new Proxy({
  getSettings: async () => ({ autoTitles: false, notifications: false }),
  setSettings: async (patch) => calls.push(['settings', patch]),
  onEvent: (cb) => { event = cb; },
  onEvents: (cb) => { event = (payload) => cb([payload]); },
  probe: async () => ({ models: [], providers: { claude: { available: true, models: [], caps: { rollback: 'anchor' } }, codex: { available: true, models: [], caps: { rollback: 'turns' } }, antigravity: { available: true, models: [], caps: { steer: false, images: false, fork: false, rollback: 'turns' }, usage: { plan: 'Antigravity', session: { pct: 6 }, weekly: { pct: 3 }, groups: [{ name: 'Gemini Models', session: { pct: 1 }, weekly: { pct: 1 } }, { name: 'Claude and GPT models', session: { pct: 6 }, weekly: { pct: 3 } }, { name: 'Gemini 4 Argon', weekly: { pct: 36 } }] } }, gemini: { available: true, models: [], caps: { steer: false, images: false, fork: false, rollback: 'turns' } } } }),
  listSessions: async () => sessions,
  wtAll: async () => ({}),
  segments: async () => [],
  loadSession: async (id) => id === 'b' ? history('codex', [200]) : history('claude', id === 'a' ? [100, 300] : [100]),
  loadSubagents: async (...args) => { calls.push(['subagents', ...args]); return []; },
  gitStatus: async () => ({ files: [] }),
  send: async (payload) => { calls.push(['send', payload]); return true; },
  rewindConversation: async (payload) => { calls.push(['rewindConversation', payload]); return true; },
  call: async (name, ...args) => { calls.push([name, ...args]); return name === 'win:list' ? [] : true; },
  fork: async () => 'fork',
}, { get: (target, key) => target[key] ?? (() => () => {}) }) };

const vite = await createServer({ server: { middlewareMode: true, ws: false }, appType: 'custom' });
try {
  const { useStore: store, modelsOf } = await vite.ssrLoadModule('/src/store.ts');
  const { chatRows } = await vite.ssrLoadModule('/src/lib/chat-sessions.ts');
  const { buildHandoff } = await vite.ssrLoadModule('/src/lib/handoff.ts');
  const { fromHistory } = await vite.ssrLoadModule('/src/lib/reduce.ts');
  const wait = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('State transition timed out');
  };
  assert.strictEqual(modelsOf({ models: [], providers: {} }, 'codex'), modelsOf({ models: [], providers: {} }, 'codex'));
  assert.equal(chatRows(sessions, {}, {}).length, 3, 'same-title chats and forks stay separate');
  assert.equal(chatRows(sessions, {}, { b: 'a' }).length, 2, 'only explicit provider links merge');
  assert.equal(chatRows(sessions, {}, { b: 'a', a: 'b' }).length, 2, 'legacy cyclic links remain one chat');
  assert.equal(chatRows([sessions[0]], {}, {}, { a: 'codex' })[0].provider, 'codex');

  await store.getState().init();
  assert.equal(store.getState().usageBy.antigravity?.groups?.length, 3, 'toUsage preserves all 3 Antigravity quota groups');
  store.getState().openSession(sessions[0]);
  await wait(() => store.getState().threads.a?.loaded);
  const initial = store.getState().threads.a;
  const agent = { id: 'helper', name: 'Research', prompt: 'Inspect parser', status: 'done', result: 'Parser bug found', items: [], historical: true };
  store.setState({ threads: { a: { ...initial, agents: { helper: agent }, draft: 'Keep draft', context: { percentage: 90 } } } });
  store.getState().switchProvider('a', 'codex');
  const switched = store.getState().threads.a;
  assert.equal(store.getState().activeId, 'a');
  assert.equal(switched.provider, 'codex');
  assert.equal(switched.draft, 'Keep draft');
  assert.equal(switched.agents.helper.result, 'Parser bug found');
  assert.equal(switched.context, undefined);
  assert.equal(chatRows([sessions[0]], store.getState().threads, {}).length, 1, 'no duplicate before destination session exists');
  store.getState().openSession(sessions[0]);
  assert.equal(store.getState().threads.a.provider, 'codex', 'clicking old alias keeps selected provider');
  store.getState().send('a', 'Continue', []);
  await wait(() => calls.some(([type]) => type === 'send'));
  const sent = calls.find(([type]) => type === 'send')[1];
  assert.equal(sent.provider, 'codex');
  assert.match(sent.instructions, /claude-100/);
  assert.match(sent.instructions, /Parser bug found/);
  event({ threadId: 'a', ev: { type: 'session', sessionId: 'b' } });
  assert.equal(chatRows(sessions.slice(0, 2), store.getState().threads, store.getState().settings.links).length, 1);
  // Finish without invoking usage/title timers: these tests cover switching, not provider billing.
  store.setState({ threads: { a: { ...store.getState().threads.a, status: 'idle' } } });
  store.getState().switchProvider('a', 'claude');
  assert.equal(store.getState().threads.a.sessionId, 'a', 'switching back resumes original provider');
  assert.equal(store.getState().activeId, 'a');
  await store.getState().loadAgentTranscripts('a');
  assert.deepEqual(calls.filter(([kind]) => kind === 'subagents').map(([, id]) => id).sort(), ['a', 'b']);

  // Restart/reopen a chat that alternated A → B → A: chronological feed, both agents, one row.
  const settings = store.getState().settings;
  store.setState({ threads: {}, activeId: '', settings });
  store.getState().openSession(sessions[1]);
  await wait(() => store.getState().threads.a?.loaded);
  assert.deepEqual(store.getState().threads.a.entries.filter((e) => e.kind === 'user').map((e) => e.text), ['claude-100', 'codex-200', 'claude-300']);
  assert.equal(store.getState().threads.a.provider, 'claude');
  store.getState().switchProvider('a', 'codex');
  const switchedSettings = store.getState().settings;
  store.setState({ threads: {}, activeId: '', settings: switchedSettings });
  store.getState().openSession(sessions[0]);
  await wait(() => store.getState().threads.a?.loaded);
  assert.equal(store.getState().threads.a.provider, 'codex', 'pending switch survives reopen before another message');
  assert.equal(store.getState().threads.a.handoff.from, 'claude');
  store.getState().switchProvider('a', 'claude');
  await store.getState().forkFrom('a');
  await wait(() => store.getState().threads.fork?.loaded);
  assert.equal(store.getState().activeId, 'fork');
  assert.equal(chatRows(sessions, store.getState().threads, settings.links).length, 2);
  assert.equal(store.getState().settings.links.fork, undefined);
  const handoff = await buildHandoff({ entries: initial.entries, from: 'codex', to: 'claude', resume: false, cwd: '/project', label: (p) => p });
  assert.match(handoff, /claude-100/, 'fresh fork provider receives full context even if it appears in copied history');
  const recorded = historyEvents([{ type: 'user', timestamp: '2026-10-18T10:00:00Z', uuid: 'u', message: { content: 'hello' } }]);
  assert.equal(fromHistory(recorded, 'claude').entries[0].ts, Date.parse('2026-10-18T10:00:00Z'));

  // A third provider retains the same logical chat and queues unsupported steering.
  store.getState().switchProvider('a', 'antigravity');
  const nSent = calls.filter(([type]) => type === 'send').length;
  store.getState().send('a', 'Continue with Google', []);
  await wait(() => calls.filter(([type]) => type === 'send').length > nSent);
  const agSend = calls.filter(([type]) => type === 'send').at(-1)[1];
  assert.equal(agSend.provider, 'antigravity');
  assert.match(agSend.instructions, /claude-100/);
  event({ threadId: 'a', ev: { type: 'session', sessionId: 'agy-local' } });
  store.getState().send('a', 'queued follow-up', []);
  assert.equal(store.getState().threads.a.queue.length, 1);
  assert.equal(calls.filter(([type]) => type === 'send').length, nSent + 1);
  store.getState().send('a', 'unsupported image', [{}]);
  assert.equal(store.getState().threads.a.queue.length, 1, 'image rejection must not enqueue or erase existing work');
  store.setState({ threads: { ...store.getState().threads, a: { ...store.getState().threads.a, status: 'idle', queue: [] } } });
  store.getState().switchProvider('a', 'codex');
  assert.equal(store.getState().threads.a.sessionId, 'b');
  store.getState().switchProvider('a', 'antigravity');
  assert.equal(store.getState().threads.a.sessionId, 'agy-local');
  store.getState().switchProvider('a', 'gemini');
  assert.equal(store.getState().threads.a.provider, 'gemini');
  event({ threadId: 'a', ev: { type: 'session', sessionId: 'gem-local' } });
  assert.equal(chatRows([...sessions.slice(0, 2), { ...sessions[0], sessionId: 'agy-local', provider: 'antigravity' }, { ...sessions[0], sessionId: 'gem-local', provider: 'gemini' }], { a: store.getState().threads.a }, store.getState().settings.links).length, 1);

  // Rewinding conversation works in Gemini/Antigravity and across mixed-provider chats without losing session identity.
  const agUserEntry = store.getState().threads.a.entries.find((e) => e.kind === 'user' && e.text === 'Continue with Google');
  store.getState().openRewind('a', agUserEntry.id);
  assert.equal(store.getState().rewindDialog?.entryId, agUserEntry.id);
  await store.getState().performRewind('a', agUserEntry.id, 'conversation');
  const rewoundThread = store.getState().threads.a;
  assert.equal(rewoundThread.provider, 'gemini');
  assert.equal(rewoundThread.sessionId, 'gem-local', 'journal-backed session id stays stable on rewind');
  assert.equal(rewoundThread.handoff?.resume, false, 'next turn re-seeds kept conversation prefix');
  assert.ok(calls.some(([type, p]) => type === 'rewindConversation' && p.provider === 'antigravity' && p.dropTurns === 1), 'non-active turn-based provider is also rolled back');
  const nBeforeRewindSend = calls.filter(([type]) => type === 'send').length;
  store.getState().send('a', 'After cross-provider rewind', []);
  await wait(() => calls.filter(([type]) => type === 'send').length > nBeforeRewindSend);
  const gemSend = calls.filter(([type]) => type === 'send').at(-1)[1];
  assert.equal(gemSend.provider, 'gemini');
  assert.match(gemSend.instructions, /claude-100/);
  assert.doesNotMatch(gemSend.instructions, /Continue with Google/);

  // A closed run can finish asynchronously after a hot switch. It must not close its successor.
  const runs = [];
  const emitted = [];
  const rolledBack = [];
  const providers = new Map(['claude', 'codex', 'gemini'].map((id) => [id, {
    id,
    caps: { rollback: id === 'claude' ? 'anchor' : 'turns' },
    rollback: async (sid, n) => rolledBack.push([id, sid, n]),
    open(spec, sink) {
      const run = { send() {}, close() {}, spec, sink };
      runs.push(run);
      return run;
    },
  }]));
  const core = createCore({ registry: { get: (id) => providers.get(id) }, emit: (...args) => emitted.push(args), browser: { dispose: () => assert.fail('switch must preserve browser') } });
  core.send({ threadId: 'chat', provider: 'claude', text: 'one', resume: 'a' });
  runs[0].sink.event({ type: 'turn.end' });
  core.switchProvider({ threadId: 'chat', provider: 'codex', resume: 'b' });
  core.send({ threadId: 'chat', provider: 'codex', text: 'two', resume: 'b' });
  runs[0].sink.closed({ error: 'late close' });
  runs[0].sink.event({ type: 'session', sessionId: 'obsolete' });
  assert.equal(core.isRunning('chat'), true);
  assert.equal(core.providerOf('chat'), 'codex');
  assert.equal(core.sessionOf('chat'), 'b');
  assert.equal(emitted.filter(([channel]) => channel === 'agent:closed').length, 0);
  runs[1].sink.closed();
  assert.equal(core.isRunning('chat'), false);
  assert.equal(emitted.filter(([channel]) => channel === 'agent:closed').length, 1);
  await core.rewindConversation({ threadId: 'chat', provider: 'gemini', sessionId: 'gem-1', dropTurns: 2 });
  assert.equal(core.providerOf('chat'), 'codex');
  assert.equal(core.sessionOf('chat'), 'b', 'rolling back another provider must not clobber active provider session');
  assert.deepEqual(rolledBack, [['gemini', 'gem-1', 2]]);
  console.log('PASS: forks, aliases, hot switch, handoff, rewind across providers, agent history, reopen ordering, stale run callbacks, cold-start selector');
} finally {
  await vite.close();
}
// Store init owns periodic refresh timers in the real app.
process.exit(0);

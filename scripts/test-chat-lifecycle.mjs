// No real providers or user settings: exercise UI state transitions and core run isolation.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

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
  configure: async (payload) => { calls.push(['configure', payload]); return true; },
  rewindConversation: async (payload) => { calls.push(['rewindConversation', payload]); return true; },
  call: async (name, ...args) => { calls.push([name, ...args]); return name === 'win:list' ? [] : true; },
  fork: async () => 'fork',
}, { get: (target, key) => target[key] ?? (() => () => {}) }) };

const vite = await createServer({ server: { middlewareMode: true, ws: false }, appType: 'custom' });
try {
  const { useStore: store, modelsOf } = await vite.ssrLoadModule('/src/store.ts');
  const { chatRows } = await vite.ssrLoadModule('/src/lib/chat-sessions.ts');
  const { buildHandoff } = await vite.ssrLoadModule('/src/lib/handoff.ts');
  const { fromHistory, applyEvent } = await vite.ssrLoadModule('/src/lib/reduce.ts');
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
  assert.deepEqual(Object.keys(store.getState().providers),['claude','codex','antigravity']);
  assert.equal(store.getState().providers.gemini,undefined);
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
  const recorded = [{ type:'user',uuid:'u',text:'hello',images:[],timestamp:Date.parse('2026-10-18T10:00:00Z') }];
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
  assert.equal(store.getState().threads.a.provider, 'antigravity', 'disabled Gemini cannot be selected');
  // Legacy Gemini history can still be opened and rewound without launching it.
  store.setState({threads:{...store.getState().threads,a:{...store.getState().threads.a,provider:'gemini'}}});
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
  const disabledCount=calls.filter(([type])=>type==='send').length;store.getState().send('a','disabled message',[]);assert.equal(calls.filter(([type])=>type==='send').length,disabledCount);
  store.getState().switchProvider('a','antigravity');
  const nBeforeRewindSend = calls.filter(([type]) => type === 'send').length;
  store.getState().send('a', 'After cross-provider rewind', []);
  await wait(() => calls.filter(([type]) => type === 'send').length > nBeforeRewindSend);
  const gemSend = calls.filter(([type]) => type === 'send').at(-1)[1];
  assert.equal(gemSend.provider, 'antigravity');
  assert.match(gemSend.instructions, /claude-100/);
  assert.doesNotMatch(gemSend.instructions, /Continue with Google/);

  // Native history paging: old context stays on disk, and only the selected helper is loaded.
  window.desk.nativeHistoryPaging=true;
  window.desk.loadSessionPage=async(_id,_cwd,_segment,provider,options)=>({events:history(provider,[options?.before?100:300]),previous:options?.before?null:3,totalTurns:3});
  const priorCall=window.desk.call;
  window.desk.call=async(name,...args)=>name==='desk:history-context'?'ORIGINAL_GOAL_FROM_DISK':priorCall(name,...args);
  store.setState({threads:{},activeId:'',settings:{...store.getState().settings,links:{},chatProviders:{}}});
  const paged={sessionId:'paged',provider:'claude',title:'Paged fixture',cwd:'/project',lastModified:300};
  store.getState().openSession(paged);await wait(()=>store.getState().threads.paged?.chain?.length===1);
  const pagedInitial=store.getState().threads.paged;
  assert.deepEqual(pagedInitial.entries.filter(e=>e.kind==='user').map(e=>e.text),['claude-300']);
  store.getState().switchProvider('paged','codex');store.getState().send('paged','Continue with the same goal',[]);
  await wait(()=>calls.some(([kind,p])=>kind==='send'&&p.threadId==='paged'));
  const pagedSent=calls.find(([kind,p])=>kind==='send'&&p.threadId==='paged')[1];
  assert.match(pagedSent.instructions,/ORIGINAL_GOAL_FROM_DISK/);assert.match(pagedSent.instructions,/claude-300/);
  const pendingSwitch={...pagedInitial,provider:'codex',handoff:{from:'claude'}};
  store.setState({threads:{paged:pendingSwitch},activeId:'paged'});
  window.desk.call=async(name,...args)=>{if(name==='desk:history-context')throw Error('History is temporarily unavailable');return priorCall(name,...args)};
  const beforeFailedSwitch=calls.filter(([kind])=>kind==='send').length;
  store.getState().send('paged','Keep my goal',[]);
  await wait(()=>store.getState().threads.paged.status==='idle');
  assert.equal(calls.filter(([kind])=>kind==='send').length,beforeFailedSwitch,'do not send without older handoff context');
  assert.equal(store.getState().threads.paged.handoff.from,'claude');
  assert.equal(store.getState().threads.paged.draft,'Keep my goal');
  assert.deepEqual(store.getState().threads.paged.entries,pagedInitial.entries);
  window.desk.call=async(name,...args)=>name==='desk:history-context'?'ORIGINAL_GOAL_FROM_DISK':priorCall(name,...args);
  store.setState({threads:{paged:pagedInitial},activeId:'paged'});
  await store.getState().loadEarlierPart('paged');
  assert.deepEqual(store.getState().threads.paged.entries.filter(e=>e.kind==='user').map(e=>e.text),['claude-100','claude-300']);
  const loadedHelpers=[];
  window.desk.loadSubagentPage=async(sessionId,_cwd,provider,helper,options)=>{loadedHelpers.push(helper);return{found:true,events:[{type:'text',agent:helper,id:options?.before?'old-helper':'new-helper',text:options?.before?'Earlier helper work':'Recent helper work',mode:'final'}],previous:options?.before?null:2,totalTurns:2}};
  store.setState({threads:{paged:{...store.getState().threads.paged,agents:{helper:{...agent,items:[]},other:{...agent,id:'other',items:[]}}}}});
  await store.getState().loadAgentTranscripts('paged','helper');
  assert.deepEqual(loadedHelpers,['helper']);assert.equal(store.getState().threads.paged.agents.other.transcriptLoaded,undefined);
  assert.equal(store.getState().threads.paged.agents.helper.transcriptCursor,2);
  await store.getState().loadAgentTranscripts('paged','helper',2);
  assert.deepEqual(store.getState().threads.paged.agents.helper.items.filter(i=>i.kind==='text').map(i=>i.text),['Earlier helper work','Recent helper work']);
  // Native slash commands are local operations on the same chat, never model prompts.
  const codex={...store.getState().threads.paged,id:'native-commands',provider:'codex',sessionId:'native-session',status:'idle',handoff:undefined,entries:[],agents:{},model:'limited',effort:'max'};
  store.setState({threads:{[codex.id]:codex},activeId:codex.id,providers:{...store.getState().providers,codex:{...store.getState().providers.codex,models:[{value:'limited',displayName:'Limited',supportedEffortLevels:['low','ultra']},{value:'no-reasoning',displayName:'No reasoning'}]}}});
  window.desk.call=priorCall;
  const beforeCommands=calls.filter(([kind])=>kind==='send').length;
  store.getState().send(codex.id,'/mcp',[]);assert.equal(store.getState().codexPanel.tab,'mcp');
  store.getState().send(codex.id,'/permissions plan',[]);assert.equal(store.getState().threads[codex.id].permissionMode,'plan');
  store.getState().send(codex.id,'/compact',[]);
  await wait(()=>calls.some(([kind,p])=>kind==='desk:codex'&&p.action==='compact'));
  assert.equal(calls.filter(([kind])=>kind==='send').length,beforeCommands);
  assert.equal(store.getState().threads[codex.id].sessionId,'native-session');
  const compact=calls.find(([kind,p])=>kind==='desk:codex'&&p.action==='compact')[1];assert.equal(compact.config.effort,'ultra');assert.equal(compact.config.permissionMode,'plan');
  const state=applyEvent({...codex,codex:{goal:{objective:'keep goal'}}},{type:'codex.state',state:{questions:{id:'ask-1',items:[{title:'Pick one',options:['A','B']}]}}});
  assert.equal(state.codex.goal.objective,'keep goal');assert.equal(state.codex.questions.items[0].title,'Pick one');
  const scoped=applyEvent({...state,context:{percentage:11},tasks:{},agents:{}},{type:'context',agent:'nested',usage:{totalTokens:90,maxTokens:100,percentage:90,categories:[]}});
  assert.equal(scoped.context.percentage,11);assert.equal(scoped.agents.nested.progress,'90% context');
  const announced=applyEvent(scoped,{type:'agent',id:'nested',runId:'sub-nested',parentId:'parent',provider:'codex'});assert.equal(announced.agents.nested.runId,'sub-nested');
  const titled=applyEvent(announced,{type:'codex.state',agent:'nested',state:{title:'Child title',goal:null}});assert.equal(titled.title,announced.title);assert.equal(titled.codex.goal.objective,'keep goal');
  store.setState({threads:{[codex.id]:{...state,status:'idle',model:'no-reasoning'}}});
  store.getState().send(codex.id,'Normal user message',[]);
  await wait(()=>calls.filter(([kind])=>kind==='send').length>beforeCommands);
  assert.equal(calls.filter(([kind])=>kind==='send').at(-1)[1].effort,null,'clear unsupported persisted reasoning effort');
  assert.equal(store.getState().threads[codex.id].codex.questions,null,'new user input dismisses async questions');
  // First-send preparation must finish before a mid-turn note reaches the transport.
  const originalGit=window.desk.gitStatus;let releaseGit;
  window.desk.gitStatus=()=>new Promise(resolve=>{releaseGit=resolve});
  const sending={...codex,id:'preparing-steer',status:'idle',entries:initial.entries,agents:{},handoff:{from:'claude'},chain:undefined,sessionId:undefined};
  store.setState({threads:{[sending.id]:sending},activeId:sending.id,settings:{...store.getState().settings,followUp:'steer'}});
  const beforePrepare=calls.filter(([kind])=>kind==='send').length;
  store.getState().send(sending.id,'Initial prepared message',[]);store.getState().send(sending.id,'Note during thinking',[]);
  assert.equal(calls.filter(([kind])=>kind==='send').length,beforePrepare);
  let steer=()=>store.getState().threads[sending.id].entries.flatMap(e=>e.kind==='turn'?e.items:[]).find(i=>i.kind==='steer');
  assert.equal(steer().text,'Note during thinking');assert.equal(steer().delivery,'sending');
  releaseGit({files:[]});await wait(()=>calls.filter(([kind])=>kind==='send').length>=beforePrepare+2);
  const ordered=calls.filter(([kind])=>kind==='send').slice(beforePrepare).map(([,p])=>p);assert.equal(ordered[0].text,'Initial prepared message');assert.equal(ordered[1].text,'Note during thinking');assert.equal(ordered[1].uuid,steer().id);
  event({threadId:sending.id,ev:{type:'step'}});assert.equal(steer().delivery,'sending','unrelated model steps are not send acknowledgments');
  event({threadId:sending.id,ev:{type:'message.receipt',id:steer().id,status:'accepted'}});assert.equal(steer().delivery,'accepted');
  event({threadId:sending.id,ev:{type:'message.receipt',id:'unrelated-id',status:'failed',error:'ignored'}});assert.equal(steer().delivery,'accepted');
  const oldId=steer().id;event({threadId:sending.id,ev:{type:'message.receipt',id:oldId,status:'failed',error:'Fixture transport failure'}});assert.equal(store.getState().threads[sending.id].status,'running');assert.equal(steer().delivery,'failed');
  store.getState().retrySteer(sending.id,oldId);await wait(()=>calls.filter(([kind])=>kind==='send').length===beforePrepare+3);assert.notEqual(steer().id,oldId);assert.equal(steer().text,'Note during thinking');
  const newId=steer().id;event({threadId:sending.id,ev:{type:'message.receipt',id:newId,status:'consumed'}});event({threadId:sending.id,ev:{type:'message.receipt',id:newId,status:'accepted'}});assert.equal(steer().delivery,'consumed');
  window.desk.gitStatus=originalGit;
  console.log('PASS mid-turn immediate visibility, ordered preparation, correlated receipts, failure isolation and retry');
  window.desk.nativeHistoryPaging=false;window.desk.call=priorCall;
  console.log('PASS: forks, aliases, hot switch, handoff, rewind across providers, agent history, reopen ordering, cold-start selector, native history pages and selected helper paging');
} finally {
  await vite.close();
}
// Store init owns periodic refresh timers in the real app.
process.exit(0);

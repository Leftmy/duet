const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.argv[2];
app.setPath('userData', root);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('UI test deadline exceeded'); app.exit(1); }, 45000);
let stops = 0, initializations = 0, reported = 0;
const settings = { cwd: root, autoTitles: false, notifications: false, changesOpen: true };
const values = {
  'app:getSettings': () => { initializations++; return settings; },
  'app:setSettings': (patch) => Object.assign(settings, patch),
  'agent:probe': () => ({ account: {}, models: [], commands: [], providers: { claude: { label: 'Claude', available: true, models: [], caps: {} } } }),
  'agent:listSessions': () => [], 'wt:all': () => ({}), 'win:list': () => [],
  'cmd:list': () => [], 'app:buildInfo': () => ({ canRebuild: false, newer: false }),
  'desk:watch': () => true, 'app:setTheme': () => true, 'app:gitBranch': () => null,
  'agent:usage': () => ({}), 'agent:contextUsage': () => null,
  'voice:status': () => ({}), 'voice:models': () => [],
  'app:openTargets': () => [], 'wt:isRepo': () => false,
  'desk:ui-error': () => { reported++; return true; },
  'agent:closeThread': () => { stops++; }, 'agent:interrupt': () => { stops++; },
};
for (const [channel, fn] of Object.entries(values)) ipcMain.handle(channel, (_event, ...args) => fn(...args));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1380, height: 880, webPreferences: {
    preload: path.resolve(__dirname, '../../electron/preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false,
  } });
  win.webContents.on('render-process-gone', (_event, details) => { console.error(JSON.stringify(details)); app.exit(1); });
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  await win.loadFile(path.resolve(__dirname, '../../dist/index.html'));
  await run(async () => {
    for (let n = 0; n < 200 && !window.__deskStore?.getState().ready; n++) await new Promise((r) => setTimeout(r, 10));
    if (!window.__deskStore?.getState().ready) throw new Error('Store did not initialize');
    const s = window.__deskStore, id = s.getState().activeId, blank = s.getState().threads[id];
    const entries = Array.from({ length: 400 }, (_, n) => ({ kind: 'turn', id: `old${n}`, provider: 'claude', done: true, startedAt: n,
      items: [{ kind: 'text', id: `prior${n}`, text: `Prior response ${n}`, confirmed: true }] }));
    entries.push({ kind: 'turn', id: 'live', provider: 'claude', done: false, startedAt: 1000, items: [] });
    const agents = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`a${n}`, {
      id: `a${n}`, name: `Agent ${n}`, prompt: '', color: n, status: 'running', startedAt: Date.now(), toolUses: 0,
      items: Array.from({ length: 100 }, (_, k) => ({ kind: 'text', id: `old${k}`, text: 'Completed helper step', confirmed: true })),
    }]));
    window.__testThread = id; window.__testEntries = entries; window.__testCommits = 0;
    s.setState({ threads: { [id]: { ...blank, entries, agents, status: 'running' } }, panelTab: 'agents', focusAgent: 'a0' });
    s.subscribe((next, prev) => { if (next.threads !== prev.threads) window.__testCommits++; });
  });
  await run(() => new Promise((r) => setTimeout(r, 150)));
  const id = await run(() => window.__testThread);
  const { createEventBatcher } = await import('../../electron/core/event-batch.mjs');
  let batches = 0;
  const batcher = createEventBatcher((payloads) => { batches++; win.webContents.send('agent:events', payloads); });
  const started = Date.now();
  for (let n = 0; n < 10000; n++) batcher.push({ threadId: id, ev: { type: 'text', agent: `a${n % 200}`, id: 'answer', text: 'x', mode: 'delta' } });
  batcher.flush();
  const result = await run(async () => {
    for (let n = 0; n < 200; n++) {
      const t = window.__deskStore.getState().threads[window.__testThread];
      if (t.agents.a199.items.at(-1).text === 'x'.repeat(50)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 100));
    const t = window.__deskStore.getState().threads[window.__testThread];
    return { complete: Object.values(t.agents).every((a) => a.items.at(-1).text === 'x'.repeat(50)),
      sameHistory: t.entries === window.__testEntries, commits: window.__testCommits,
      mountedTurns: document.querySelectorAll('.turn').length, mountedAgentItems: document.querySelectorAll('.agent-scroll .items > div').length,
      failed: !!document.querySelector('.ui-failure') };
  });
  assert.equal(result.complete, true);
  assert.equal(result.sameHistory, true);
  assert.equal(result.failed, false);
  assert.ok(result.commits <= batches + 3);
  assert.ok(result.mountedTurns <= 40);
  assert.ok(result.mountedAgentItems <= 102);
  console.log(`Electron: 200 agents / 10000 events in ${Date.now() - started} ms, ${result.commits} commits, ${result.mountedTurns} mounted turns`);

  // A render exception should offer recovery without reinitializing or stopping a run.
  await run(async () => {
    const s = window.__deskStore, t = s.getState().threads[window.__testThread];
    s.setState({ threads: { ...s.getState().threads, [t.id]: { ...t, entries: [{ kind: 'turn', id: 'broken-view', done: false, items: null }] } } });
    for (let n = 0; n < 100 && !document.querySelector('[data-ui-recover]'); n++) await new Promise((r) => setTimeout(r, 10));
    const recover = document.querySelector('[data-ui-recover]');
    if (!recover) throw new Error('No error recovery screen');
    recover.click();
    await new Promise((r) => setTimeout(r, 100));
    if (document.querySelector('.ui-failure')) throw new Error('Interface did not recover');
    if (s.getState().threads[window.__testThread].status !== 'running') throw new Error('Recovery lost the running thread');
  });
  win.webContents.send('agent:events', [{ threadId: id, ev: { type: 'text', agent: 'a0', id: 'answer', text: '!', mode: 'delta' } }]);
  const continued = await run(async () => {
    await new Promise((r) => setTimeout(r, 100));
    return window.__deskStore.getState().threads[window.__testThread].agents.a0.items.at(-1).text;
  });
  assert.equal(continued, 'x'.repeat(50) + '!');
  assert.equal(initializations, 1);
  assert.equal(stops, 0);
  assert.ok(reported >= 1);
  console.log('PASS: isolated Electron stress, bounded DOM, React failure recovery and continued agent delivery without stopping/reinitializing');
  clearTimeout(deadline);
  app.exit(0);
}).catch((error) => { console.error(error.stack || error); app.exit(1); });

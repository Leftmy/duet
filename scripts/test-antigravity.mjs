import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAntigravityProvider, runArgs } from '../electron/providers/antigravity/index.mjs';
import { subscriptionEnvironment, parseModels, parseUsage } from '../electron/providers/antigravity/cli.mjs';
import { createSessions } from '../electron/providers/antigravity/sessions.mjs';
import { createTranslator } from '../electron/providers/antigravity/translate.mjs';

const quota = { status: 'SUCCESS', command: { data: { groups: [
  { buckets: [{ window: '5h', remaining_fraction: 0.8, reset_time: '2026-10-19T20:00:00Z' }] },
  { buckets: [{ window: '5h', remaining_fraction: 0.4, reset_time: '2026-10-19T21:00:00Z' }, { window: 'weekly', remaining_fraction: 1 }] },
] } } };
const fixture = fileURLToPath(new URL('./fixtures/antigravity-cli.mjs', import.meta.url));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-agy-test-'));
  const log = path.join(root, 'peer.jsonl');
  const children = [];
  const provider = createAntigravityProvider({
    dataDir: root, resolveBin: () => process.execPath,
    environment: () => ({ ...subscriptionEnvironment({ ...process.env, GEMINI_API_KEY: 'must-not-reach-child' }, root), AGY_FIXTURE_LOG: log }),
    cli: async (_bin, args) => args[0] === '--help' ? '--input-format --disable-slash-commands' : args[0] === '--version' ? 'test' : args[0] === 'models' ? 'Loading models...\nmodel-a\tModel A' : JSON.stringify(quota),
    spawnProcess(bin, args, opts) {
      const proc = spawn(bin, [fixture, ...args], opts);
      children.push(proc);
      return proc;
    },
  });
  t.after(async () => {
    provider.close();
    await Promise.all(children.filter((c) => c.exitCode === null).map((c) => new Promise((resolve) => c.once('close', resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const peer = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  return { root, provider, peer };
}

test('subscription mode strips keys and ADC without changing global files; rejects API configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-agy-auth-'));
  try {
    const env = { PATH: 'keep', GEMINI_API_KEY: 'secret', google_api_key: 'secret', AGY_ADC_AUTH: 'true', GOOGLE_APPLICATION_CREDENTIALS: '/key.json' };
    assert.deepEqual(subscriptionEnvironment(env, root), { PATH: 'keep' });
    assert.equal(env.GEMINI_API_KEY, 'secret');
    const settings = path.join(root, '.gemini', 'antigravity-cli', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{"modelProvider":"gemini"}');
    assert.throws(() => subscriptionEnvironment(env, root), /subscriptions only/);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{"modelProvider":"gemini"}');
    fs.writeFileSync(settings, '{}');
    const adc = path.join(root, '.gemini', 'config', 'config.json');
    fs.mkdirSync(path.dirname(adc), { recursive: true });
    fs.writeFileSync(adc, '{"userSettings":{"enableAdc":true}}');
    assert.throws(() => subscriptionEnvironment(env, root), /Google Cloud ADC/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('model discovery, quota aggregation and permission flags', () => {
  assert.deepEqual(parseModels('Loading...\nslug\tName')[0].value, 'slug');
  assert.equal(parseUsage(quota).session.pct, 60);
  const mixed = parseUsage({ status: 'SUCCESS', command: { data: { groups: [
    { name: 'Claude and GPT models', buckets: [{ window: '5h', remaining_fraction: 0.94 }, { window: 'weekly', remaining_fraction: 0.97 }] },
    { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remaining_fraction: 0.64 }] },
  ] } } });
  assert.equal(Math.round(mixed.session.pct), 6);
  assert.equal(Math.round(mixed.weekly.pct), 3, 'weekly-only Argon bucket does not overwrite paired 5h+weekly group');
  assert.equal(mixed.groups.length, 2);
  assert.throws(() => parseUsage({ status: 'SUCCESS' }), /subscription quotas/);
  assert.throws(() => parseUsage({ status: 'ERROR', error: 'Sign in' }), /Sign in/);
  assert.ok(!runArgs({ permissionMode: 'default' }, {}).includes('--dangerously-skip-permissions'));
  assert.ok(runArgs({ permissionMode: 'bypassPermissions' }, {}).includes('--dangerously-skip-permissions'));
  const args = runArgs({ permissionMode: 'plan', model: 'slug' }, { dirs: ['space dir'] }, 'native-id');
  assert.deepEqual(args.slice(-8), ['--conversation', 'native-id', '--model', 'slug', '--mode', 'plan', '--add-dir', 'space dir']);
});

test('persistent turns, configuration restart, history and native resume retain one session', async (t) => {
  const { root, provider, peer } = setup(t);
  assert.equal((await provider.probe()).models.length, 2);
  const events = [];
  let done;
  const run = provider.open({ cwd: root, instructions: 'handoff context' }, { event(ev) { events.push(ev); if (ev.type === 'turn.end') done?.(ev); }, closed() {} });
  const send = (text) => new Promise((resolve) => { done = resolve; run.send({ text }); });
  await send('first');
  const id = run.sessionId;
  await send('second');
  assert.equal(peer().filter((p) => p.args).length, 1);
  await run.configure({ model: 'new-model', permissionMode: 'plan' });
  assert.equal((await send('__recall__')).text, 'second');
  const invocations = peer().filter((p) => p.args);
  assert.equal(invocations.length, 2);
  assert.ok(invocations[1].args.includes('--conversation'));
  assert.ok(invocations[1].args.includes('native-test-session'));
  assert.ok(invocations[1].args.includes('new-model'));
  assert.ok(invocations.every((p) => p.api === null));
  assert.equal(peer().filter((p) => p.prompt?.includes('handoff context')).length, 1);
  assert.equal(run.sessionId, id);
  run.close();
  const resumed = await provider.runHeadless({ cwd: root, resume: id, prompt: '__recall__' });
  assert.equal(resumed.sessionId, id);
  assert.equal(resumed.text, 'second');
  const history = await provider.loadHistory(id);
  assert.equal(history.filter((e) => e.type === 'user').length, 4);
  assert.equal(history.filter((e) => e.type === 'turn.end').length, 4);
  assert.ok(history.every((e) => Number.isFinite(e.timestamp)));
  assert.ok(history.some((e) => e.type === 'tool' && e.name === 'Read'));
  assert.equal(history.find((e) => e.type === 'user').text, 'first');
  assert.equal(provider.caps.rollback, 'turns');
  await provider.rollback(id, 2);
  const rewoundHistory = await provider.loadHistory(id);
  assert.deepEqual(rewoundHistory.filter((e) => e.type === 'user').map((e) => e.text), ['first', 'second']);
  const afterRewind = await provider.runHeadless({ cwd: root, resume: id, prompt: 'after-rewind' });
  assert.equal(afterRewind.sessionId, id);
  assert.match(peer().at(-1).prompt, /<context_handoff>[\s\S]*first[\s\S]*second[\s\S]*after-rewind/);
  assert.ok(!peer().filter((p) => p.args).at(-1).args.includes('--conversation'), 'rewound turn starts fresh native conversation');
  await provider.renameSession(id, 'Custom title');
  assert.equal((await provider.listSessions())[0].title, 'Custom title');
  await provider.deleteSession(id);
  assert.deepEqual(await provider.listSessions(), []);
});

test('malformed output, early process exit, images and timeout fail without hanging', async (t) => {
  const { provider, root } = setup(t);
  await assert.rejects(provider.runHeadless({ cwd: root, prompt: '__malformed__' }), /Antigravity stream/);
  await assert.rejects(provider.runHeadless({ cwd: root, prompt: '__exit__' }), /fixture failure/);
  await assert.rejects(provider.runHeadless({ cwd: root, prompt: '__hang__', timeoutMs: 500 }), /timed out/);
  await new Promise((resolve) => {
    const run = provider.open({ cwd: root }, { event() {}, closed({ error }) { assert.match(error, /text only/); resolve(); } });
    run.send({ text: 'image', images: [{}] });
  });
});

test('interrupt closes only its own run; late events cannot affect the next run', async (t) => {
  const { provider, root } = setup(t);
  const events = [];
  let stopped = false;
  const run = provider.open({ cwd: root }, { event: (e) => events.push(e), closed: () => { stopped = true; } });
  run.send({ text: '__hang__' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await run.interrupt();
  assert.ok(stopped);
  const n = events.length;
  const next = await provider.runHeadless({ cwd: root, prompt: 'next' });
  assert.equal(next.text, 'next');
  assert.equal(events.length, n);
});

test('translator preserves fragments, errors and unfinished tools; journal rejects path traversal', () => {
  const tr = createTranslator('turn');
  tr.push({ event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command' } });
  tr.push({ event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'hel' } });
  tr.push({ event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: 'lo' } });
  const result = tr.push({ event: 'result', result: { status: 'ERROR', error: 'failed', response: 'hello' } });
  assert.equal(result.find((e) => e.type === 'text').text, 'hello');
  assert.equal(result.find((e) => e.type === 'tool.result').status, 'error');
  assert.equal(result.at(-1).isError, true);
  assert.throws(() => createSessions(os.tmpdir()).read('../outside'), /Invalid/);
});

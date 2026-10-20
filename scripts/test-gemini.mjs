import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGeminiProvider, runArgs } from '../electron/providers/gemini/index.mjs';
import { subscriptionEnvironment, parseModels, parseUsage } from '../electron/providers/gemini/cli.mjs';
import { createSessions } from '../electron/providers/gemini/sessions.mjs';
import { createTranslator } from '../electron/providers/gemini/translate.mjs';

const quota = {
  status: 'SUCCESS',
  plan: 'Gemini Code Assist',
  email: 'user@example.com',
  buckets: [
    { modelId: 'gemini-2.5-pro', remainingFraction: 0.8, resetTime: '2026-10-19T20:00:00Z' },
    { modelId: 'gemini-3-flash', remainingFraction: 0.35, resetTime: '2026-10-19T21:00:00Z' },
  ],
};

const fixture = fileURLToPath(new URL('./fixtures/gemini-cli.mjs', import.meta.url));

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-gemini-test-'));
  const log = path.join(root, 'peer.jsonl');
  const children = [];
  const provider = createGeminiProvider({
    dataDir: root,
    resolveBin: () => process.execPath,
    environment: () => ({
      ...subscriptionEnvironment({ ...process.env, GEMINI_API_KEY: 'must-not-reach-child' }, root),
      GEMINI_FIXTURE_LOG: log,
    }),
    cli: async (_bin, args) =>
      args[0] === '--help'
        ? '--output-format --resume --approval-mode'
        : args[0] === '--version'
          ? '0.64.0'
          : args[0] === 'models'
            ? 'gemini-2.5-pro\tGemini 2.5 Pro'
            : JSON.stringify(quota),
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

test('subscription mode strips API/Vertex/ADC vars, sets GCA oauth-personal, and rejects non-subscription auth', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-gemini-auth-'));
  try {
    const env = {
      PATH: 'keep',
      GEMINI_API_KEY: 'secret',
      GOOGLE_API_KEY: 'secret',
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_CLOUD_PROJECT: 'billing-proj',
      GOOGLE_APPLICATION_CREDENTIALS: '/key.json',
    };
    assert.deepEqual(subscriptionEnvironment(env, root), {
      PATH: 'keep',
      GOOGLE_GENAI_USE_GCA: 'true',
      NO_BROWSER: 'true',
    });
    assert.equal(env.GEMINI_API_KEY, 'secret');
    const settings = path.join(root, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{"security":{"auth":{"selectedType":"gemini-api-key"}}}');
    assert.throws(() => subscriptionEnvironment(env, root), /subscriptions/);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{"security":{"auth":{"selectedType":"gemini-api-key"}}}');
    fs.writeFileSync(settings, '{"security":{"auth":{"selectedType":"oauth-personal"}}}');
    assert.equal(subscriptionEnvironment(env, root).GOOGLE_GENAI_USE_GCA, 'true');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model discovery, quota aggregation and approval flags', () => {
  assert.equal(parseModels('slug\tCustom Model')[0].value, 'slug');
  assert.ok(parseModels('').length >= 4);
  const parsed = parseUsage(quota);
  assert.equal(Math.round(parsed.session.pct), 65);
  assert.equal(parsed.email, 'user@example.com');
  assert.throws(() => parseUsage({ status: 'SUCCESS', buckets: [] }), /subscription quotas/);
  assert.throws(() => parseUsage({ status: 'ERROR', error: 'Sign in' }), /Sign in/);
  assert.ok(runArgs({ permissionMode: 'default' }, {}).includes('default'));
  assert.ok(runArgs({ permissionMode: 'bypassPermissions' }, {}).includes('yolo'));
  assert.ok(runArgs({ permissionMode: 'acceptEdits' }, {}).includes('auto_edit'));
  const args = runArgs({ permissionMode: 'plan', model: 'gemini-2.5-pro' }, { dirs: ['space dir'] }, 'native-id');
  assert.deepEqual(args, [
    '--output-format', 'stream-json', '--skip-trust',
    '--resume', 'native-id',
    '--model', 'gemini-2.5-pro',
    '--approval-mode', 'plan',
    '--include-directories', 'space dir',
    '-p', '',
  ]);
});

test('multi-turn sessions, configuration changes, history and native resume retain one session', async (t) => {
  const { root, provider, peer } = setup(t);
  const probe = await provider.probe();
  assert.equal(probe.models.length, 2);
  assert.equal(probe.account.email, 'user@example.com');
  const events = [];
  let done;
  const run = provider.open(
    { cwd: root, instructions: 'handoff context' },
    { event(ev) { events.push(ev); if (ev.type === 'turn.end') done?.(ev); }, closed() {} },
  );
  const send = (text) => new Promise((resolve) => { done = resolve; run.send({ text }); });
  await send('first');
  const id = run.sessionId;
  await send('second');
  await run.configure({ model: 'gemini-3-pro-preview', permissionMode: 'plan' });
  assert.equal((await send('__recall__')).text, 'second');
  const invocations = peer().filter((p) => p.args);
  assert.equal(invocations.length, 3);
  assert.ok(!invocations[0].args.includes('--resume'));
  assert.ok(invocations[1].args.includes('--resume'));
  assert.ok(invocations[1].args.includes('native-gemini-session'));
  assert.ok(invocations[2].args.includes('gemini-3-pro-preview'));
  assert.ok(invocations.every((p) => p.api === null && p.gca === 'true'));
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
  assert.ok(!peer().filter((p) => p.args).at(-1).args.includes('--resume'), 'rewound turn starts fresh native conversation');
  await provider.renameSession(id, 'Custom Gemini title');
  assert.equal((await provider.listSessions())[0].title, 'Custom Gemini title');
  await provider.deleteSession(id);
  assert.deepEqual(await provider.listSessions(), []);
});

test('malformed output, early process exit, images and timeout fail without hanging', async (t) => {
  const { provider, root } = setup(t);
  await assert.rejects(provider.runHeadless({ cwd: root, prompt: '__malformed__' }), /Gemini stream/);
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

test('translator maps tools, preserves fragments, errors and unfinished tools; journal rejects path traversal', () => {
  const tr = createTranslator('turn');
  tr.push({ type: 'tool_use', tool_id: 't1', tool_name: 'run_shell_command', parameters: { command: 'ls' } });
  tr.push({ type: 'message', role: 'assistant', content: 'hel', delta: true });
  tr.push({ type: 'message', role: 'assistant', content: 'lo', delta: true });
  tr.push({ type: 'error', severity: 'error', message: 'rate limit' });
  const result = tr.push({ type: 'result', status: 'error' });
  assert.equal(result.find((e) => e.type === 'text').text, 'hello');
  assert.equal(result.find((e) => e.type === 'tool.result').status, 'error');
  assert.equal(result.at(-1).isError, true);
  assert.match(result.at(-1).error, /rate limit/);
  assert.throws(() => createSessions(os.tmpdir()).read('../outside'), /Invalid/);
});

// Contract check for an agent provider: node scripts/provider-check.mjs <id> [--model <model>] [--keep]
// Runs the provider through the real core in a scratch folder (probe, streaming, a shell command,
// an approval, a desk tool, resume, history, session list) and validates every event it emits.
// A new provider is ready to wire into main.mjs when this passes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegistry } from '../electron/core/registry.mjs';
import { createCore } from '../electron/core/runs.mjs';
import { validateEvent } from '../electron/core/events.mjs';
import { sessionToolset } from '../electron/session-tools.mjs';

const args = process.argv.slice(2);
const id = args[0];
if (!id) {
  console.error('usage: node scripts/provider-check.mjs <provider id> [--model <model>] [--keep]');
  process.exit(2);
}
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
const keep = args.includes('--keep');

const create = (await import(new URL(`../electron/providers/${id}/index.mjs`, import.meta.url))).default;
const provider = create({ log: () => {} });
const registry = createRegistry();
registry.register(provider);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `duet-check-${id}-`));
fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello\n');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const events = [];
const bad = [];
let onEvent = () => {};
let approve = 'allow';
const asked = [];
const core = createCore({
  registry,
  toolsFor: () => [sessionToolset()],
  emit(channel, p) {
    if (channel === 'agent:event') {
      const err = validateEvent(p.ev);
      if (err) bad.push(err);
      events.push(p.ev);
      onEvent(p.ev);
    } else if (channel === 'agent:permission') {
      asked.push(p.toolName);
      core.respondPermission({ threadId: p.threadId, reqId: p.reqId, decision: approve, ...(approve === 'deny' ? { message: 'Denied by the check.' } : {}) });
    }
  },
});

/** Sends a message and resolves with the turn.end event (or null on timeout). */
function turn(threadId, text, extra = {}, timeoutMs = 240000) {
  const from = events.length;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    onEvent = (ev) => {
      if (ev.type === 'turn.end') {
        clearTimeout(timer);
        resolve({ end: ev, events: events.slice(from) });
      }
    };
    core.send({ threadId, provider: id, cwd, model, effort: 'low', permissionMode: 'default', text, ...extra });
  });
}

console.log(`Checking provider "${id}" in ${cwd}\n`);

// 1. probe
let probe;
try {
  probe = await provider.probe(true);
  ok('probe', probe?.available !== false && Array.isArray(probe?.models), `${probe?.models?.length ?? 0} models, version ${probe?.version ?? '?'}`);
} catch (e) {
  ok('probe', false, String(e?.message || e));
  process.exit(1);
}
ok('caps declared', provider.caps && Array.isArray(provider.caps.modes));

// 2. a plain answer
let r = await turn('t1', 'Reply with exactly the word: ready');
ok('turn ends', Boolean(r), r ? '' : 'no turn.end within the timeout');
const sessionId = core.sessionOf('t1');
ok('session event', Boolean(sessionId), sessionId ?? '');
ok('answer text', Boolean(r?.events.some((e) => e.type === 'text' && e.mode === 'final' && /ready/i.test(e.text))), r?.end?.text ?? '');

// 3. a shell command, its result and a step marker
r = await turn('t1', 'Run this shell command and reply with its output only: node -e "console.log(6*7)"');
const tool = r?.events.find((e) => e.type === 'tool' && e.final);
ok('tool call (final input)', Boolean(tool), tool ? `${tool.name} ${JSON.stringify(tool.input).slice(0, 80)}` : '');
const result = r?.events.find((e) => e.type === 'tool.result' && e.id === tool?.id);
ok('tool result', Boolean(result) && /42/.test(result.result + (r?.end?.text ?? '')), result?.result?.slice(0, 60) ?? '');

// 4. an approval that gets denied
approve = 'deny';
asked.length = 0;
r = await turn('t1', 'Create a file named denied.txt in the current folder (with a shell command or a file edit), then reply done.');
ok('approval asked', asked.length > 0, asked.join(', ') || 'no permission request (the provider may treat this mode as auto-approve)');
ok('denied action did not happen', !fs.existsSync(path.join(cwd, 'denied.txt')));
approve = 'allow';

// 5. a desk tool
r = await turn('t1', 'Call the mark_chapter tool with the title "Check", then reply ok.');
const desk = r?.events.find((e) => e.type === 'tool' && /mark_chapter$/.test(e.name));
ok('desk tool call', Boolean(desk), desk?.name ?? '');
ok('desk tool result', Boolean(r?.events.some((e) => e.type === 'tool.result' && e.id === desk?.id && e.status === 'done')));

// 6. resume in a fresh run
core.closeThread('t1');
r = await turn('t2', 'What exact word did I ask you to reply with at the very start? One word.', { resume: sessionId });
ok('resume keeps context', /ready/i.test(r?.end?.text ?? ''), r?.end?.text ?? '');
ok('resume keeps the session id', !core.sessionOf('t2') || core.sessionOf('t2') === sessionId);
core.closeThread('t2');

// 7. history and session list
const history = await provider.loadHistory(sessionId, cwd);
const histBad = history.map(validateEvent).filter(Boolean);
ok('history events valid', histBad.length === 0, histBad.slice(0, 3).join('; '));
ok('history has the conversation', history.some((e) => e.type === 'user') && history.some((e) => e.type === 'text'), `${history.length} events`);
ok('history has tool calls', history.some((e) => e.type === 'tool' && e.final !== false) && history.some((e) => e.type === 'tool.result'));
const sessions = await provider.listSessions();
ok('session listed', sessions.some((s) => s.sessionId === sessionId && s.provider === id));

ok('all live events valid', bad.length === 0, bad.slice(0, 3).join('; '));

if (!keep) {
  await provider.deleteSession(sessionId, cwd).catch(() => {});
  // The agent's process may still hold the folder for a moment.
  try {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  } catch {}
}
provider.close?.();
console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);

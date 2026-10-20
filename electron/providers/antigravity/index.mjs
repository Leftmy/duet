import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { command, findAntigravity, parseModels, parseUsage, readGoogleEmail, subscriptionEnvironment } from './cli.mjs';
import { createTranslator } from './translate.mjs';
import { createSessions } from './sessions.mjs';

export function runArgs(config, spec, nativeId) {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'];
  if (nativeId) args.push('--conversation', nativeId);
  if (config.model && config.model !== 'default') args.push('--model', config.model);
  if (config.effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(config.effort)) args.push('--effort', config.effort);
  if (config.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (config.permissionMode === 'plan') args.push('--mode', 'plan');
  else if (config.permissionMode === 'auto') args.push('--mode', 'auto');
  else if (config.permissionMode === 'acceptEdits') args.push('--mode', 'accept-edits');
  for (const dir of spec.dirs ?? []) args.push('--add-dir', dir);
  return args;
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill('SIGTERM');
}

export function createAntigravityProvider({ dataDir, log = () => {}, resolveBin = findAntigravity, environment = subscriptionEnvironment, cli = command, spawnProcess = spawn } = {}) {
  const sessions = createSessions(path.join(dataDir, 'antigravity'));
  const runs = new Set();
  let cached = null;
  let cachedAt = 0;
  async function discover(force = false) {
    if (!cached || force || Date.now() - cachedAt > 60000) {
      cachedAt = Date.now();
      cached = (async () => {
        const bin = resolveBin();
        const env = environment();
        const [version, help, models, usage] = await Promise.all([
          cli(bin, ['--version'], env), cli(bin, ['--help'], env, 30000, true),
          cli(bin, ['models'], env), cli(bin, ['-p', '/usage', '--output-format', 'json'], env),
        ]);
        if (!help.includes('--input-format') || !help.includes('--disable-slash-commands')) throw new Error('Update Antigravity CLI with agy update: Duet requires the streaming JSON interface.');
        return { bin, version, models: parseModels(models), usage: parseUsage(JSON.parse(usage)) };
      })();
    }
    try { return await cached; } catch (e) { cached = null; throw e; }
  }
  const provider = {
    id: 'antigravity', label: 'Antigravity', brand: { color: '#4285f4', mark: 'A' },
    caps: { steer: false, interrupt: true, images: false, fork: false, rollback: 'turns', rewindFiles: false,
      subagents: true, backgroundTasks: false, contextUsage: false, slashCommands: false, segments: false, chrome: false,
      deskTools: false, mcpManagement: false, interactiveApprovals: false, modes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'] },
    async probe(force) {
      const info = await discover(force);
      const email = info.usage?.email || readGoogleEmail();
      return { available: true, loggedIn: true, version: info.version, account: { subscriptionType: 'Antigravity', ...(email ? { email } : {}) },
        models: [{ value: 'default', displayName: 'Default', description: 'Antigravity CLI default', supportedEffortLevels: [] }, ...info.models], commands: [], usage: info.usage };
    },
    async usage() {
      const bin = resolveBin();
      return parseUsage(JSON.parse(await cli(bin, ['-p', '/usage', '--output-format', 'json'], environment())));
    },
    async listSessions() { return sessions.list(); },
    async loadHistory(id) { return sessions.history(id); },
    async sessionFile(id) { return sessions.file(id); },
    async renameSession(id, title) { sessions.patch(id, { title }); },
    async rollback(id, dropTurns) {
      for (const run of runs) if (run.sessionId === id) run.close();
      sessions.rollback(id, dropTurns);
    },
    async deleteSession(id) {
      for (const run of runs) if (run.sessionId === id) run.close();
      sessions.remove(id);
    },
    open(spec, sink) {
      let meta = spec.resume ? sessions.read(spec.resume) : null;
      const cwd = spec.cwd || meta?.cwd || os.homedir();
      let config = { model: spec.model, effort: spec.effort, permissionMode: spec.permissionMode || 'default' };
      let child = null, childConfig = null, closed = false, busy = false, translator = null;
      let instructions = spec.instructions;
      let startedAt = 0;
      const emit = (event) => {
        if (closed) return;
        const ev = { ...event, timestamp: Date.now() };
        if (meta && ev.type !== 'session') sessions.append(meta.sessionId, ev);
        sink.event(ev);
      };
      function finish(error = null, stderr = '') {
        if (closed) return;
        closed = true;
        runs.delete(run);
        const old = child;
        child = null;
        if (old) {
          if (busy) killTree(old);
          else {
            old.stdin.end();
            const timer = setTimeout(() => killTree(old), 2000);
            timer.unref();
            old.once('close', () => clearTimeout(timer));
          }
        }
        busy = false;
        sink.closed({ error, stderr });
      }
      function fail(error, stderr = '') {
        log('run failed', String(error?.message || error));
        // closed is the core's terminal error path (including startup and storage failures).
        finish(String(error?.message || error), stderr);
      }
      async function launch(bin) {
        const key = JSON.stringify({ ...config, resumed: Boolean(meta?.nativeId) });
        if (child && childConfig === key) return child;
        if (child) {
          const old = child;
          child = null;
          await new Promise((resolve) => {
            old.once('close', resolve);
            old.stdin.end();
            const timer = setTimeout(() => killTree(old), 2000);
            timer.unref();
            old.once('close', () => clearTimeout(timer));
          });
        }
        if (closed) return null;
        // Recheck settings for each process. Never inherit API/ADC credentials.
        const proc = spawnProcess(bin, runArgs(config, spec, meta?.nativeId), {
          cwd, env: environment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        child = proc;
        childConfig = key;
        let stderr = '';
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });
        proc.on('error', (e) => { if (child === proc) fail(e, stderr); });
        proc.stdin.on('error', (e) => { if (child === proc) fail(e, stderr); });
        const lines = createInterface({ input: proc.stdout });
        lines.on('line', (line) => {
          if (child !== proc || closed || !line.trim()) return;
          try {
            const msg = JSON.parse(line);
            const nativeId = msg.conversation_id ?? msg.result?.conversation_id ?? msg.step_update?.conversation_id;
            if (nativeId && meta && meta.nativeId !== nativeId) {
              meta = sessions.patch(meta.sessionId, { nativeId });
              childConfig = JSON.stringify({ ...config, resumed: true });
            }
            if (!busy || !translator) return;
            const events = translator.push(msg);
            for (const ev of events) {
              if (ev.type === 'turn.end') {
                busy = false;
                ev.durationMs = Date.now() - startedAt;
                meta = sessions.patch(meta.sessionId, { lastModified: Date.now() });
                if (/permission|denied|soft.den/i.test(stderr)) emit({ type: 'notice', tone: 'warn', at: 'feed', text: stderr.trim() });
                stderr = '';
              }
              emit(ev);
            }
          } catch (e) { fail(new Error(`Antigravity stream: ${e.message}`), stderr); }
        });
        proc.once('close', (code) => {
          lines.close();
          if (child !== proc || closed) return;
          child = null;
          if (busy || code) fail(new Error(stderr.trim() || `Antigravity CLI exited before finishing (code ${code}).`), stderr);
          else finish();
        });
        return proc;
      }
      async function sendNow(msg) {
        const { bin } = await discover();
        if (closed) return;
        if (msg.images?.length) throw new Error('Antigravity CLI accepts text only; remove image attachments before sending.');
        if (meta) meta = sessions.read(meta.sessionId);
        else meta = sessions.create(cwd, msg.text);
        if (!meta.nativeId && meta.rewound) {
          const own = sessions.handoffPrompt(meta.sessionId);
          if (!instructions) instructions = own;
          else if (own && instructions.includes('You worked in this chat before.')) instructions = `${own}\n\n${instructions}`;
          meta = sessions.patch(meta.sessionId, { rewound: false });
        }
        emit({ type: 'session', sessionId: meta.sessionId, model: config.model });
        sessions.append(meta.sessionId, { type: 'user', uuid: msg.uuid ?? randomUUID(), text: msg.text, timestamp: Date.now() });
        translator = createTranslator(randomUUID());
        startedAt = Date.now();
        const proc = await launch(bin);
        if (!proc || closed) return;
        const content = instructions ? `${instructions}\n\n${msg.text}` : msg.text;
        proc.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');
        instructions = undefined;
      }
      const run = {
        get sessionId() { return meta?.sessionId; },
        ready: async () => { await discover(); },
        send(msg) {
          if (closed) throw new Error('Antigravity session is closed');
          if (busy) throw new Error('Antigravity is still running; queue follow-up messages.');
          busy = true;
          sendNow(msg).catch(fail);
        },
        async configure(patch) { config = { ...config, ...patch }; },
        async interrupt() { finish(); },
        close: () => finish(),
      };
      runs.add(run);
      return run;
    },
    async runHeadless({ prompt, timeoutMs = 30 * 60000, onEvent, ...spec }) {
      return new Promise((resolve, reject) => {
        let result = { text: '', sessionId: null, isError: false, durationMs: 0 };
        let completed = false;
        const run = provider.open(spec, {
          event(ev) {
            onEvent?.(ev);
            if (ev.type === 'session') result.sessionId = ev.sessionId;
            if (ev.type === 'turn.end') {
              completed = true;
              result = { ...result, text: ev.text ?? '', isError: Boolean(ev.isError), durationMs: ev.durationMs ?? 0 };
              clearTimeout(timer);
              resolve(result);
              run.close();
            }
          },
          closed({ error }) { clearTimeout(timer); if (!completed) reject(new Error(error || 'Antigravity task stopped')); },
        });
        const timer = setTimeout(() => { reject(new Error('Antigravity task timed out')); run.close(); }, timeoutMs);
        run.send({ text: String(prompt) });
      });
    },
    close() { for (const run of runs) run.close(); },
  };
  return provider;
}

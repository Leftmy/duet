import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { command, findGemini, parseModels, parseUsage, readGoogleEmail, spawnGemini, subscriptionEnvironment } from './cli.mjs';
import { createTranslator } from './translate.mjs';
import { createSessions } from './sessions.mjs';

export function runArgs(config, spec, nativeId) {
  const args = ['--output-format', 'stream-json', '--skip-trust'];
  if (nativeId) args.push('--resume', nativeId);
  if (config.model && config.model !== 'default') args.push('--model', config.model);
  if (config.permissionMode === 'bypassPermissions') args.push('--approval-mode', 'yolo');
  else if (config.permissionMode === 'plan') args.push('--approval-mode', 'plan');
  else if (config.permissionMode === 'auto' || config.permissionMode === 'acceptEdits') args.push('--approval-mode', 'auto_edit');
  else args.push('--approval-mode', 'default');
  for (const dir of spec.dirs ?? []) args.push('--include-directories', dir);
  args.push('-p', '');
  return args;
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill('SIGTERM');
}

export function createGeminiProvider({ dataDir, log = () => {}, resolveBin = findGemini, environment = subscriptionEnvironment, cli = command, spawnProcess = spawn } = {}) {
  const sessions = createSessions(path.join(dataDir, 'gemini'));
  const runs = new Set();
  let cached = null;
  let cachedAt = 0;
  async function discover(force = false) {
    if (!cached || force || Date.now() - cachedAt > 60000) {
      cachedAt = Date.now();
      cached = (async () => {
        const bin = resolveBin();
        const env = environment();
        const [version, help, modelsRaw, quotaRaw] = await Promise.all([
          cli(bin, ['--version'], env),
          cli(bin, ['--help'], env, 30000, true),
          cli(bin, ['models'], env).catch(() => ''),
          cli(bin, ['--quota'], env).catch(() => null),
        ]);
        if (!help.includes('--output-format') || !help.includes('--resume')) {
          throw new Error('Update Gemini CLI with npm install -g @google/gemini-cli: Duet requires the streaming JSON interface.');
        }
        let usage = null;
        let email = readGoogleEmail();
        if (quotaRaw) {
          try {
            const parsed = parseUsage(JSON.parse(quotaRaw));
            email = parsed.email || email;
            usage = parsed;
          } catch {}
        }
        return { bin, version, models: parseModels(modelsRaw), usage, email };
      })();
    }
    try { return await cached; } catch (e) { cached = null; throw e; }
  }
  const provider = {
    id: 'gemini', label: 'Gemini', brand: { color: '#8e75ff', mark: 'G' },
    caps: {
      steer: false, interrupt: true, images: false, fork: false, rollback: 'turns', rewindFiles: false,
      subagents: true, backgroundTasks: false, contextUsage: false, slashCommands: false, segments: false, chrome: false,
      deskTools: false, mcpManagement: false, interactiveApprovals: false,
      modes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
    },
    async probe(force) {
      const info = await discover(force);
      return {
        available: true,
        loggedIn: true,
        version: info.version,
        account: { subscriptionType: info.usage?.plan || 'Gemini', ...(info.email ? { email: info.email } : {}) },
        models: [{ value: 'default', displayName: 'Auto (Gemini)', description: 'Let Gemini CLI choose the best model for the task', supportedEffortLevels: [] }, ...info.models],
        commands: [],
        ...(info.usage ? { usage: info.usage } : {}),
      };
    },
    async usage() {
      const bin = resolveBin();
      const raw = await cli(bin, ['--quota'], environment());
      return parseUsage(JSON.parse(raw));
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
      let child = null, closed = false, busy = false, translator = null;
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
        if (old) killTree(old);
        busy = false;
        sink.closed({ error, stderr });
      }
      function fail(error, stderr = '') {
        log('run failed', String(error?.message || error));
        finish(String(error?.message || error), stderr);
      }
      async function sendNow(msg) {
        const { bin } = await discover();
        if (closed) return;
        if (msg.images?.length) throw new Error('Gemini CLI accepts text only; remove image attachments before sending.');
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
        const content = instructions ? `${instructions}\n\n${msg.text}` : msg.text;
        instructions = undefined;
        // Recheck subscription settings for each turn; never inherit API/Vertex/ADC credentials.
        const proc = spawnGemini(spawnProcess, bin, runArgs(config, spec, meta?.nativeId), {
          cwd, env: environment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        child = proc;
        let stderr = '';
        let turnCompleted = false;
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });
        proc.on('error', (e) => { if (child === proc) fail(e, stderr); });
        proc.stdin.on('error', (e) => { if (child === proc && !turnCompleted) fail(e, stderr); });
        const lines = createInterface({ input: proc.stdout });
        lines.on('line', (line) => {
          if (child !== proc || closed || !line.trim()) return;
          try {
            const msgObj = JSON.parse(line);
            const nativeId = msgObj.session_id ?? msgObj.conversation_id ?? msgObj.result?.session_id;
            if (nativeId && meta && meta.nativeId !== nativeId) meta = sessions.patch(meta.sessionId, { nativeId });
            if (!busy || !translator) return;
            const events = translator.push(msgObj);
            for (const ev of events) {
              if (ev.type === 'turn.end') {
                busy = false;
                turnCompleted = true;
                ev.durationMs = Date.now() - startedAt;
                meta = sessions.patch(meta.sessionId, { lastModified: Date.now() });
                if (/permission|denied|untrusted|approval/i.test(stderr)) emit({ type: 'notice', tone: 'warn', at: 'feed', text: stderr.trim() });
                stderr = '';
              }
              emit(ev);
            }
          } catch (e) { fail(new Error(`Gemini stream: ${e.message}`), stderr); }
        });
        proc.once('close', (code) => {
          lines.close();
          if (child !== proc || closed) return;
          child = null;
          if (!turnCompleted && (busy || code)) {
            const hint = /Manual authorization is required|Authentication/i.test(stderr)
              ? 'Gemini CLI is not signed in. Run "gemini" in a terminal and choose "Login with Google".'
              : stderr.trim() || `Gemini CLI exited before finishing (code ${code}).`;
            fail(new Error(hint), stderr);
          }
        });
        proc.stdin.end(content + '\n');
      }
      const run = {
        get sessionId() { return meta?.sessionId; },
        ready: async () => { await discover(); },
        send(msg) {
          if (closed) throw new Error('Gemini session is closed');
          if (busy) throw new Error('Gemini is still running; queue follow-up messages.');
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
          closed({ error }) { clearTimeout(timer); if (!completed) reject(new Error(error || 'Gemini task stopped')); },
        });
        const timer = setTimeout(() => { reject(new Error('Gemini task timed out')); run.close(); }, timeoutMs);
        run.send({ text: String(prompt) });
      });
    },
    close() { for (const run of runs) run.close(); },
  };
  return provider;
}

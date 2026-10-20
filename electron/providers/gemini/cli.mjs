import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { which } from '../../platform.mjs';

export const DEFAULT_MODELS = [
  { value: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro (Preview)', description: 'Latest Gemini 3.1 Pro preview model', supportedEffortLevels: [] },
  { value: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro (Preview)', description: 'Gemini 3 Pro preview model', supportedEffortLevels: [] },
  { value: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash (Preview)', description: 'Fast Gemini 3 Flash preview model', supportedEffortLevels: [] },
  { value: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', description: 'Stable reasoning and coding model', supportedEffortLevels: [] },
  { value: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', description: 'Fast everyday coding model', supportedEffortLevels: [] },
  { value: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', description: 'Lightweight fast model', supportedEffortLevels: [] },
];

function npmGlobalRoot() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const p = path.join(process.env.APPDATA, 'npm', 'node_modules');
    if (fs.existsSync(p)) return p;
  }
  try {
    return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

export function findGemini() {
  const override = process.env.DUET_GEMINI_BIN;
  if (override && fs.existsSync(override) && fs.statSync(override).isFile()) return override;
  const roots = [];
  try {
    roots.push(path.dirname(createRequire(import.meta.url).resolve('@google/gemini-cli/package.json')));
  } catch {}
  const globalRoot = npmGlobalRoot();
  if (globalRoot) roots.push(path.join(globalRoot, '@google', 'gemini-cli'));
  for (const root of roots) {
    const entry = path.join(root, 'bundle', 'gemini.js');
    if (fs.existsSync(entry)) return entry;
  }
  const onPath = which('gemini');
  if (onPath) {
    if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(onPath)) {
      const sibling = path.join(path.dirname(onPath), 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
      if (fs.existsSync(sibling)) return sibling;
    }
    if (fs.existsSync(onPath) && fs.statSync(onPath).isFile()) return onPath;
  }
  throw new Error('Gemini CLI not found. Install it with: npm install -g @google/gemini-cli and sign in with your Google account.');
}

/** Never route this provider through a Gemini API key, Vertex AI or Google Cloud ADC billing. */
export function subscriptionEnvironment(env = process.env, home = os.homedir()) {
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`Cannot verify Gemini CLI subscription settings: ${e.message}`); }
  };
  const settings = read(path.join(home, '.gemini', 'settings.json'));
  const selected = settings.security?.auth?.selectedType ?? settings.selectedAuthType;
  const enforced = settings.security?.auth?.enforcedType;
  if ((selected && selected !== 'oauth-personal') || (enforced && enforced !== 'oauth-personal')) {
    throw new Error('Duet uses Gemini subscriptions (Login with Google) only. Set security.auth.selectedType to "oauth-personal" in ~/.gemini/settings.json and sign in with gemini. API-key and Vertex AI providers are not supported here.');
  }
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_PROJECT_ID|GOOGLE_CLOUD_LOCATION|GOOGLE_GEMINI_BASE_URL|GEMINI_CLI_USE_COMPUTE_ADC|CLOUD_SHELL)$/i.test(key)) {
      delete result[key];
    }
  }
  result.GOOGLE_GENAI_USE_GCA = 'true';
  result.NO_BROWSER = 'true';
  return result;
}

function resolveCommand(bin, args, env) {
  if (/\.(?:c|m)?js$/i.test(bin)) {
    const node = which('node') || process.execPath;
    const nextEnv = node === process.execPath && process.versions?.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
    return { file: node, args: [bin, ...args], env: nextEnv };
  }
  return { file: bin, args, env };
}

export function spawnGemini(spawnProcess, bin, args, opts = {}) {
  if (spawnProcess !== spawn) return spawnProcess(bin, args, opts);
  const resolved = resolveCommand(bin, args, opts.env);
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.file);
  return spawn(resolved.file, resolved.args, { ...opts, env: resolved.env, ...(isCmd ? { shell: true } : {}) });
}

export function readGoogleEmail(home = os.homedir()) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'google_accounts.json'), 'utf8'));
    return typeof data?.active === 'string' && data.active ? data.active : undefined;
  } catch {
    return undefined;
  }
}

const QUOTA_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
console.log = () => {};
const bundleDir = process.argv[1];
const coreFile = fs.readdirSync(bundleDir).find((f) => /^core-.*\\.js$/.test(f));
if (!coreFile) throw new Error('Gemini CLI core bundle not found');
const core = await import(pathToFileURL(path.join(bundleDir, coreFile)).href);
const cfg = {
  isBrowserLaunchSuppressed: () => true,
  isInteractive: () => false,
  getAcpMode: () => false,
  getProxy: () => undefined,
  getValidationHandler: () => undefined,
  getUsageStatisticsEnabled: () => false,
};
const client = await core.getOauthClient('oauth-personal', cfg);
const email = new core.UserAccountManager().getCachedGoogleAccount() ?? undefined;
const user = await core.setupUser(client, cfg);
const server = new core.CodeAssistServer(client, user.projectId, {}, '', user.userTier, user.userTierName, user.paidTier);
const quota = user.projectId ? await server.retrieveUserQuota({ project: user.projectId }) : { buckets: [] };
process.stdout.write(JSON.stringify({ status: 'SUCCESS', plan: user.userTierName || 'Gemini', email, buckets: quota.buckets ?? [] }));
`;

function fallbackAntigravityQuota(env, timeout) {
  const candidates = [
    process.env.DUET_ANTIGRAVITY_BIN,
    which('agy'),
    path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
    path.join(os.homedir(), '.local', 'bin', 'agy'),
  ];
  const agy = candidates.find((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
  if (!agy) return Promise.reject(new Error('Gemini subscription quota is unavailable.'));
  return new Promise((resolve, reject) =>
    execFile(agy, ['-p', '/usage', '--output-format', 'json'], { env, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || stdout || err.message).trim()));
      try {
        const data = JSON.parse(stdout.trim());
        const groups = (data?.command?.data?.groups ?? []).filter((g) => /gemini/i.test(g?.name || ''));
        resolve(
          JSON.stringify({
            status: data.status ?? 'SUCCESS',
            plan: 'Gemini',
            email: readGoogleEmail(),
            command: { data: { groups: groups.length ? groups : data?.command?.data?.groups ?? [] } },
          }),
        );
      } catch (e) {
        reject(e);
      }
    }),
  );
}

export function command(bin, args, env, timeout = 30000, includeStderr = false) {
  if (args[0] === 'models') return Promise.resolve('');
  if (args[0] === '--quota' && /\.(?:c|m)?js$/i.test(bin)) {
    const bundleDir = path.dirname(bin);
    const resolved = resolveCommand(bin, ['--input-type=module', '-e', QUOTA_SCRIPT, bundleDir], env);
    return new Promise((resolve, reject) => execFile(resolved.file, resolved.args.slice(1), {
      env: resolved.env, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || stdout || error.message).trim())) : resolve(stdout.trim())))
      .catch(() => fallbackAntigravityQuota(env, timeout));
  }
  const resolved = resolveCommand(bin, args, env);
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.file);
  return new Promise((resolve, reject) => execFile(resolved.file, resolved.args, {
    env: resolved.env, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, ...(isCmd ? { shell: true } : {}),
  }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || stdout || error.message).trim())) : resolve((includeStderr ? stdout + '\n' + stderr : stdout).trim())));
}

export function parseModels(text) {
  if (!text || !text.trim()) return DEFAULT_MODELS;
  const parsed = text.split(/\r?\n/).flatMap((line) => {
    const [value, displayName] = line.split('\t');
    return value && displayName ? [{ value: value.trim(), displayName: displayName.trim(), description: '', supportedEffortLevels: [] }] : [];
  });
  return parsed.length ? parsed : DEFAULT_MODELS;
}

/** Aggregate per-model quota buckets into Duet's { plan, session, weekly, groups } shape. */
export function parseUsage(envelope) {
  if (!envelope || (envelope.status && envelope.status !== 'SUCCESS')) {
    throw new Error(envelope?.error || 'Gemini subscription quota is unavailable. Run gemini and sign in with your Google account.');
  }
  const rawGroups = envelope.command?.data?.groups;
  const buckets = Array.isArray(envelope.buckets)
    ? envelope.buckets
    : Array.isArray(rawGroups)
      ? rawGroups.flatMap((g) => (g.buckets ?? []).map((b) => ({ ...b, groupName: g.name, groupDescription: g.description })))
      : null;
  if (!Array.isArray(buckets) || !buckets.length) {
    throw new Error('Gemini CLI did not report subscription quotas. Sign in with a personal Google account in gemini.');
  }
  const email = envelope.email || readGoogleEmail();
  const byGroup = new Map();
  for (const bucket of buckets) {
    const frac = bucket.remainingFraction ?? bucket.remaining_fraction;
    if (typeof frac !== 'number') continue;
    const key = bucket.window === 'weekly' ? 'weekly' : 'session';
    const reset = bucket.resetTime ?? bucket.reset_time;
    const pct = Math.max(0, Math.min(100, (1 - frac) * 100));
    const name = bucket.modelId || bucket.groupName || bucket.name || 'Gemini';
    const win = { pct, resetsAt: reset ? Date.parse(reset) || null : null, label: name };
    const g = byGroup.get(name) ?? { name, ...(bucket.groupDescription ? { description: bucket.groupDescription } : {}) };
    if (!g[key] || pct > g[key].pct) g[key] = win;
    byGroup.set(name, g);
  }
  const groups = [...byGroup.values()].filter((g) => g.session || g.weekly);
  const primary =
    groups.filter((g) => g.session).sort((a, b) => (b.session?.pct ?? 0) - (a.session?.pct ?? 0))[0] ??
    groups.sort((a, b) => (b.weekly?.pct ?? 0) - (a.weekly?.pct ?? 0))[0];
  const fallbackWeekly =
    groups.filter((g) => g.session && g.weekly).sort((a, b) => (b.weekly?.pct ?? 0) - (a.weekly?.pct ?? 0))[0]?.weekly ??
    groups.filter((g) => g.weekly).sort((a, b) => (b.weekly?.pct ?? 0) - (a.weekly?.pct ?? 0))[0]?.weekly;
  return {
    plan: envelope.plan || 'Gemini',
    ...(email ? { email } : {}),
    ...(primary?.session ? { session: primary.session } : {}),
    ...((primary?.weekly ?? fallbackWeekly) ? { weekly: primary?.weekly ?? fallbackWeekly } : {}),
    ...(groups.length ? { groups } : {}),
  };
}

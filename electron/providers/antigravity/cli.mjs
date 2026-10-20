import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { which } from '../../platform.mjs';

export function findAntigravity() {
  const override = process.env.DUET_ANTIGRAVITY_BIN;
  const candidates = override ? [override] : [
    which('agy'),
    path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
    path.join(os.homedir(), '.local', 'bin', 'agy'),
  ];
  const bin = candidates.find((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
  if (!bin) throw new Error('Antigravity CLI not found. Install agy from https://antigravity.google/download and sign in with your Google account.');
  return bin;
}

/** Never route this provider through a Gemini API key or Google Cloud billing. */
export function subscriptionEnvironment(env = process.env, home = os.homedir()) {
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`Cannot verify Antigravity subscription settings: ${e.message}`); }
  };
  const settings = read(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'));
  const config = read(path.join(home, '.gemini', 'config', 'config.json'));
  if (settings.modelProvider && settings.modelProvider !== 'antigravity') {
    throw new Error('Duet uses Antigravity subscriptions only. Remove modelProvider from ~/.gemini/antigravity-cli/settings.json and sign in with agy. API-key providers are not supported here.');
  }
  if (config.userSettings?.enableAdc) throw new Error('Antigravity is configured for Google Cloud ADC. Sign in with your personal Google account to use your subscription in Duet.');
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GEMINI_BASE_URL|AGY_ADC_AUTH)$/i.test(key)) delete result[key];
  }
  return result;
}

export function command(bin, args, env, timeout = 30000, includeStderr = false) {
  return new Promise((resolve, reject) => execFile(bin, args, {
    env, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || stdout || error.message).trim())) : resolve((includeStderr ? stdout + '\n' + stderr : stdout).trim())));
}

export function parseModels(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const [value, displayName] = line.split('\t');
    return value && displayName ? [{ value, displayName: displayName.trim(), description: '', supportedEffortLevels: [] }] : [];
  });
}

export function readGoogleEmail(home = os.homedir()) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'google_accounts.json'), 'utf8'));
    return typeof data?.active === 'string' && data.active ? data.active : undefined;
  } catch {
    return undefined;
  }
}

/** Different model families have separate quotas; pair 5h + weekly from the most active 5h group and keep all groups for hover breakdown. */
export function parseUsage(envelope) {
  if (envelope.status !== 'SUCCESS') throw new Error(envelope.error || 'Antigravity subscription quota is unavailable. Run agy and sign in.');
  const rawGroups = envelope.command?.data?.groups;
  if (!Array.isArray(rawGroups) || !rawGroups.length) throw new Error('Antigravity did not report subscription quotas. Sign in with a personal Google account in agy.');
  const groups = [];
  for (const group of rawGroups) {
    const item = { name: group.name || 'Models', ...(group.description ? { description: group.description } : {}) };
    for (const bucket of group.buckets ?? []) {
      const key = bucket.window === '5h' ? 'session' : bucket.window === 'weekly' ? 'weekly' : null;
      if (!key || typeof bucket.remaining_fraction !== 'number') continue;
      const pct = Math.max(0, Math.min(100, (1 - bucket.remaining_fraction) * 100));
      const win = { pct, resetsAt: Date.parse(bucket.reset_time) || null, ...(group.name ? { label: group.name } : {}) };
      if (!item[key] || pct > item[key].pct) item[key] = win;
    }
    if (item.session || item.weekly) groups.push(item);
  }
  const primary =
    groups.filter((g) => g.session).sort((a, b) => (b.session?.pct ?? 0) - (a.session?.pct ?? 0))[0] ??
    groups.sort((a, b) => (b.weekly?.pct ?? 0) - (a.weekly?.pct ?? 0))[0];
  const fallbackWeekly = groups.filter((g) => g.session && g.weekly).sort((a, b) => (b.weekly?.pct ?? 0) - (a.weekly?.pct ?? 0))[0]?.weekly
    ?? groups.filter((g) => g.weekly).sort((a, b) => (b.weekly?.pct ?? 0) - (a.weekly?.pct ?? 0))[0]?.weekly;
  const email = envelope.email || readGoogleEmail();
  return {
    plan: 'Antigravity',
    ...(email ? { email } : {}),
    ...(primary?.session ? { session: primary.session } : {}),
    ...((primary?.weekly ?? fallbackWeekly) ? { weekly: primary?.weekly ?? fallbackWeekly } : {}),
    ...(groups.length ? { groups } : {}),
  };
}

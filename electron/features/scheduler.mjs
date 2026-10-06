// Scheduled background tasks: runs Claude Code prompts on an interval or daily schedule,
// keeps a short run history and notifies via Windows notifications and/or Telegram.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { t } from '../i18n.mjs';

const TICK_MS = 30000;
const MAX_CONCURRENT = 2;
const HISTORY_LIMIT = 20;
const TEXT_LIMIT = 4000;
const TG_LIMIT = 3800;
const MIN_INTERVAL = 5;
const PERM_MODES = ['acceptEdits', 'default', 'bypassPermissions'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
};

// ---------- shared Telegram bot settings (also used by telegram.mjs for remote control) ----------
let tgSettings = null; // live reference to state.settings once register() ran
const tgListeners = new Set();

/** Current bot token + chat id, or null before the scheduler has loaded its settings. */
export const telegramConfig = () => (tgSettings ? { token: tgSettings.telegramToken, chatId: tgSettings.telegramChatId } : null);

/** Subscribes to token / chat id changes; returns an unsubscribe function. */
export function onTelegramConfig(cb) {
  tgListeners.add(cb);
  return () => tgListeners.delete(cb);
}

// Optional inline keyboard under a run's Telegram notification (the remote-control bot provides it
// while it is listening, e.g. a "Continue here" button that selects the run's chat in the bot).
let tgNotifyMarkup = null;

/** Registers fn(sessionId) → reply_markup | null; returns an unregister function. */
export function setTelegramNotifyMarkup(fn) {
  tgNotifyMarkup = fn;
  return () => {
    if (tgNotifyMarkup === fn) tgNotifyMarkup = null;
  };
}

// The Telegram bot can mute scheduled-task results (bot Settings -> Notifications).
let tgNotifyGate = () => true;
/** Registers a predicate that decides whether task results may be sent to Telegram. */
export function setTelegramNotifyGate(fn) {
  tgNotifyGate = typeof fn === 'function' ? fn : () => true;
}

function tgConfigChanged() {
  const cfg = telegramConfig();
  for (const cb of tgListeners) {
    try {
      cb(cfg);
    } catch (e) {
      console.error('[scheduler] telegram listener failed', e);
    }
  }
}

/** Next run time (ms, local time) after `now`, or null for a disabled task. */
export function computeNextRun(task, now = Date.now(), { afterRun = false } = {}) {
  if (!task.enabled) return null;
  const s = task.schedule;
  if (s.type === 'interval') {
    const step = s.minutes * 60000;
    if (afterRun || !task.lastRun) return now + step;
    const t = task.lastRun + step;
    return t > now ? t : now + step;
  }
  const [hh, mm] = s.time.split(':').map(Number);
  const base = new Date(now);
  for (let i = 0; i <= 7; i++) {
    const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, hh, mm, 0, 0);
    if (c.getTime() > now && (!s.days.length || s.days.includes(c.getDay()))) return c.getTime();
  }
  return null;
}

function normalizeSchedule(s) {
  if (!s || typeof s !== 'object') throw new Error(t('scheduler.noSchedule'));
  if (s.type === 'interval') {
    const minutes = Math.round(Number(s.minutes));
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL) throw new Error(t('scheduler.intervalMin', { n: MIN_INTERVAL }));
    if (minutes > 60 * 24 * 31) throw new Error(t('scheduler.intervalMax'));
    return { type: 'interval', minutes };
  }
  if (s.type === 'daily') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.time ?? ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(t('scheduler.badTime'));
    const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    return { type: 'daily', time: `${m[1].padStart(2, '0')}:${m[2]}`, days: days.length === 7 ? [] : days };
  }
  throw new Error(t('scheduler.badType'));
}

export function register(ctx) {
  const file = path.join(ctx.userData, 'schedules.json');
  const active = new Set(); // ids currently running
  const pending = new Set(); // ids queued by "run now"
  const liveNotes = new Set(); // keep notifications referenced so click handlers survive GC
  let state = { settings: { telegramToken: '', telegramChatId: '' }, tasks: [] };

  // ---------- persistence ----------
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = {
      settings: { telegramToken: String(raw?.settings?.telegramToken ?? ''), telegramChatId: String(raw?.settings?.telegramChatId ?? '') },
      tasks: Array.isArray(raw?.tasks) ? raw.tasks : [],
    };
  } catch {}
  const now0 = Date.now();
  for (const t of state.tasks) {
    t.running = false; // an interrupted run from a previous launch
    t.history = Array.isArray(t.history) ? t.history.slice(0, HISTORY_LIMIT) : [];
    // A past nextRun means the time came while the app was closed: it stays due and runs once (catch-up).
    if (!t.enabled) t.nextRun = null;
    else if (!t.nextRun) t.nextRun = computeNextRun(t, now0);
  }
  tgSettings = state.settings;
  tgConfigChanged();

  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      console.error('[scheduler] save failed', e);
    }
  };

  const view = () => ({
    tasks: state.tasks.map((t) => ({ ...t, queued: pending.has(t.id) && !t.running })),
    settings: { telegramChatId: state.settings.telegramChatId, hasToken: Boolean(state.settings.telegramToken) },
  });
  const changed = () => {
    save();
    ctx.emit('sched:update', view());
    return view();
  };
  const find = (id) => {
    const task = state.tasks.find((x) => x.id === id);
    if (!task) throw new Error(t('scheduler.notFound'));
    return task;
  };

  // ---------- notifications ----------
  let electronMod;
  const electron = async () => (electronMod ??= await import('electron').catch(() => ({})));

  async function notifyDesktop(title, body) {
    const { Notification } = await electron();
    if (!Notification?.isSupported?.()) return;
    const n = new Notification({ title, body });
    liveNotes.add(n);
    const drop = () => liveNotes.delete(n);
    n.on('click', () => {
      const w = ctx.getWindow?.();
      if (w && !w.isDestroyed?.()) {
        if (w.isMinimized?.()) w.restore();
        w.show();
        w.focus?.();
      }
      drop();
    });
    n.on('close', drop);
    setTimeout(drop, 10 * 60000).unref?.();
    n.show();
  }

  async function sendTelegram(text, replyMarkup = null) {
    const { telegramToken: token, telegramChatId: chatId } = state.settings;
    if (!token) throw new Error(t('scheduler.noToken'));
    if (!chatId) throw new Error(t('scheduler.noChatId'));
    let res;
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: clip(text, TG_LIMIT), disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new Error(t('scheduler.network', { error: e?.message ?? e }));
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok !== false) return true;
    const desc = String(data.description ?? res.statusText ?? '');
    if (res.status === 401 || res.status === 404) throw new Error(t('scheduler.badToken'));
    if (/chat not found/i.test(desc)) throw new Error(t('scheduler.chatNotFound'));
    if (res.status === 403) throw new Error(t('scheduler.forbidden'));
    throw new Error(t('scheduler.apiError', { error: desc || res.status }));
  }

  async function notify(task, rec) {
    const body = rec.text.replace(/\s+/g, ' ').trim();
    if (task.notify?.desktop) {
      notifyDesktop(task.name, clip((rec.ok ? '' : t('scheduler.errorPrefix')) + (body || (rec.ok ? t('scheduler.done') : t('scheduler.noDetails'))), 200)).catch((e) =>
        console.error('[scheduler] notification failed', e),
      );
    }
    if (task.notify?.telegram && state.settings.telegramToken && state.settings.telegramChatId && tgNotifyGate()) {
      const head = `${rec.ok ? '✅' : '❌'} ${task.name}`;
      let markup = null;
      try {
        markup = rec.sessionId ? (tgNotifyMarkup?.(rec.sessionId) ?? null) : null;
      } catch {}
      sendTelegram(`${head}\n\n${rec.text || (rec.ok ? t('scheduler.done') : t('scheduler.error'))}`, markup).catch((e) =>
        console.error('[scheduler] telegram failed', e?.message ?? e),
      );
    }
  }

  // ---------- running ----------
  async function run(task) {
    const id = task.id;
    active.add(id);
    pending.delete(id);
    task.running = true;
    changed();
    const started = Date.now();
    let rec;
    try {
      if (task.cwd && !fs.existsSync(task.cwd)) throw new Error(t('scheduler.folderNotFound', { path: task.cwd }));
      const r = await ctx.bridge.runHeadless({
        prompt: task.prompt,
        cwd: task.cwd || os.homedir(),
        model: task.model && task.model !== 'default' ? task.model : undefined,
        effort: task.effort || undefined,
        permissionMode: task.permissionMode || 'acceptEdits',
      });
      rec = { ts: started, ok: !r.isError, durationMs: r.durationMs || Date.now() - started, text: clip(r.text, TEXT_LIMIT), sessionId: r.sessionId ?? null };
      if (r.costUsd) rec.costUsd = r.costUsd;
    } catch (e) {
      rec = { ts: started, ok: false, durationMs: Date.now() - started, text: clip(t('scheduler.errorPrefix') + (e?.message ?? e), TEXT_LIMIT), sessionId: null };
    }
    active.delete(id);
    // The task may have been edited or deleted while it ran.
    const cur = state.tasks.find((x) => x.id === id);
    if (cur) {
      cur.running = false;
      cur.lastRun = started;
      cur.history = [rec, ...(cur.history ?? [])].slice(0, HISTORY_LIMIT);
      cur.nextRun = computeNextRun(cur, Date.now(), { afterRun: true });
      changed();
      notify(cur, rec);
    }
    tick();
    return rec;
  }

  function tick() {
    const now = Date.now();
    const due = state.tasks
      .filter((t) => !t.running && !active.has(t.id) && (pending.has(t.id) || (t.enabled && t.nextRun && t.nextRun <= now)))
      .sort((a, b) => (pending.has(b.id) ? 1 : 0) - (pending.has(a.id) ? 1 : 0) || (a.nextRun ?? 0) - (b.nextRun ?? 0));
    const started = [];
    for (const t of due) {
      if (active.size >= MAX_CONCURRENT) break;
      started.push(run(t));
    }
    return started;
  }

  // ---------- IPC ----------
  ctx.handle('sched:list', () => view());

  ctx.handle('sched:save', (input) => {
    if (!input || typeof input !== 'object') throw new Error(t('scheduler.emptyTask'));
    const name = String(input.name ?? '').trim();
    const prompt = String(input.prompt ?? '').trim();
    if (!name) throw new Error(t('scheduler.nameRequired'));
    if (!prompt) throw new Error(t('scheduler.promptRequired'));
    let cwd = String(input.cwd ?? '').trim();
    if (cwd) {
      let ok = false;
      try {
        ok = fs.statSync(cwd).isDirectory();
      } catch {}
      if (!ok) throw new Error(t('scheduler.folderMissing'));
    } else cwd = os.homedir();
    const permissionMode = PERM_MODES.includes(input.permissionMode) ? input.permissionMode : 'acceptEdits';
    const effort = EFFORTS.includes(input.effort) ? input.effort : null;
    const schedule = normalizeSchedule(input.schedule);
    const prev = input.id ? state.tasks.find((t) => t.id === input.id) : null;
    const task = {
      id: prev?.id ?? crypto.randomUUID(),
      name: clip(name, 120),
      prompt,
      cwd,
      model: String(input.model || 'default'),
      effort,
      permissionMode,
      schedule,
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : prev ? prev.enabled : true,
      notify: { desktop: Boolean(input.notify?.desktop ?? true), telegram: Boolean(input.notify?.telegram) },
      running: prev?.running ?? false,
      lastRun: prev?.lastRun ?? null,
      nextRun: null,
      history: prev?.history ?? [],
      createdAt: prev?.createdAt ?? Date.now(),
    };
    task.nextRun = computeNextRun(task, Date.now());
    if (prev) state.tasks[state.tasks.indexOf(prev)] = task;
    else state.tasks.push(task);
    changed();
    return task;
  });

  ctx.handle('sched:delete', (id) => {
    const i = state.tasks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    state.tasks.splice(i, 1);
    pending.delete(id);
    changed();
    return true;
  });

  ctx.handle('sched:toggle', (id, enabled) => {
    const t = find(id);
    t.enabled = Boolean(enabled);
    // Re-enabling starts the schedule fresh from now instead of firing a stale run.
    t.nextRun = computeNextRun(t, Date.now(), { afterRun: true });
    changed();
    return true;
  });

  ctx.handle('sched:runNow', (id) => {
    const task = find(id);
    if (task.running || active.has(id)) throw new Error(t('scheduler.alreadyRunning'));
    pending.add(id);
    const started = tick();
    if (!started.length || !active.has(id)) ctx.emit('sched:update', view()); // queued behind other runs
    return { started: active.has(id), queued: !active.has(id) };
  });

  ctx.handle('sched:setTelegram', (p = {}) => {
    const before = `${state.settings.telegramToken}\n${state.settings.telegramChatId}`;
    if (p.token !== undefined && p.token !== null) {
      const token = String(p.token).trim();
      if (token && !/^\d+:[\w-]{20,}$/.test(token)) throw new Error(t('scheduler.tokenFormat'));
      state.settings.telegramToken = token;
    }
    if (p.chatId !== undefined && p.chatId !== null) {
      const chatId = String(p.chatId).trim();
      if (chatId && !/^(-?\d+|@\w{4,})$/.test(chatId)) throw new Error(t('scheduler.chatIdFormat'));
      state.settings.telegramChatId = chatId;
    }
    const res = changed().settings;
    if (`${state.settings.telegramToken}\n${state.settings.telegramChatId}` !== before) tgConfigChanged();
    return res;
  });

  ctx.handle('sched:telegramTest', () => sendTelegram(t('scheduler.testMessage')));

  // ---------- loop ----------
  let timer = null;
  const start = () => {
    if (timer) return;
    setTimeout(tick, 5000).unref?.(); // catch-up shortly after launch
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
  };
  const ready = ctx.app?.whenReady?.();
  if (ready) ready.then(start);
  else start();

  return {
    tick,
    stop: () => {
      clearInterval(timer);
      timer = null;
    },
    state: () => state,
  };
}

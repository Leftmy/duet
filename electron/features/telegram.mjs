// Remote control of Duet from Telegram: a long-polling bot with a button-driven UI (a persistent reply
// keyboard as the main menu, inline menus edited in place) that obeys only the configured private chat (the
// user's own account) and runs Claude Code tasks in the user's projects as regular app chats (visible and live in
// the main window). Permission requests are answered with buttons here or in the app, whichever comes first;
// photos and files are saved into the project for Claude to read.
// The bot token and chat id are shared with the scheduler (schedules.json → settings).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as sched from './scheduler.mjs';
import * as i18n from '../i18n.mjs';

const { t, locale, onLanguage } = i18n;

const API = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 50;
const MSG_LIMIT = 3900; // Telegram allows 4096; leave room
const LONG_ANSWER = 12000; // longer answers: the first part as a message + the full text as a .md file
const TYPING_MS = 4500;
const PROGRESS_MS = 3000; // live progress edits: at most this often...
const PROGRESS_IDLE_MS = 15000; // ...and only this often when just the timer changed
const PERM_TIMEOUT_MS = 10 * 60000;
const STALE_S = 120; // messages sent this long before the bot came online are dropped, not executed
const BACKOFF_MIN = 2000;
const BACKOFF_MAX = 60000;
const PAGE = 8;
const FOLDERS_LIMIT = 8;
const CHATS_MAX = 80;
const UPLOAD_MAX = 20 * 1024 * 1024;
const UPLOAD_DIR = '.claude-desk-uploads';
const REFS_MAX = 800;
const RUNS_MAX = 20;
const LOG_MAX = 40;
const SESSION_RE = /^[\w-]{8,48}$/;

const MODES = {
  ask: { perm: 'default', ask: true, icon: '🛡', labelKey: 'telegram.modeAsk', hintKey: 'telegram.modeAskHint' },
  edits: { perm: 'acceptEdits', ask: true, icon: '✏️', labelKey: 'telegram.modeEdits', hintKey: 'telegram.modeEditsHint' },
  full: { perm: 'bypassPermissions', ask: false, icon: '⚡', labelKey: 'telegram.modeFull', hintKey: 'telegram.modeFullHint' },
};
const MODELS = { default: '', sonnet: 'sonnet', opus: 'opus', haiku: 'haiku' };
const modeLabel = (key) => t(MODES[key].labelKey);
const modeHint = (key) => t(MODES[key].hintKey);
const modelLabel = (key) => t(`telegram.model_${key}`);

const COMMANDS = ['start', 'menu', 'projects', 'chats', 'new', 'status', 'stop', 'settings', 'help'];
const botCommands = () => COMMANDS.map((command) => ({ command, description: t(`telegram.cmd_${command}`) }));

// Reply-keyboard buttons; a press arrives as plain text, recognized by its label (any language) or leading emoji.
const MENU = [
  ['projects', '📁'],
  ['chats', '💬'],
  ['new', '➕'],
  ['settings', '⚙'],
  ['status', '📊'],
];

// Sent to Claude as the reason of a denial (not shown to the user).
const DENY_MESSAGE = 'The user denied this action from Telegram.';
const DENY_TIMEOUT = 'No answer from the user within 10 minutes, so the action was denied.';
const DENY_QUESTION = 'The user is on Telegram and cannot answer interactive questions. Continue with your best judgment and state your assumptions.';

// ---------- small helpers ----------

const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
};
const clipLeft = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? '…' + str.slice(str.length - n + 1) : str;
};
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const normDir = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase();
const sameDir = (a, b) => Boolean(a && b) && normDir(a) === normDir(b);
const baseName = (p) => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p ?? '');
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms).unref?.())]);

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const esc = escapeHtml;
const code = (s) => `<code>${esc(s)}</code>`;
/** Telegram HTML → readable plain text (fallback when Telegram rejects the markup). */
const htmlToPlain = (html) =>
  String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

/** "1m 12s", "45s", "2h 5m" (localized units). */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return t('telegram.durHM', { h, m });
  if (m) return t('telegram.durMS', { m, s: s % 60 });
  return t('telegram.durS', { s });
}

function ago(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (!ts || diff < 0) return '';
  const m = Math.round(diff / 60000);
  if (m < 1) return t('telegram.justNow');
  if (m < 60) return t('telegram.minAgo', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('telegram.hoursAgo', { n: h });
  const d = Math.round(h / 24);
  if (d < 14) return t('telegram.daysAgo', { n: d });
  return new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

/** Path for display: relative to the working folder when inside it, else the tail of the absolute path. */
function relPath(p, cwd) {
  const s = String(p ?? '');
  if (!s) return '';
  if (cwd) {
    const rel = path.relative(cwd, s);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return clipLeft(rel.replace(/\\/g, '/'), 60);
  }
  return clipLeft(s.replace(/\\/g, '/'), 60);
}

const hostOf = (url) => {
  try {
    return new URL(url).host || String(url);
  } catch {
    return String(url ?? '');
  }
};

// ---------- markdown → Telegram HTML chunks ----------

/** One line of markdown prose → Telegram HTML (inline `code`, **bold**, [links](url), # headings, bullets). */
function inlineHtml(line) {
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
  if (heading) return `<b>${escapeHtml(heading[1].replace(/\*\*|`/g, ''))}</b>`;
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  const body = bullet ? bullet[2] : line;
  const html = body
    .split(/(`[^`\n]+`)/)
    .map((part, i) =>
      i % 2
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : escapeHtml(part)
            .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
            .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"<>]+)\)/g, '<a href="$2">$1</a>'),
    )
    .join('');
  return bullet ? `${bullet[1]}• ${html}` : html;
}

function parseBlocks(md) {
  const blocks = [];
  let cur = null;
  for (const line of String(md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (cur?.type === 'code') {
      if (/^\s*```\s*$/.test(line)) {
        blocks.push(cur);
        cur = null;
      } else cur.lines.push(line);
      continue;
    }
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      if (cur) blocks.push(cur);
      cur = { type: 'code', lang: fence[1], lines: [] };
      continue;
    }
    if (!line.trim()) {
      // a blank line ends a paragraph
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { type: 'text', lines: [] };
    cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** Splits a string into slices that each satisfy `fits`. */
function hardSplit(s, fits) {
  const out = [];
  let rest = s;
  while (rest.length) {
    let n = rest.length;
    while (n > 1 && !fits(rest.slice(0, n))) n = Math.floor(n * 0.8);
    out.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return out;
}

/**
 * Converts a markdown answer into Telegram messages of at most `limit` characters each, splitting on
 * paragraph and code-block boundaries first. Every chunk has balanced HTML (`html`) plus the raw source
 * (`plain`) to resend if Telegram rejects the markup.
 */
export function toTelegramChunks(md, limit = MSG_LIMIT, footer = '') {
  const units = []; // { html, plain, glue }: glue is the separator before the unit inside one message
  for (const b of parseBlocks(md)) {
    if (b.type === 'text') {
      const html = b.lines.map(inlineHtml).join('\n');
      if (html.length <= limit) {
        units.push({ html, plain: b.lines.join('\n'), glue: '\n\n' });
        continue;
      }
      let first = true;
      for (const line of b.lines) {
        for (const part of hardSplit(line, (x) => inlineHtml(x).length <= limit)) {
          units.push({ html: inlineHtml(part), plain: part, glue: first ? '\n\n' : '\n' });
          first = false;
        }
      }
      continue;
    }
    const open = b.lang ? `<pre><code class="language-${escapeHtml(b.lang)}">` : '<pre>';
    const close = b.lang ? '</code></pre>' : '</pre>';
    const room = limit - open.length - close.length;
    const lines = b.lines.flatMap((l) => (l.length ? hardSplit(l, (x) => escapeHtml(x).length <= room) : ['']));
    let group = [];
    let size = 0;
    const flush = () => {
      if (group.join('').trim()) {
        const body = group.join('\n');
        units.push({ html: open + escapeHtml(body) + close, plain: '```' + b.lang + '\n' + body + '\n```', glue: '\n\n' });
      }
      group = [];
      size = 0;
    };
    for (const l of lines) {
      const len = escapeHtml(l).length;
      if (group.length && size + 1 + len > room) flush();
      size += (group.length ? 1 : 0) + len;
      group.push(l);
    }
    flush();
  }
  if (footer) units.push({ html: `<i>${escapeHtml(footer)}</i>`, plain: footer, glue: '\n\n' });

  const chunks = [];
  let cur = null;
  for (const u of units) {
    if (cur && cur.html.length + u.glue.length + u.html.length > limit) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) cur = { html: u.html, plain: u.plain };
    else {
      cur.html += u.glue + u.html;
      cur.plain += u.glue + u.plain;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => ({ html: c.html.trim(), plain: c.plain.trim() })).filter((c) => c.html && c.plain);
}

// ---------- describing tool calls ----------

const mcpParts = (name) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name));
  return m ? { server: m[1], tool: m[2] } : null;
};

/** One-line live progress label (HTML) for a tool call. */
export function describeStep(name, input = {}, cwd = '') {
  const i = input && typeof input === 'object' ? input : {};
  const file = (p) => code(relPath(p, cwd));
  switch (name) {
    case 'Read':
      return t('telegram.stepRead', { target: file(i.file_path) });
    case 'Write':
      return t('telegram.stepWrite', { target: file(i.file_path) });
    case 'Edit':
    case 'MultiEdit':
      return t('telegram.stepEdit', { target: file(i.file_path) });
    case 'NotebookEdit':
      return t('telegram.stepEdit', { target: file(i.notebook_path) });
    case 'Bash':
    case 'PowerShell':
      return t('telegram.stepBash', { target: code(clip(oneLine(i.command), 70)) });
    case 'Grep':
      return t('telegram.stepGrep', { target: code(clip(i.pattern, 50)) });
    case 'Glob':
      return t('telegram.stepGlob', { target: code(clip(i.pattern, 50)) });
    case 'WebFetch':
      return t('telegram.stepFetch', { target: code(hostOf(i.url)) });
    case 'WebSearch':
      return t('telegram.stepWebSearch', { target: esc(clip(i.query, 60)) });
    case 'Task':
    case 'Agent':
      return t('telegram.stepAgent', { target: esc(clip(oneLine(i.description || i.subagent_type || ''), 60)) });
    case 'TodoWrite':
      return t('telegram.stepTodo');
    default: {
      const mcp = mcpParts(name);
      if (mcp && /browser|chrome/i.test(mcp.server)) {
        return t('telegram.stepBrowser', { target: i.url ? code(hostOf(i.url)) : esc(mcp.tool.replace(/_/g, ' ')) });
      }
      if (mcp) return t('telegram.stepMcp', { target: esc(`${mcp.server}: ${mcp.tool}`) });
      return t('telegram.stepTool', { target: esc(name) });
    }
  }
}

const lineCount = (s) => (s ? String(s).split('\n').length : 0);

/** Readable multi-line summary (HTML) of a permission request. */
export function describeRequest(name, input = {}, cwd = '') {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return [t('telegram.permBash'), `<pre>${esc(clip(i.command, 1500))}</pre>`, i.description ? `<i>${esc(clip(i.description, 200))}</i>` : ''].filter(Boolean).join('\n');
    case 'Write':
      return [t('telegram.permWrite'), code(relPath(i.file_path, cwd)), esc(t('telegram.linesCount', { count: lineCount(i.content) }))].join('\n');
    case 'Edit':
      return [t('telegram.permEdit'), code(relPath(i.file_path, cwd)), esc(t('telegram.diffSize', { removed: lineCount(i.old_string), added: lineCount(i.new_string) }))].join('\n');
    case 'MultiEdit': {
      const edits = Array.isArray(i.edits) ? i.edits : [];
      const removed = edits.reduce((n, e) => n + lineCount(e?.old_string), 0);
      const added = edits.reduce((n, e) => n + lineCount(e?.new_string), 0);
      return [t('telegram.permEdit'), code(relPath(i.file_path, cwd)), esc(t('telegram.diffSize', { removed, added }))].join('\n');
    }
    case 'NotebookEdit':
      return [t('telegram.permEdit'), code(relPath(i.notebook_path, cwd))].join('\n');
    case 'Read':
      return [t('telegram.permRead'), code(relPath(i.file_path, cwd))].join('\n');
    case 'Grep':
    case 'Glob':
      return [t('telegram.permSearch'), code(clip(i.pattern, 200)), i.path ? code(relPath(i.path, cwd)) : ''].filter(Boolean).join('\n');
    case 'WebFetch':
      return [t('telegram.permFetch'), code(clip(i.url, 300))].join('\n');
    case 'WebSearch':
      return [t('telegram.permWebSearch'), esc(clip(i.query, 300))].join('\n');
    default: {
      const mcp = mcpParts(name);
      return [t('telegram.permTool', { name: esc(mcp ? `${mcp.server}: ${mcp.tool}` : name) }), `<pre>${esc(clip(JSON.stringify(i, null, 1), 700))}</pre>`].join('\n');
    }
  }
}

// ---------- feature ----------

export function register(ctx) {
  const file = path.join(ctx.userData, 'telegram.json');
  const log = (...a) => console.log('[telegram]', ...a);

  // Persisted: on/off, getUpdates offset (per bot), selection, permission mode, model, notifications,
  // chats-list scope and a hash of the last applied bot profile (commands, menu button, descriptions).
  let st = { enabled: false, offset: 0, botId: '', project: null, chat: null, mode: 'edits', agent: 'claude', model: 'default', notify: true, chatsScope: 'project', profileHash: '' };
  /** Agents the bot can start new chats with. */
  const agents = () => ctx.core.registry.all().map((p) => ({ id: p.id, label: p.label }));
  const agentLabel = (id) => agents().find((a) => a.id === id)?.label ?? id;
  /** The agent the next task runs with: the selected chat's own, else the chosen one. */
  const taskAgent = () => st.chat?.provider ?? (ctx.core.registry.has(st.agent) ? st.agent : 'claude');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    st = {
      enabled: Boolean(raw?.enabled),
      offset: Number.isInteger(raw?.offset) ? raw.offset : 0,
      botId: String(raw?.botId ?? ''),
      project: raw?.project?.id ? { id: String(raw.project.id) } : raw?.project?.folder ? { folder: String(raw.project.folder) } : null,
      chat: raw?.chat?.sessionId
        ? { sessionId: String(raw.chat.sessionId), title: String(raw.chat.title ?? ''), cwd: String(raw.chat.cwd ?? ''), ...(raw.chat.provider ? { provider: String(raw.chat.provider) } : {}) }
        : null,
      mode: MODES[raw?.mode] ? raw.mode : 'edits',
      agent: typeof raw?.agent === 'string' ? raw.agent : 'claude',
      model: Object.hasOwn(MODELS, raw?.model ?? '') ? raw.model : 'default',
      notify: raw?.notify !== false,
      chatsScope: raw?.chatsScope === 'all' ? 'all' : 'project',
      profileHash: String(raw?.profileHash ?? ''),
    };
  } catch {}

  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 2));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      console.error('[telegram] save failed', e);
    }
  };

  // ---------- bot config (shared with the scheduler) ----------
  const readSchedulerFile = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ctx.userData, 'schedules.json'), 'utf8'));
      return { token: String(raw?.settings?.telegramToken ?? ''), chatId: String(raw?.settings?.telegramChatId ?? '') };
    } catch {
      return { token: '', chatId: '' };
    }
  };
  let cfg = sched.telegramConfig() ?? readSchedulerFile();
  // Remote control only works for a private chat with the user: its id is a positive number equal to the user id.
  const isConfigured = () => Boolean(cfg.token) && /^\d+$/.test(cfg.chatId);
  const configProblem = () => {
    if (!cfg.token || !cfg.chatId) return t('telegram.needConfig');
    if (!/^\d+$/.test(cfg.chatId)) return t('telegram.needPrivateChat');
    return '';
  };
  const hideToken = (s) => (cfg.token ? String(s).split(cfg.token).join('***') : String(s));

  // ---------- runtime state ----------
  let polling = false;
  let loopGen = 0;
  let loopKey = '';
  let pollAbort = null;
  let botName = '';
  let lastError = '';
  let onlineSince = 0; // unix seconds
  let task = null; // the running Claude task (one at a time)
  let selVersion = 0; // bumps on every project / chat selection change
  let runSeq = 0;
  let permSeq = 0;
  const warned = new Set();
  const perms = new Map(); // pending permission requests by short id
  const finished = new Map(); // ref → summary of a finished run (Continue / Details buttons)

  // Short-lived ids for callback_data (≤ 64 bytes): folders and project ids stay server-side.
  // The counter starts from the clock so buttons from before a restart never point at new entries.
  const refs = new Map();
  let refSeq = Math.floor(Date.now() / 1000) % 1e7;
  const ref = (value) => {
    const id = (++refSeq).toString(36);
    refs.set(id, value);
    if (refs.size > REFS_MAX) refs.delete(refs.keys().next().value);
    return id;
  };

  const status = () => {
    const proj = currentProject();
    return {
      enabled: st.enabled,
      configured: isConfigured(),
      running: polling,
      busy: Boolean(task),
      busySince: task?.startedAt ?? null,
      botName,
      lastError: lastError || (st.enabled ? configProblem() : ''),
      current: { project: proj?.name ?? null, chat: st.chat ? st.chat.title || t('telegram.untitled') : null, mode: st.mode, model: st.model },
    };
  };
  const emitUpdate = () => {
    const s = status();
    ctx.emit('tg:update', { enabled: s.enabled, running: s.running, busy: s.busy, ...(s.lastError ? { lastError: s.lastError } : {}), ...(s.botName ? { botName: s.botName } : {}) });
  };

  // ---------- Telegram API ----------
  function describe(status, description) {
    const d = String(description ?? '');
    if (status === 401 || status === 404) return t('telegram.badToken');
    if (status === 409) return t('telegram.conflict');
    if (/chat not found/i.test(d)) return t('telegram.chatNotFound');
    if (status === 403) return t('telegram.forbidden');
    return t('telegram.apiError', { error: d || status });
  }

  async function request(method, init, { signal, timeoutMs = 20000 } = {}) {
    const token = cfg.token;
    if (!token) throw new Error(t('telegram.noToken'));
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', ...init, signal: AbortSignal.any(signals) });
    } catch (e) {
      const err = new Error(signal?.aborted ? 'aborted' : t('telegram.network', { error: hideToken(e?.message ?? e) }));
      err.aborted = Boolean(signal?.aborted);
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.ok) return data.result;
    const status = Number(data?.error_code ?? res.status);
    const err = new Error(describe(status, data?.description));
    err.status = status;
    err.description = String(data?.description ?? '');
    err.retryAfter = Number(data?.parameters?.retry_after) || 0;
    throw err;
  }

  /** Bot API call with JSON params; waits out short 429 floods (retry_after) unless `retry: false`. */
  async function api(method, params = {}, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(method, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }, opts);
      } catch (e) {
        const wait = e.retryAfter || 3;
        if (e.status === 429 && opts.retry !== false && attempt < 2 && wait <= 30) {
          await sleep(wait * 1000, opts.signal);
          continue;
        }
        throw e;
      }
    }
  }

  const notModified = (e) => e?.status === 400 && /not modified/i.test(e.description ?? '');
  const badMarkup = (e) => e?.status === 400 && /parse entities|can't find end|unsupported start tag|unexpected end tag/i.test(e.description ?? '');
  const noPreview = { link_preview_options: { is_disabled: true } };

  /** Sends an HTML message (plain text if Telegram rejects the markup). Resolves with the Message or null. */
  async function send(text, extra = {}) {
    const base = { chat_id: cfg.chatId, ...noPreview, ...extra };
    try {
      return await api('sendMessage', { ...base, text, parse_mode: 'HTML' });
    } catch (e) {
      if (badMarkup(e)) return api('sendMessage', { ...base, text: htmlToPlain(text) }).catch((e2) => (log('send failed:', e2.message), null));
      log('send failed:', e.message);
      return null;
    }
  }

  /** Edits a bot message in place ("not modified" counts as success; other failures throw). No markup = no buttons. */
  async function edit(messageId, text, markup, opts = {}) {
    const params = { chat_id: cfg.chatId, message_id: messageId, text, parse_mode: 'HTML', ...noPreview, ...(markup ? { reply_markup: markup } : {}) };
    try {
      await api('editMessageText', params, opts);
      return true;
    } catch (e) {
      if (notModified(e)) return true;
      if (!badMarkup(e)) throw e;
      const { parse_mode, ...plain } = params;
      await api('editMessageText', { ...plain, text: htmlToPlain(text) }, opts).catch((e2) => {
        if (!notModified(e2)) throw e2;
      });
      return true;
    }
  }

  /** Shows a card: edits the message the button belongs to, or sends a new one if that fails. */
  async function show(card, cq) {
    const msgId = cq?.message?.message_id;
    if (msgId) {
      try {
        return await edit(msgId, card.text, card.markup);
      } catch (e) {
        log('edit failed, sending a new message:', e.message);
      }
    }
    return send(card.text, card.markup ? { reply_markup: card.markup } : {});
  }

  async function sendChunk({ html, plain }) {
    try {
      await api('sendMessage', { chat_id: cfg.chatId, ...noPreview, text: html, parse_mode: 'HTML' });
    } catch (e) {
      if (e.status !== 400) throw e;
      await api('sendMessage', { chat_id: cfg.chatId, ...noPreview, text: plain }); // markup rejected: plain text
    }
  }

  async function sendDocument(content, filename, caption) {
    const form = new FormData();
    form.append('chat_id', cfg.chatId);
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([content], { type: 'text/markdown' }), filename);
    return request('sendDocument', { body: form }, { timeoutMs: 60000 });
  }

  const answerCb = (cq, text, alert) =>
    api('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text: clip(text, 190) } : {}), ...(alert ? { show_alert: true } : {}) }, { retry: false }).catch(() => {});

  // ---------- keyboards ----------
  const btn = (text, data) => {
    if (Buffer.byteLength(data) > 64) throw new Error(`callback_data too long: ${data}`);
    return { text, callback_data: data };
  };
  const ikb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
  const backBtn = (data = 'h') => btn(t('telegram.btnBack'), data);
  const mainKeyboard = () => ({
    keyboard: [
      [{ text: t('telegram.kb_projects') }, { text: t('telegram.kb_chats') }],
      [{ text: t('telegram.kb_new') }, { text: t('telegram.kb_settings') }, { text: t('telegram.kb_status') }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: clip(t('telegram.placeholder'), 64),
  });
  const pager = (prefix, page, pages) =>
    pages > 1
      ? [
          btn(page > 0 ? '◀' : ' ', page > 0 ? `${prefix}:${page - 1}` : 'x'),
          btn(`${page + 1}/${pages}`, 'x'),
          btn(page < pages - 1 ? '▶' : ' ', page < pages - 1 ? `${prefix}:${page + 1}` : 'x'),
        ]
      : null;

  /** Reply-keyboard label (in any language, so old keyboards keep working) or its emoji → menu action. */
  function menuAction(text) {
    const all = (key) => (typeof i18n.tAll === 'function' ? i18n.tAll(key) : [t(key)]);
    for (const [action] of MENU) if (all(`telegram.kb_${action}`).includes(text)) return action;
    if (text.length <= 32 && !text.includes('\n')) for (const [action, emoji] of MENU) if (text.startsWith(emoji)) return action;
    return null;
  }

  // ---------- projects & chats ----------
  const readUi = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ctx.userData, 'settings.json'), 'utf8'))?.ui ?? {};
    } catch {
      return {};
    }
  };
  const uiProjects = (ui) =>
    (Array.isArray(ui.projects) ? ui.projects : [])
      .filter((p) => p && p.id && Array.isArray(p.folders))
      .map((p) => {
        const folders = p.folders.map(String).filter(Boolean);
        return { kind: 'project', id: String(p.id), name: String(p.name || baseName(folders[0]) || t('telegram.project')), folders };
      });

  /** Mirrors projectOf() in the renderer store: explicit assignment first, else the project owning the folder. */
  function projectIdOf(ui, projects, sessionId, cwd) {
    const explicit = ui.chatProject?.[sessionId];
    if (explicit === '-') return null;
    if (explicit && projects.some((p) => p.id === explicit)) return explicit;
    return cwd ? (projects.find((p) => p.folders.some((f) => sameDir(f, cwd)))?.id ?? null) : null;
  }

  function currentProject() {
    const p = st.project;
    if (p?.id) return uiProjects(readUi()).find((x) => x.id === p.id) ?? null;
    if (p?.folder) return { kind: 'folder', folder: p.folder, name: baseName(p.folder), folders: [p.folder] };
    return null;
  }
  const isCurrentProject = (cur, p) => Boolean(cur) && (p.kind === 'project' ? cur.id === p.id : cur.kind === 'folder' && sameDir(cur.folder, p.folder));

  async function sessions() {
    try {
      const list = (await ctx.core.listSessions()) ?? [];
      return [...list].sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    } catch (e) {
      log('listSessions failed:', e?.message ?? e);
      return [];
    }
  }

  async function buildProjectList() {
    const projects = uiProjects(readUi());
    const seen = new Set(projects.flatMap((p) => p.folders.map(normDir)));
    const recent = [];
    for (const s of await sessions()) {
      if (!s.cwd || seen.has(normDir(s.cwd))) continue;
      seen.add(normDir(s.cwd));
      recent.push({ kind: 'folder', folder: s.cwd, name: baseName(s.cwd), folders: [s.cwd] });
      if (recent.length >= FOLDERS_LIMIT) break;
    }
    return [...projects, ...recent];
  }

  async function buildChatList() {
    const ui = readUi();
    const projects = uiProjects(ui);
    const archived = new Set(Array.isArray(ui.archived) ? ui.archived : []);
    const proj = currentProject();
    const scope = proj ? st.chatsScope : 'all';
    const all = (await sessions()).filter((s) => s.sessionId && SESSION_RE.test(s.sessionId) && !archived.has(s.sessionId));
    const mine =
      scope === 'all'
        ? all
        : proj.kind === 'project'
          ? all.filter((s) => projectIdOf(ui, projects, s.sessionId, s.cwd) === proj.id)
          : all.filter((s) => sameDir(s.cwd, proj.folder));
    return { proj, scope, chats: mine.slice(0, CHATS_MAX) };
  }

  const selectionChanged = () => {
    selVersion++;
    save();
    emitUpdate();
  };

  /** Continues an existing chat; the project follows the chat (its owner project, else its folder). */
  function selectChat(c) {
    st.chat = { sessionId: c.sessionId, title: clip(oneLine(c.title), 80), cwd: c.cwd || '', ...(c.provider ? { provider: c.provider } : {}) };
    const ui = readUi();
    const projects = uiProjects(ui);
    const owner = projectIdOf(ui, projects, c.sessionId, c.cwd);
    if (owner) st.project = { id: owner };
    else if (c.cwd) st.project = { folder: c.cwd };
    selectionChanged();
  }

  async function lastAssistantText(sessionId, cwd, provider) {
    if (typeof ctx.core.loadSession !== 'function') return '';
    try {
      const events = await withTimeout(Promise.resolve(ctx.core.loadSession(sessionId, cwd || undefined, undefined, provider)), 2500);
      if (!Array.isArray(events)) return '';
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev?.type === 'text' && ev.mode === 'final' && !ev.agent && ev.text.trim()) return ev.text.trim();
      }
    } catch {}
    return '';
  }

  // ---------- cards: { text (HTML), markup } ----------
  const quoted = (s) => t('telegram.quoted', { text: esc(s) });
  const chatTitle = () => (st.chat ? st.chat.title || t('telegram.untitled') : '');

  function contextLines() {
    const proj = currentProject();
    return [
      t('telegram.ctxProject', { value: proj ? `<b>${esc(proj.name)}</b>` : esc(t('telegram.projectNone')) }),
      t('telegram.ctxChat', { value: st.chat ? quoted(chatTitle()) : esc(t('telegram.chatNew')) }),
      t('telegram.ctxMode', { value: `${MODES[st.mode].icon} ${esc(modeLabel(st.mode))}` }),
      ...(agents().length > 1 ? [t('telegram.ctxAgent', { value: esc(agentLabel(taskAgent())) })] : []),
      ...(taskAgent() === 'claude' ? [t('telegram.ctxModel', { value: esc(modelLabel(st.model)) })] : []),
    ];
  }

  function homeCard() {
    return {
      text: [t('telegram.homeTitle'), '', ...contextLines(), '', task ? t('telegram.homeBusy') : t('telegram.homeHint')].join('\n'),
      markup: ikb([btn(t('telegram.btnChooseProject'), 'pl:0'), btn(t('telegram.btnChooseChat'), 'cl:0')], [btn(t('telegram.btnNewChat'), 'n'), btn(t('telegram.btnMode'), 'set')]),
    };
  }

  function projectButtonLabel(p, current) {
    let label = `${current ? '✅' : p.kind === 'project' ? '📁' : '📂'} ${clip(p.name, 34)}`;
    if (p.folders.length > 1) label += ` · 🗂 ${p.folders.length}`;
    else if (p.kind === 'project' && p.folders[0] && baseName(p.folders[0]).toLowerCase() !== p.name.toLowerCase()) label += ` · ${clip(baseName(p.folders[0]), 20)}`;
    return label;
  }

  async function projectsCard(page = 0) {
    const items = await buildProjectList();
    if (!items.length) return { text: t('telegram.noProjects'), markup: ikb([backBtn()]) };
    const pages = Math.ceil(items.length / PAGE);
    page = Math.min(Math.max(0, page | 0), pages - 1);
    const cur = currentProject();
    const slice = items.slice(page * PAGE, page * PAGE + PAGE);
    const rows = [];
    slice.forEach((p, i) => {
      if (p.kind === 'folder' && (i === 0 || slice[i - 1].kind === 'project')) rows.push([btn(t('telegram.recentFoldersRow'), 'x')]);
      const value = p.kind === 'project' ? { id: p.id } : { folder: p.folder };
      rows.push([btn(projectButtonLabel(p, isCurrentProject(cur, p)), `p:${ref(value)}:${page}`)]);
    });
    rows.push(pager('pl', page, pages));
    rows.push([backBtn()]);
    const head = t('telegram.projectsTitle') + (pages > 1 ? ` · ${page + 1}/${pages}` : '');
    const sub = cur ? t('telegram.projectsCurrent', { name: esc(cur.name) }) : t('telegram.projectsHint');
    return { text: `${head}\n${sub}`, markup: ikb(...rows) };
  }

  function projectCard(proj, page = 0) {
    const lines = [`📁 <b>${esc(proj.name)}</b>`, code(proj.folders[0] ?? '')];
    if (proj.folders.length > 1) lines.push(esc(t('telegram.moreFolders', { count: proj.folders.length - 1 })));
    lines.push('', t('telegram.projectPicked'));
    return {
      text: lines.join('\n'),
      markup: ikb([btn(t('telegram.btnNewChatHere'), 'n'), btn(t('telegram.btnChatsInProject'), 'cl:0')], [backBtn(`pl:${page}`)]),
    };
  }

  async function chatsCard(page = 0) {
    const { proj, scope, chats } = await buildChatList();
    const where = scope === 'all' || !proj ? t('telegram.whereAll') : t('telegram.whereProject', { name: esc(proj.name) });
    const toggle = proj ? [btn(scope === 'all' ? t('telegram.btnScopeProject') : t('telegram.btnScopeAll'), 'cs')] : null;
    if (!chats.length) {
      return { text: t('telegram.noChats', { where }), markup: ikb(toggle, [btn(t('telegram.btnNewChat'), 'n'), backBtn()]) };
    }
    const pages = Math.ceil(chats.length / PAGE);
    page = Math.min(Math.max(0, page | 0), pages - 1);
    const rows = chats.slice(page * PAGE, page * PAGE + PAGE).map((c) => {
      const when = ago(c.lastModified);
      const label = `${st.chat?.sessionId === c.sessionId ? '✅ ' : ''}${clip(oneLine(c.title) || t('telegram.untitledCap'), 40)}${when ? ` · ${when}` : ''}`;
      return [btn(label, `c:${c.sessionId}:${page}`)];
    });
    return {
      text: t('telegram.chatsTitle', { where }) + (pages > 1 ? ` · ${page + 1}/${pages}` : '') + '\n' + t('telegram.chatsHint'),
      markup: ikb(...rows, pager('cl', page, pages), toggle, [btn(t('telegram.btnNewChat'), 'n'), backBtn()]),
    };
  }

  async function chatCard(c, page = 0) {
    const ui = readUi();
    const projects = uiProjects(ui);
    const owner = projects.find((p) => p.id === projectIdOf(ui, projects, c.sessionId, c.cwd));
    const lines = [`💬 <b>${esc(clip(oneLine(c.title) || t('telegram.untitledCap'), 120))}</b>`];
    lines.push(t('telegram.ctxProject', { value: owner ? esc(owner.name) : c.cwd ? code(c.cwd) : esc(t('telegram.projectNone')) }));
    const when = ago(c.lastModified);
    if (when) lines.push(t('telegram.lastActivity', { when: esc(when) }));
    if (st.chat?.sessionId === c.sessionId) lines.push(t('telegram.isCurrentChat'));
    const preview = await lastAssistantText(c.sessionId, c.cwd, c.provider);
    if (preview) lines.push('', `<i>${esc(clip(preview.replace(/\n{3,}/g, '\n\n'), 400))}</i>`);
    return {
      text: lines.join('\n'),
      markup: ikb([btn(t('telegram.btnContinueHere'), `cc:${c.sessionId}`), btn(t('telegram.btnNewChatShort'), 'n')], [backBtn(`cl:${page}`)]),
    };
  }

  function settingsCard() {
    const mark = (on, label) => (on ? `✅ ${label}` : label);
    const lines = [
      t('telegram.settingsTitle'),
      '',
      t('telegram.ctxMode', { value: `<b>${MODES[st.mode].icon} ${esc(modeLabel(st.mode))}</b>` }),
      `<i>${esc(modeHint(st.mode))}</i>`,
      '',
      ...(agents().length > 1 ? [t('telegram.ctxAgent', { value: `<b>${esc(agentLabel(st.agent))}</b>` }), `<i>${esc(t('telegram.agentHint'))}</i>`, ''] : []),
      ...(st.agent === 'claude' ? [t('telegram.ctxModel', { value: `<b>${esc(modelLabel(st.model))}</b>` })] : []),
      t(st.notify ? 'telegram.notifyOnLine' : 'telegram.notifyOffLine'),
    ];
    return {
      text: lines.join('\n'),
      markup: ikb(
        Object.keys(MODES).map((k) => btn(mark(st.mode === k, `${MODES[k].icon} ${modeLabel(k)}`), `mo:${k}`)),
        ...(agents().length > 1 ? [agents().map((a) => btn(mark(st.agent === a.id, `🤖 ${a.label}`), `ag:${a.id}`))] : []),
        ...(st.agent === 'claude' ? [Object.keys(MODELS).map((k) => btn(mark(st.model === k, modelLabel(k)), `md:${k}`))] : []),
        [btn(t(st.notify ? 'telegram.btnNotifyOn' : 'telegram.btnNotifyOff'), 'nt')],
        [backBtn()],
      ),
    };
  }

  const fullConfirmCard = () => ({
    text: [`⚠️ <b>${esc(modeLabel('full'))}</b>`, '', esc(modeHint('full')), '', t('telegram.fullConfirm')].join('\n'),
    markup: ikb([btn(t('telegram.btnFullYes'), 'mo:full:y')], [backBtn('set')]),
  });

  function statusCard() {
    const lines = [t('telegram.statusTitle'), ''];
    lines.push(
      task
        ? t('telegram.statusBusy', { time: esc(formatDuration(Date.now() - task.startedAt)), steps: esc(t('telegram.steps', { count: task.steps })), prompt: esc(clip(oneLine(task.prompt), 80)) })
        : t('telegram.statusIdle'),
    );
    lines.push(...contextLines());
    if (onlineSince) lines.push(t('telegram.statusUptime', { time: esc(formatDuration(Date.now() - onlineSince * 1000)) }));
    return {
      text: lines.join('\n'),
      markup: ikb([btn(t('telegram.btnRefresh'), 'st'), ...(task ? [btn(t('telegram.btnStop'), `stop:${task.id}`)] : [])], [backBtn()]),
    };
  }

  async function sendWelcome(short = false) {
    await send(short ? t('telegram.menuShown') : t('telegram.welcome'), { reply_markup: mainKeyboard() });
    const card = homeCard();
    await send(card.text, { reply_markup: card.markup });
  }

  /** The next message starts a new chat; returns the confirmation text (plain). */
  function newChat() {
    st.chat = null;
    selectionChanged();
    const proj = currentProject();
    return proj ? t('telegram.newChatIn', { name: proj.name }) : t('telegram.newChat');
  }

  // ---------- running tasks (as regular, visible app chats) ----------
  const stopKb = (run) => ikb([btn(t('telegram.btnStop'), `stop:${run.id}`)]);

  /** Where the next task runs: the selected chat's folder or the project's first folder (+ the other folders). */
  function resolveWhere() {
    const ui = readUi();
    const proj = currentProject();
    let cwd;
    let dirs = [];
    let resume;
    let projectId;
    if (st.chat?.sessionId) {
      resume = st.chat.sessionId;
      cwd = st.chat.cwd || proj?.folders[0] || ui.cwd || os.homedir();
      const projects = uiProjects(ui);
      const owner = projects.find((p) => p.id === projectIdOf(ui, projects, resume, cwd));
      dirs = owner ? owner.folders.filter((f) => !sameDir(f, cwd)) : [];
      projectId = owner?.id;
    } else {
      cwd = proj?.folders[0] || ui.cwd || os.homedir();
      dirs = proj ? proj.folders.slice(1) : [];
      projectId = proj?.kind === 'project' ? proj.id : undefined;
    }
    if (!isDir(cwd)) return { error: t('telegram.folderNotFound', { path: esc(cwd) }) };
    return { cwd, dirs: dirs.filter(isDir), resume, projectId, projectName: proj?.name ?? '' };
  }

  const busyReply = () => send(t('telegram.alreadyBusy'), { reply_markup: stopKb(task) });
  const whereError = (where) => send(where.error, { reply_markup: ikb([btn(t('telegram.btnChooseProject'), 'pl:0')]) });

  function startTask(prompt, where = resolveWhere()) {
    if (task) return busyReply();
    if (where.error) return whereError(where);
    const run = {
      id: (++runSeq).toString(36),
      startedAt: Date.now(),
      prompt,
      ...where,
      mode: st.mode,
      agent: taskAgent(),
      model: st.model,
      version: selVersion,
      threadId: null,
      unobserve: null,
      completing: false,
      resolveDone: null,
      cancelled: false,
      done: false,
      steps: 0,
      step: '',
      log: [],
      waiting: 0,
      always: new Set(),
      msgId: null,
      lastText: '',
      lastEditAt: 0,
      stepChanged: false,
      editBlockedUntil: 0,
      editing: Promise.resolve(),
      typing: null,
      ticker: null,
      idleTicks: 0,
      sessionId: null,
      promise: null,
    };
    task = run;
    emitUpdate();
    run.promise = execute(run).catch((e) => console.error('[telegram] run failed', e));
    return run.promise;
  }

  function progressText(run) {
    const head = [t('telegram.progressWorking'), esc(formatDuration(Date.now() - run.startedAt))];
    if (run.steps) head.push(esc(t('telegram.steps', { count: run.steps })));
    const lines = [head.join(' · ')];
    if (run.waiting) lines.push(t('telegram.progressWaiting'));
    else if (run.step) lines.push(run.step);
    lines.push('', `<i>${esc(clip(oneLine(run.prompt), 160))}</i>`, t('telegram.progressInApp'));
    return lines.join('\n');
  }

  /** Throttled live edit of the status message: at most every PROGRESS_MS, and only when its text changed. */
  function updateProgress(run, force = false) {
    if (run.done || run.cancelled || !run.msgId) return;
    const now = Date.now();
    if (now < run.editBlockedUntil) return;
    if (!force && !run.stepChanged && now - run.lastEditAt < PROGRESS_IDLE_MS) return;
    if (!force && now - run.lastEditAt < PROGRESS_MS - 100) return;
    const text = progressText(run);
    if (text === run.lastText) return;
    run.stepChanged = false;
    run.lastText = text;
    run.lastEditAt = now;
    run.editing = run.editing
      .then(() => (run.done || run.cancelled ? null : edit(run.msgId, text, stopKb(run), { retry: false })))
      .catch((e) => {
        if (e.status === 429) run.editBlockedUntil = Date.now() + (e.retryAfter || 5) * 1000;
      });
  }

  function noteSession(run, sessionId) {
    if (!sessionId || run.sessionId) return;
    run.sessionId = sessionId;
    ctx.emit('tg:session', { sessionId });
  }

  /** One Agent SDK message of the observed chat. */
  function onRunEvent(run, m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'system' && m.subtype === 'init') noteSession(run, m.session_id);
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b?.type !== 'tool_use') continue;
        run.steps++;
        let label;
        try {
          label = describeStep(b.name, b.input, run.cwd);
        } catch {
          label = t('telegram.stepTool', { target: esc(b.name) });
        }
        run.step = label;
        run.log.push(label);
        if (run.log.length > LOG_MAX) run.log.shift();
        run.stepChanged = true;
      }
    }
    if (m.type === 'result' && !m.parent_tool_use_id) {
      complete(run, { text: m.result ?? '', isError: Boolean(m.is_error), durationMs: m.duration_ms ?? 0, costUsd: m.total_cost_usd ?? 0 }, null);
    }
  }

  /** Answers a permission request of the observed chat; false if it was already answered (e.g. in the app). */
  const respond = (run, reqId, decision, message) => {
    try {
      return ctx.core.respondPermission({ threadId: run.threadId, reqId, decision, ...(message ? { message } : {}) }) !== false;
    } catch (e) {
      log('respondPermission failed:', e?.message ?? e);
      return false;
    }
  };

  /** A claude:permission request: asked here with Allow / Always / Deny buttons (the app shows it too). */
  function onPermission(run, p) {
    const { reqId, toolName, input } = p ?? {};
    if (!reqId || run.done || run.cancelled) return;
    if (toolName === 'AskUserQuestion') return respond(run, reqId, 'deny', DENY_QUESTION);
    if (run.always.has(toolName)) return respond(run, reqId, 'allow');
    const id = (++permSeq).toString(36);
    let summary;
    try {
      summary = describeRequest(toolName, input, run.cwd);
    } catch {
      summary = t('telegram.permTool', { name: esc(toolName) });
    }
    const body = `${t('telegram.permTitle')}\n${summary}`;
    const req = { id, reqId, run, toolName, msgId: null, done: false, timer: null, finish: null };
    // kind: allow | always | deny | timeout (answered from here), elsewhere (answered in the app), cancel (run ended)
    req.finish = (kind) => {
      if (req.done) return;
      req.done = true;
      perms.delete(id);
      clearTimeout(req.timer);
      run.waiting = Math.max(0, run.waiting - 1);
      run.stepChanged = true;
      if (kind === 'allow' || kind === 'always' || kind === 'deny' || kind === 'timeout') {
        const decision = kind === 'timeout' ? 'deny' : kind;
        if (!respond(run, reqId, decision, kind === 'timeout' ? DENY_TIMEOUT : kind === 'deny' ? DENY_MESSAGE : '')) kind = 'elsewhere';
        else if (kind === 'always') run.always.add(toolName);
      }
      if (req.msgId) edit(req.msgId, `${body}\n\n${t(`telegram.perm_${kind}`, { name: esc(toolName) })}`).catch(() => {});
      updateProgress(run);
      return kind;
    };
    perms.set(id, req);
    run.waiting++;
    run.stepChanged = true;
    updateProgress(run, true);
    req.timer = setTimeout(() => req.finish('timeout'), PERM_TIMEOUT_MS);
    req.timer.unref?.();
    send(body, {
      reply_markup: ikb([btn(t('telegram.btnAllow'), `pa:${id}:a`), btn(t('telegram.btnAlways'), `pa:${id}:s`)], [btn(t('telegram.btnDeny'), `pa:${id}:d`)]),
    }).then((msg) => {
      if (!msg) return; // can't ask here: it stays open in the app
      req.msgId = msg.message_id;
      if (req.done) edit(req.msgId, `${body}\n\n${t('telegram.perm_elsewhere')}`).catch(() => {}); // settled while sending
    });
  }

  function onObserved(run, channel, p) {
    if (run.done) return;
    switch (channel) {
      case 'claude:event':
        return onRunEvent(run, p?.msg);
      case 'claude:permission':
        return onPermission(run, p);
      case 'claude:permission-cancel': {
        const req = [...perms.values()].find((r) => r.run === run && r.reqId === p?.reqId);
        return req?.finish('elsewhere');
      }
      case 'claude:closed':
        return complete(run, null, p?.error ? new Error(String(p.error)) : null);
    }
  }

  /** Ends the observed run once (result, closed, stop fallback or a missed result). */
  function complete(run, r, error) {
    if (run.completing) return;
    run.completing = true;
    try {
      run.unobserve?.();
    } catch {}
    finishRun(run, r, error)
      .catch((e) => console.error('[telegram] finish failed', e))
      .finally(() => run.resolveDone?.());
  }

  async function execute(run) {
    const first = progressText(run);
    const msg = await send(first, { reply_markup: stopKb(run) });
    run.msgId = msg?.message_id ?? null;
    run.lastText = first;
    run.lastEditAt = Date.now();
    if (run.cancelled) return finishRun(run, null, null); // stopped before Claude even started
    const typing = () => !run.cancelled && !run.done && api('sendChatAction', { chat_id: cfg.chatId, action: 'typing' }, { retry: false }).catch(() => {});
    typing();
    run.typing = setInterval(typing, TYPING_MS);
    run.typing.unref?.();
    run.ticker = setInterval(() => tick(run), PROGRESS_MS);
    run.ticker.unref?.();

    try {
      const res = await ctx.core.startVisible({
        prompt: run.prompt,
        cwd: run.cwd,
        ...(run.dirs.length ? { dirs: run.dirs } : {}),
        ...(run.resume ? { resume: run.resume } : {}),
        ...(run.projectId ? { projectId: run.projectId } : {}),
        // A new chat runs with the chosen agent; a continued one keeps its own. Models listed here are Claude's.
        ...(run.resume ? {} : { provider: run.agent }),
        ...(run.agent === 'claude' && MODELS[run.model] ? { model: MODELS[run.model] } : {}),
        permissionMode: MODES[run.mode].perm,
        source: 'telegram',
      });
      run.threadId = res?.threadId ?? null;
      if (!run.threadId) throw new Error('no thread');
    } catch (e) {
      return finishRun(run, null, e);
    }
    await new Promise((resolve) => {
      run.resolveDone = resolve;
      run.unobserve = ctx.core.observe(run.threadId, (channel, payload) => {
        try {
          onObserved(run, channel, payload);
        } catch (e) {
          log('event failed:', e?.message ?? e);
        }
      });
      noteSession(run, ctx.core.sessionOf?.(run.threadId));
      if (run.cancelled) stopRun(run); // Stop was pressed while the chat was opening
    });
  }

  /** Every PROGRESS_MS: refresh the live card; finish if the chat stopped without us seeing its result. */
  function tick(run) {
    updateProgress(run);
    if (!run.threadId || run.completing || typeof ctx.core.isRunning !== 'function') return;
    run.idleTicks = ctx.core.isRunning(run.threadId) ? 0 : run.idleTicks + 1;
    if (run.idleTicks >= 2) complete(run, { text: t('telegram.answerInApp'), missed: true }, null);
  }

  async function finishRun(run, r, error) {
    run.done = true;
    clearInterval(run.typing);
    clearInterval(run.ticker);
    clearTimeout(run.stopTimer);
    for (const req of [...perms.values()]) if (req.run === run) req.finish('cancel');
    if (task === run) task = null;

    let sessionId = run.sessionId || (run.threadId ? ctx.core.sessionOf?.(run.threadId) : null) || run.resume || null;
    if (sessionId) ctx.emit('tg:session', { sessionId });

    // Remember the chat so the next message continues it (unless the user picked something else meanwhile).
    let title = run.resume && st.chat?.sessionId === run.resume ? st.chat.title : '';
    if (sessionId) {
      const info = (await sessions()).find((s) => s.sessionId === sessionId);
      title = oneLine(info?.title) || title || clip(oneLine(run.prompt), 50);
      if (run.version === selVersion) {
        if (!run.resume && !st.chat) st.chat = { sessionId, title: clip(title, 80), cwd: run.cwd, provider: run.agent };
        else if (st.chat?.sessionId === run.resume) Object.assign(st.chat, { sessionId, title: clip(title, 80) });
        save();
      }
    }
    emitUpdate();

    const durationMs = r?.durationMs || Date.now() - run.startedAt;
    const kind = run.cancelled ? 'stopped' : error || r?.isError ? 'failed' : 'done';
    const infoRef = ref({ run: run.id });
    finished.set(infoRef, {
      sessionId,
      title,
      cwd: run.cwd,
      mode: run.mode,
      model: run.model,
      durationMs,
      costUsd: r?.costUsd || 0,
      steps: run.steps,
      log: run.log.slice(),
    });
    if (finished.size > RUNS_MAX) finished.delete(finished.keys().next().value);

    const summary = t(`telegram.summary_${kind}`, {
      time: esc(formatDuration(durationMs)),
      steps: esc(t('telegram.steps', { count: run.steps })),
      chat: title ? t('telegram.summaryChat', { title: quoted(clip(title, 50)) }) : '',
    });
    const markup = ikb([...(sessionId ? [btn(t('telegram.btnContinue'), `rc:${infoRef}`)] : []), btn(t('telegram.btnNewChatShort'), 'n:k'), btn(t('telegram.btnDetails'), `rd:${infoRef}`)]);
    await run.editing;
    let shown = false;
    if (run.msgId) shown = await edit(run.msgId, summary, markup).catch(() => false);
    if (!shown) await send(summary, { reply_markup: markup });

    if (run.cancelled) return;
    const body = error ? t('telegram.errorBody', { error: error?.message ?? error }) : (r?.isError ? '❌ ' : '') + (String(r?.text ?? '').trim() || t('telegram.emptyAnswer'));
    try {
      await deliverAnswer(body);
    } catch (e) {
      log('failed to deliver answer:', e.message);
    }
  }

  async function deliverAnswer(body) {
    const chunks = toTelegramChunks(body, MSG_LIMIT);
    if (body.length <= LONG_ANSWER || chunks.length < 2) {
      for (const c of chunks) await sendChunk(c);
      return;
    }
    await sendChunk(chunks[0]);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    try {
      await sendDocument(body, `answer-${stamp}.md`, t('telegram.fullAnswerAttached'));
    } catch (e) {
      log('sendDocument failed, sending the rest as messages:', e.message);
      for (const c of chunks.slice(1)) await sendChunk(c);
    }
  }

  /** Interrupts the chat's turn; the result event (or a fallback) then finishes the run as "stopped". */
  function stopRun(run) {
    if (!run.threadId || run.completing) return;
    Promise.resolve()
      .then(() => ctx.core.interrupt(run.threadId))
      .catch((e) => log('interrupt failed:', e?.message ?? e));
    run.stopTimer = setTimeout(() => complete(run, null, null), 15000);
    run.stopTimer.unref?.();
  }

  function stopTask() {
    if (!task) return false;
    const run = task;
    run.cancelled = true;
    clearInterval(run.typing);
    clearInterval(run.ticker);
    for (const req of [...perms.values()]) if (req.run === run) req.finish('cancel');
    task = null;
    emitUpdate();
    stopRun(run);
    if (run.msgId) run.editing = run.editing.then(() => edit(run.msgId, t('telegram.stopping')).catch(() => {}));
    return true;
  }

  // ---------- files ----------
  const safeName = (name) =>
    clip(
      String(name || 'file')
        .replace(/[^\w.-]+/g, '_')
        .replace(/^[._]+/, '') || 'file',
      80,
    );

  /** A photo or document: saved into <cwd>/.claude-desk-uploads/ and passed to Claude as @path. */
  async function handleFile(msg) {
    if (task) return busyReply();
    let fileId;
    let name;
    let size = 0;
    if (Array.isArray(msg.photo) && msg.photo.length) {
      const area = (p) => p.file_size ?? (p.width ?? 0) * (p.height ?? 0);
      const fits = msg.photo.filter((p) => !p.file_size || p.file_size <= UPLOAD_MAX);
      const best = (fits.length ? fits : msg.photo).reduce((a, b) => (area(b) > area(a) ? b : a));
      fileId = best.file_id;
      size = best.file_size ?? 0;
      name = `photo-${msg.message_id ?? Date.now()}.jpg`;
    } else {
      fileId = msg.document.file_id;
      size = msg.document.file_size ?? 0;
      name = msg.document.file_name || `file-${msg.message_id ?? Date.now()}`;
    }
    if (size > UPLOAD_MAX) return send(t('telegram.fileTooBig'));
    const where = resolveWhere();
    if (where.error) return whereError(where);
    let rel;
    try {
      const info = await api('getFile', { file_id: fileId });
      if (!info?.file_path) throw new Error('no file_path');
      if (info.file_size && info.file_size > UPLOAD_MAX) return send(t('telegram.fileTooBig'));
      const res = await fetch(`${API}/file/bot${cfg.token}/${info.file_path}`, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > UPLOAD_MAX) return send(t('telegram.fileTooBig'));
      const dir = path.join(where.cwd, UPLOAD_DIR);
      fs.mkdirSync(dir, { recursive: true });
      let fname = safeName(name);
      if (fs.existsSync(path.join(dir, fname))) fname = `${Date.now().toString(36)}-${fname}`;
      fs.writeFileSync(path.join(dir, fname), buf);
      rel = `${UPLOAD_DIR}/${fname}`;
    } catch (e) {
      return send(t('telegram.uploadFailed', { error: esc(hideToken(e?.message ?? e)) }));
    }
    const caption = String(msg.caption ?? '').trim() || t('telegram.fileDefaultPrompt');
    return startTask(`${caption}\n\n@${rel}`, where);
  }

  // ---------- callbacks ----------
  async function onCallback(cq) {
    let answered = false;
    const ack = (text, alert) => {
      if (answered) return;
      answered = true;
      return answerCb(cq, text, alert);
    };
    // Unknown ids (bot restarted, list rotated) or an inaccessible message: say so and send a fresh menu.
    const outdated = async () => {
      await ack(t('telegram.toastOutdated'));
      const card = homeCard();
      await send(card.text, { reply_markup: card.markup });
    };
    const busyGuard = () => {
      if (!task) return false;
      ack(t('telegram.toastBusy'));
      return true;
    };
    // Messages older than 48 h arrive as InaccessibleMessage (date 0) and can't be edited.
    if (!cq.message || !cq.message.date) return outdated();
    const [action, a1, a2] = String(cq.data ?? '').split(':');
    try {
      switch (action) {
        case 'x':
          return ack();
        case 'h':
          ack();
          return show(homeCard(), cq);
        case 'pl':
          ack();
          return show(await projectsCard(Number(a1) || 0), cq);
        case 'p': {
          const value = refs.get(a1);
          if (!value || !(value.id || value.folder)) return outdated();
          if (busyGuard()) return;
          st.project = value.id ? { id: value.id } : { folder: value.folder };
          st.chat = null;
          selectionChanged();
          const proj = currentProject();
          if (!proj) return outdated();
          ack(t('telegram.toastProject', { name: clip(proj.name, 60) }));
          return show(projectCard(proj, Number(a2) || 0), cq);
        }
        case 'cl':
          ack();
          return show(await chatsCard(Number(a1) || 0), cq);
        case 'cs':
          st.chatsScope = st.chatsScope === 'all' ? 'project' : 'all';
          save();
          ack();
          return show(await chatsCard(0), cq);
        case 'c': {
          if (!SESSION_RE.test(a1 ?? '')) return outdated();
          ack();
          const c = (await sessions()).find((s) => s.sessionId === a1);
          if (!c) return outdated();
          return show(await chatCard(c, Number(a2) || 0), cq);
        }
        case 'cc':
        case 'sc':
        case 'ss': {
          // cc: "Continue here" in a chat card; sc/ss: "Continue" under a scheduled-task notification.
          if (!SESSION_RE.test(a1 ?? '')) return outdated();
          if (busyGuard()) return;
          const c = (await sessions()).find((s) => s.sessionId === a1);
          if (!c) return outdated();
          selectChat(c);
          ack(t('telegram.toastContinue'));
          const text = t('telegram.continuingChat', { title: esc(clip(oneLine(c.title) || t('telegram.untitledCap'), 80)) });
          if (action !== 'cc') return send(text);
          return show({ text, markup: ikb([backBtn('cl:0')]) }, cq);
        }
        case 'n': {
          if (busyGuard()) return;
          const text = newChat();
          ack(text);
          if (a1 === 'k') return; // under a run summary: keep that message as it is
          return show(homeCard(), cq);
        }
        case 'set':
          ack();
          return show(settingsCard(), cq);
        case 'mo':
          if (!MODES[a1]) return outdated();
          if (a1 === 'full' && st.mode !== 'full' && a2 !== 'y') {
            ack();
            return show(fullConfirmCard(), cq);
          }
          st.mode = a1;
          save();
          emitUpdate();
          ack(t('telegram.toastMode', { label: modeLabel(a1) }));
          return show(settingsCard(), cq);
        case 'ag':
          if (!ctx.core.registry.has(a1)) return outdated();
          st.agent = a1;
          save();
          emitUpdate();
          ack(t('telegram.toastAgent', { label: agentLabel(a1) }));
          return show(settingsCard(), cq);
        case 'md':
          if (!Object.hasOwn(MODELS, a1 ?? '')) return outdated();
          st.model = a1;
          save();
          emitUpdate();
          ack(t('telegram.toastModel', { label: modelLabel(a1) }));
          return show(settingsCard(), cq);
        case 'nt':
          st.notify = !st.notify;
          save();
          ack(t(st.notify ? 'telegram.toastNotifyOn' : 'telegram.toastNotifyOff'));
          return show(settingsCard(), cq);
        case 'st':
          ack();
          return show(statusCard(), cq);
        case 'stop':
          if (!task || task.id !== a1) return ack(t('telegram.toastFinished'));
          stopTask();
          return ack(t('telegram.toastStopping'));
        case 'pa': {
          const req = perms.get(a1);
          if (!req) {
            await ack(t('telegram.toastOutdated'));
            return edit(cq.message.message_id, `${t('telegram.permTitle')}\n${t('telegram.permExpired')}`).catch(() => {});
          }
          const kind = a2 === 'a' ? 'allow' : a2 === 's' ? 'always' : 'deny';
          const result = req.finish(kind);
          return ack(t(result === 'elsewhere' ? 'telegram.toastElsewhere' : `telegram.toast_${kind}`));
        }
        case 'rc': {
          const info = finished.get(a1);
          if (!info?.sessionId) return outdated();
          if (busyGuard()) return;
          selectChat({ sessionId: info.sessionId, title: info.title, cwd: info.cwd });
          return ack(t('telegram.toastContinue'));
        }
        case 'rd': {
          const info = finished.get(a1);
          if (!info) return outdated();
          ack();
          return send(detailsText(info));
        }
        default:
          return outdated();
      }
    } catch (e) {
      log('callback failed:', e?.message ?? e);
      ack(t('telegram.toastError'));
    } finally {
      ack();
    }
  }

  function detailsText(info) {
    const lines = [t('telegram.detailsTitle'), ''];
    lines.push(t('telegram.detailsTime', { time: esc(formatDuration(info.durationMs)), steps: esc(t('telegram.steps', { count: info.steps })) }));
    if (info.costUsd) lines.push(t('telegram.detailsCost', { cost: info.costUsd.toFixed(info.costUsd < 1 ? 3 : 2) }));
    lines.push(t('telegram.detailsFolder', { path: code(info.cwd) }));
    lines.push(t('telegram.ctxMode', { value: `${MODES[info.mode].icon} ${esc(modeLabel(info.mode))}` }) + ' · ' + esc(modelLabel(info.model)));
    if (info.title) lines.push(t('telegram.ctxChat', { value: quoted(info.title) }));
    if (info.sessionId) lines.push(t('telegram.detailsSession', { id: code(info.sessionId) }));
    const head = lines.join('\n');
    if (!info.log.length) return head;
    const skipped = info.steps - info.log.length;
    const steps = info.log.map((l, i) => `${skipped + i + 1}. ${l}`);
    if (skipped > 0) steps.unshift(esc(t('telegram.detailsSkipped', { count: skipped })));
    let text = `${head}\n\n${t('telegram.detailsSteps')}\n${steps.join('\n')}`;
    while (text.length > MSG_LIMIT && steps.length > 1) {
      steps.splice(skipped > 0 ? 1 : 0, 1);
      text = `${head}\n\n${t('telegram.detailsSteps')}\n${steps.join('\n')}`;
    }
    return text;
  }

  // ---------- updates ----------
  function allowed(chat, from, what) {
    // SECURITY: only the configured private chat (the user's own account) may control the app.
    if (isConfigured() && chat === cfg.chatId && from === cfg.chatId) return true;
    const key = `${chat}/${from}`;
    if (!warned.has(key)) {
      warned.add(key);
      log(`ignoring ${what} from a foreign chat ${chat} (user ${from})`);
    }
    return false;
  }

  async function handleUpdate(u) {
    if (u?.callback_query) {
      const cq = u.callback_query;
      const from = String(cq.from?.id ?? '');
      const chat = String(cq.message?.chat?.id ?? '');
      if (!allowed(chat, from, 'a button press')) return;
      return onCallback(cq);
    }
    const msg = u?.message;
    if (!msg) return;
    if (!allowed(String(msg.chat?.id ?? ''), String(msg.from?.id ?? ''), 'a message')) return;
    if (msg.date && onlineSince && msg.date < onlineSince - STALE_S) return; // sent long before the bot came online

    if (typeof msg.text !== 'string') {
      if ((Array.isArray(msg.photo) && msg.photo.length) || msg.document?.file_id) return handleFile(msg);
      if (msg.voice || msg.audio || msg.video_note) return send(t('telegram.voiceUnsupported'));
      return send(t('telegram.unsupported'));
    }
    const text = msg.text.trim();
    if (!text) return;

    const action = menuAction(text); // a main-menu button is never sent to Claude as a task
    if (action) return menu(action);

    const m = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
    if (!m) {
      startTask(text); // runs in the background so buttons and /stop keep working
      return;
    }
    switch (m[1].toLowerCase()) {
      case 'start':
        return sendWelcome(false);
      case 'menu':
        return sendWelcome(true);
      case 'help':
        return send(t('telegram.help'), { reply_markup: mainKeyboard() });
      case 'projects':
      case 'project':
        return menu('projects');
      case 'chats':
      case 'chat':
        return menu('chats');
      case 'new':
        return menu('new');
      case 'settings':
      case 'mode':
      case 'model':
        return menu('settings');
      case 'status':
        return menu('status');
      case 'stop':
        return send(stopTask() ? t('telegram.stopped') : t('telegram.nothingRunning'));
      default:
        return send(t('telegram.unknownCommand'));
    }
  }

  async function menu(action) {
    let card;
    switch (action) {
      case 'projects':
        card = await projectsCard(0);
        break;
      case 'chats':
        card = await chatsCard(0);
        break;
      case 'new':
        if (task) return busyReply();
        card = { text: esc(newChat()), markup: ikb([btn(t('telegram.btnChooseProject'), 'pl:0'), btn(t('telegram.btnChooseChat'), 'cl:0')]) };
        break;
      case 'settings':
        card = settingsCard();
        break;
      default:
        card = statusCard();
    }
    return send(card.text, { reply_markup: card.markup });
  }

  // ---------- bot profile: commands, menu button, descriptions ----------
  let profileBusy = false;
  async function applyProfile(signal) {
    if (profileBusy) return;
    const commands = botCommands();
    const description = clip(t('telegram.botDescription'), 512);
    const short = clip(t('telegram.botShortDescription'), 120);
    const hash = crypto
      .createHash('sha1')
      .update(JSON.stringify([st.botId, i18n.getLanguage?.(), commands, description, short, 'menu:commands']))
      .digest('hex')
      .slice(0, 16);
    if (st.profileHash === hash) return; // these methods are rate limited: call them only when something changed
    profileBusy = true;
    try {
      await api('setMyCommands', { commands }, { signal });
      await api('setChatMenuButton', { menu_button: { type: 'commands' } }, { signal });
      await api('setMyDescription', { description }, { signal });
      await api('setMyShortDescription', { short_description: short }, { signal });
      st.profileHash = hash;
      save();
    } catch (e) {
      if (!e.aborted) log('bot profile update failed:', e.message);
    } finally {
      profileBusy = false;
    }
  }

  // ---------- polling loop ----------
  async function loop(gen, signal) {
    let backoff = BACKOFF_MIN;
    while (gen === loopGen) {
      try {
        if (!botName) {
          const me = await api('getMe', {}, { signal });
          if (gen !== loopGen) break;
          botName = String(me?.username ?? '');
          emitUpdate();
          applyProfile(signal);
        }
        const updates = await api(
          'getUpdates',
          { ...(st.offset ? { offset: st.offset } : {}), timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
          { signal, timeoutMs: (POLL_TIMEOUT_S + 15) * 1000, retry: false },
        );
        if (gen !== loopGen) break;
        backoff = BACKOFF_MIN;
        if (lastError) {
          lastError = '';
          emitUpdate();
        }
        for (const u of Array.isArray(updates) ? updates : []) {
          if (gen !== loopGen) break;
          // Advance first: a command is never executed twice, even if handling it crashes.
          if (Number.isInteger(u?.update_id)) st.offset = Math.max(st.offset, u.update_id + 1);
          save();
          try {
            await handleUpdate(u);
          } catch (e) {
            console.error('[telegram] update failed', e);
          }
        }
      } catch (e) {
        if (gen !== loopGen || e.aborted) break;
        if (lastError !== e.message) {
          lastError = e.message;
          log('poll error:', e.message);
          emitUpdate();
        }
        const wait = e.status === 429 && e.retryAfter ? e.retryAfter * 1000 : e.status === 401 || e.status === 404 ? BACKOFF_MAX : backoff;
        await sleep(wait, signal);
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
      }
    }
  }

  function stopLoop() {
    loopGen++;
    pollAbort?.abort();
    pollAbort = null;
    loopKey = '';
    if (polling) {
      polling = false;
      emitUpdate();
    }
  }

  /** Starts, restarts or stops the loop to match the toggle and the bot settings. */
  function sync() {
    const want = st.enabled && isConfigured();
    const key = `${cfg.token}\n${cfg.chatId}`;
    if (want && polling && key === loopKey) return;
    stopLoop();
    if (!want) {
      lastError = '';
      emitUpdate();
      return;
    }
    const botId = cfg.token.split(':')[0];
    if (st.botId !== botId) {
      st.botId = botId; // a different bot: its update ids start over
      st.offset = 0;
      save();
    }
    loopKey = key;
    botName = '';
    lastError = '';
    polling = true;
    onlineSince = Math.floor(Date.now() / 1000);
    pollAbort = new AbortController();
    const gen = ++loopGen;
    emitUpdate();
    loop(gen, pollAbort.signal)
      .catch((e) => console.error('[telegram] loop crashed', e))
      .finally(() => {
        if (gen === loopGen && polling) {
          polling = false;
          emitUpdate();
        }
      });
  }

  // ---------- IPC ----------
  ctx.handle('tg:status', () => status());

  ctx.handle('tg:setEnabled', async (enabled) => {
    const on = Boolean(enabled);
    if (on && !isConfigured()) throw new Error(configProblem());
    const was = st.enabled;
    st.enabled = on;
    save();
    sync();
    if (on && !was) send(t('telegram.enabled'), { reply_markup: mainKeyboard() });
    return status();
  });

  // ---------- scheduler integration ----------
  // Scheduled-task results can be muted from the bot settings (Notifications).
  sched.setTelegramNotifyGate?.(() => st.notify);
  // While the bot listens, a scheduled-task result gets a "Continue" button that selects its chat here.
  const offNotifyMarkup =
    sched.setTelegramNotifyMarkup?.((sessionId) =>
      st.enabled && polling && SESSION_RE.test(String(sessionId ?? '')) ? ikb([btn(t('telegram.btnContinue'), `sc:${sessionId}`)]) : null,
    ) ?? (() => {});

  // ---------- lifecycle ----------
  const offConfig = sched.onTelegramConfig((c) => {
    if (c) cfg = c;
    sync();
  });
  // The bot speaks the UI language: re-apply commands and descriptions when it changes.
  const offLang = onLanguage(() => {
    if (polling && botName) applyProfile(pollAbort?.signal);
    emitUpdate();
  });
  ctx.app?.on?.('before-quit', stopLoop);
  const ready = ctx.app?.whenReady?.();
  if (ready) ready.then(sync);
  else sync();

  return {
    status,
    sync,
    handleUpdate,
    stop: () => {
      offConfig();
      offLang();
      offNotifyMarkup();
      sched.setTelegramNotifyGate?.(null);
      stopLoop();
    },
    idle: () => task?.promise ?? Promise.resolve(),
    state: () => st,
  };
}

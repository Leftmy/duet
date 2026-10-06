// Remote control of Claude Desk from Telegram: a long-polling bot that obeys only the configured
// private chat (the user's own account) and runs Claude Code tasks in the user's projects.
// The bot token and chat id are shared with the scheduler (schedules.json → settings).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { telegramConfig, onTelegramConfig } from './scheduler.mjs';
import { t, locale, onLanguage } from '../i18n.mjs';

const API = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 50;
const MSG_LIMIT = 3900;
const TYPING_MS = 4500;
const STALE_S = 120; // messages sent this long before the bot came online are dropped, not executed
const BACKOFF_MIN = 2000;
const BACKOFF_MAX = 60000;
const CHATS_LIMIT = 10;
const FOLDERS_LIMIT = 8;

// Labels and hints are looked up lazily so they follow the UI language.
const MODES = {
  ask: { perm: 'default', labelKey: 'telegram.modeAsk', hintKey: 'telegram.modeAskHint' },
  edits: { perm: 'acceptEdits', labelKey: 'telegram.modeEdits', hintKey: 'telegram.modeEditsHint' },
  full: { perm: 'bypassPermissions', labelKey: 'telegram.modeFull', hintKey: 'telegram.modeFullHint' },
};
const modeLabel = (key) => t(MODES[key].labelKey);
const modeHint = (key) => t(MODES[key].hintKey);

const COMMAND_KEYS = [
  ['projects', 'telegram.cmdProjects'],
  ['project', 'telegram.cmdProject'],
  ['chats', 'telegram.cmdChats'],
  ['chat', 'telegram.cmdChat'],
  ['new', 'telegram.cmdNew'],
  ['mode', 'telegram.cmdMode'],
  ['status', 'telegram.cmdStatus'],
  ['stop', 'telegram.cmdStop'],
  ['help', 'telegram.cmdHelp'],
];
const botCommands = () => COMMAND_KEYS.map(([command, key]) => ({ command, description: t(key) }));

// ---------- small helpers ----------

const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
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

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// ---------- markdown → Telegram HTML chunks ----------

/** One line of markdown prose → Telegram HTML (inline `code`, **bold**, # headings). */
function inlineHtml(line) {
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
  if (heading) return `<b>${escapeHtml(heading[1].replace(/\*\*|`/g, ''))}</b>`;
  return line
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : escapeHtml(part).replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')))
    .join('');
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
 * Converts a markdown answer into Telegram messages of at most `limit` characters each.
 * Every chunk has balanced HTML (`html`) plus the raw source (`plain`) to resend if Telegram rejects the markup.
 */
export function toTelegramChunks(md, limit = MSG_LIMIT, footer = '') {
  const units = [];
  for (const b of parseBlocks(md)) {
    if (b.type === 'text') {
      for (const line of b.lines) {
        const parts = line.length ? hardSplit(line, (x) => inlineHtml(x).length <= limit) : [''];
        for (const part of parts) units.push({ html: inlineHtml(part), plain: part });
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
        units.push({ html: open + escapeHtml(body) + close, plain: '```' + b.lang + '\n' + body + '\n```' });
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
  if (footer) units.push({ html: '', plain: '' }, { html: `<i>${escapeHtml(footer)}</i>`, plain: footer });

  const chunks = [];
  let cur = null;
  for (const u of units) {
    if (cur && cur.html.length + 1 + u.html.length > limit) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) cur = { html: u.html, plain: u.plain };
    else {
      cur.html += '\n' + u.html;
      cur.plain += '\n' + u.plain;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => ({ html: c.html.trim(), plain: c.plain.trim() })).filter((c) => c.html && c.plain);
}

// ---------- feature ----------

export function register(ctx) {
  const file = path.join(ctx.userData, 'telegram.json');
  const log = (...a) => console.log('[telegram]', ...a);

  // Persisted: on/off, getUpdates offset (per bot), current project / chat / permission mode.
  let st = { enabled: false, offset: 0, botId: '', project: null, chat: null, mode: 'edits' };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    st = {
      enabled: Boolean(raw?.enabled),
      offset: Number.isInteger(raw?.offset) ? raw.offset : 0,
      botId: String(raw?.botId ?? ''),
      project: raw?.project?.id ? { id: String(raw.project.id) } : raw?.project?.folder ? { folder: String(raw.project.folder) } : null,
      chat: raw?.chat?.sessionId ? { sessionId: String(raw.chat.sessionId), title: String(raw.chat.title ?? ''), cwd: String(raw.chat.cwd ?? '') } : null,
      mode: MODES[raw?.mode] ? raw.mode : 'edits',
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
  let cfg = telegramConfig() ?? readSchedulerFile();
  // Remote control only works for a private chat with the user: its id is a positive number equal to the user id.
  const isConfigured = () => Boolean(cfg.token) && /^\d+$/.test(cfg.chatId);
  const configProblem = () => {
    if (!cfg.token || !cfg.chatId) return t('telegram.needConfig');
    if (!/^\d+$/.test(cfg.chatId)) return t('telegram.needPrivateChat');
    return '';
  };

  // ---------- runtime state ----------
  let polling = false;
  let loopGen = 0;
  let loopKey = '';
  let pollAbort = null;
  let botName = '';
  let lastError = '';
  let onlineSince = 0; // unix seconds
  let task = null; // { startedAt, prompt, abort, cancelled, typing, promise }
  let selVersion = 0; // bumps on every project / chat selection change
  const warned = new Set();
  const lists = { projects: [], chats: [] };

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
      current: { project: proj?.name ?? null, chat: st.chat ? st.chat.title || t('telegram.untitled') : null, mode: st.mode },
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

  async function api(method, params = {}, { signal, timeoutMs = 20000 } = {}) {
    const token = cfg.token;
    if (!token) throw new Error(t('telegram.noToken'));
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetch(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      const err = new Error(signal?.aborted ? 'aborted' : t('telegram.network', { error: String(e?.message ?? e).split(token).join('***') }));
      err.aborted = Boolean(signal?.aborted);
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.ok) return data.result;
    const code = Number(data?.error_code ?? res.status);
    const err = new Error(describe(code, data?.description));
    err.status = code;
    err.retryAfter = Number(data?.parameters?.retry_after) || 0;
    throw err;
  }

  async function sendRaw(params) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api('sendMessage', { chat_id: cfg.chatId, disable_web_page_preview: true, ...params });
      } catch (e) {
        if (e.status === 429 && attempt < 2) {
          await sleep(Math.min(30, e.retryAfter || 3) * 1000);
          continue;
        }
        throw e;
      }
    }
  }
  const reply = (text) => sendRaw({ text: clip(text, 4000) }).catch((e) => log('send failed:', e.message));
  async function sendChunk({ html, plain }) {
    try {
      await sendRaw({ text: html, parse_mode: 'HTML' });
    } catch (e) {
      if (e.status !== 400) throw e;
      await sendRaw({ text: plain }); // Telegram rejected the markup: resend as plain text
    }
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
    return cwd ? projects.find((p) => p.folders.some((f) => sameDir(f, cwd)))?.id ?? null : null;
  }

  function currentProject() {
    const p = st.project;
    if (p?.id) return uiProjects(readUi()).find((x) => x.id === p.id) ?? null;
    if (p?.folder) return { kind: 'folder', folder: p.folder, name: baseName(p.folder), folders: [p.folder] };
    return null;
  }

  async function sessions() {
    try {
      const list = (await ctx.bridge.listSessions()) ?? [];
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
    const all = (await sessions()).filter((s) => s.sessionId && !archived.has(s.sessionId));
    const mine = !proj
      ? all
      : proj.kind === 'project'
        ? all.filter((s) => projectIdOf(ui, projects, s.sessionId, s.cwd) === proj.id)
        : all.filter((s) => sameDir(s.cwd, proj.folder));
    return { proj, chats: mine.slice(0, CHATS_LIMIT) };
  }

  const selectionChanged = () => {
    selVersion++;
    save();
    emitUpdate();
  };

  // ---------- commands ----------
  async function cmdProjects() {
    lists.projects = await buildProjectList();
    if (!lists.projects.length) return reply(t('telegram.noProjects'));
    const cur = currentProject();
    const isCur = (p) => cur && (p.kind === 'project' ? cur.id === p.id : cur.kind === 'folder' && sameDir(cur.folder, p.folder));
    const lines = [];
    lists.projects.forEach((p, i) => {
      if (i === 0 && p.kind === 'project') lines.push(t('telegram.projectsHeader'));
      if (p.kind === 'folder' && (i === 0 || lists.projects[i - 1].kind === 'project')) lines.push((i ? '\n' : '') + t('telegram.recentFolders'));
      const extra = p.folders.length > 1 ? ` (+${p.folders.length - 1})` : '';
      lines.push(`${i + 1}. ${clip(p.name, 40)} — ${clip(p.folders[0] ?? '', 60)}${extra}${isCur(p) ? t('telegram.currentMark') : ''}`);
    });
    lines.push('', t('telegram.pickProject'));
    return reply(lines.join('\n'));
  }

  async function cmdProject(arg) {
    if (!arg) {
      const cur = currentProject();
      return reply(cur ? t('telegram.currentProject', { name: cur.name, folder: cur.folders[0] }) : t('telegram.noProjectSelected'));
    }
    if (!lists.projects.length) lists.projects = await buildProjectList();
    let pick = null;
    if (/^\d+$/.test(arg)) pick = lists.projects[Number(arg) - 1] ?? null;
    else {
      const q = arg.toLowerCase();
      pick =
        lists.projects.find((p) => p.name.toLowerCase() === q) ??
        lists.projects.find((p) => p.name.toLowerCase().includes(q)) ??
        lists.projects.find((p) => p.folders.some((f) => baseName(f).toLowerCase().includes(q))) ??
        null;
    }
    if (!pick) return reply(t('telegram.projectNotFound'));
    st.project = pick.kind === 'project' ? { id: pick.id } : { folder: pick.folder };
    st.chat = null;
    lists.chats = [];
    selectionChanged();
    return reply(t('telegram.projectPicked', { name: pick.name, folder: pick.folders[0] }));
  }

  async function cmdChats() {
    const { proj, chats } = await buildChatList();
    lists.chats = chats;
    const where = proj ? t('telegram.whereProject', { name: proj.name }) : t('telegram.whereAll');
    if (!chats.length) return reply(t('telegram.noChats', { where }));
    const lines = [t('telegram.chatsHeader', { where })];
    chats.forEach((c, i) => {
      const when = ago(c.lastModified);
      lines.push(`${i + 1}. ${clip(oneLine(c.title) || t('telegram.untitledCap'), 60)}${when ? ` — ${when}` : ''}${st.chat?.sessionId === c.sessionId ? '  ◀' : ''}`);
    });
    lines.push('', t('telegram.chatsFooter'));
    return reply(lines.join('\n'));
  }

  async function cmdChat(arg) {
    if (!arg) return reply(st.chat ? t('telegram.currentChat', { title: st.chat.title || t('telegram.untitled') }) : t('telegram.nextNewChat'));
    if (!/^\d+$/.test(arg)) return reply(t('telegram.chatNumberRequired'));
    if (!lists.chats.length) lists.chats = (await buildChatList()).chats;
    const c = lists.chats[Number(arg) - 1];
    if (!c) return reply(t('telegram.noSuchChat'));
    st.chat = { sessionId: c.sessionId, title: clip(oneLine(c.title), 80), cwd: c.cwd || '' };
    selectionChanged();
    return reply(t('telegram.continuingChat', { title: st.chat.title || t('telegram.untitled') }));
  }

  function cmdNew() {
    st.chat = null;
    selectionChanged();
    const proj = currentProject();
    return reply(proj ? t('telegram.newChatIn', { name: proj.name }) : t('telegram.newChat'));
  }

  function cmdMode(arg) {
    const key = arg.toLowerCase();
    if (!MODES[key]) {
      return reply(t('telegram.modeInfo', { label: modeLabel(st.mode), mode: st.mode, hint: modeHint(st.mode) }));
    }
    st.mode = key;
    save();
    emitUpdate();
    return reply(t('telegram.modeSet', { label: modeLabel(key), hint: modeHint(key) }));
  }

  function cmdStatus() {
    const proj = currentProject();
    const lines = [
      t('telegram.statusProject', { value: proj ? t('telegram.projectValue', { name: proj.name, folder: proj.folders[0] }) : t('telegram.projectNone') }),
      t('telegram.statusChat', { value: st.chat ? t('telegram.chatValue', { title: st.chat.title || t('telegram.untitled') }) : t('telegram.chatNew') }),
      t('telegram.statusMode', { label: modeLabel(st.mode) }),
      task ? t('telegram.statusBusy', { time: formatDuration(Date.now() - task.startedAt), prompt: clip(oneLine(task.prompt), 60) }) : t('telegram.statusIdle'),
    ];
    return reply(lines.join('\n'));
  }

  function cmdStop() {
    if (!task) return reply(t('telegram.nothingRunning'));
    const run = task;
    run.cancelled = true;
    clearInterval(run.typing);
    try {
      run.abort.abort();
    } catch {}
    task = null;
    emitUpdate();
    return reply(t('telegram.stopped'));
  }

  // ---------- running prompts ----------
  function runPrompt(text) {
    if (task) return reply(t('telegram.alreadyBusy'));
    const ui = readUi();
    const proj = currentProject();
    let cwd;
    let dirs = [];
    let resume;
    if (st.chat?.sessionId) {
      resume = st.chat.sessionId;
      cwd = st.chat.cwd || proj?.folders[0] || ui.cwd || os.homedir();
      const projects = uiProjects(ui);
      const ownerId = projectIdOf(ui, projects, resume, cwd);
      const owner = projects.find((p) => p.id === ownerId);
      dirs = owner ? owner.folders.filter((f) => !sameDir(f, cwd)) : [];
    } else {
      cwd = proj?.folders[0] || ui.cwd || os.homedir();
      dirs = proj ? proj.folders.slice(1) : [];
    }
    if (!isDir(cwd)) return reply(t('telegram.folderNotFound', { path: cwd }));
    dirs = dirs.filter(isDir);

    const run = { startedAt: Date.now(), prompt: text, abort: new AbortController(), cancelled: false, typing: null, promise: null };
    task = run;
    emitUpdate();
    run.promise = execute(run, { cwd, dirs, resume, version: selVersion }).catch((e) => console.error('[telegram] run failed', e));
    return run.promise;
  }

  async function execute(run, { cwd, dirs, resume, version }) {
    await reply(t('telegram.working'));
    const typing = () => !run.cancelled && api('sendChatAction', { chat_id: cfg.chatId, action: 'typing' }).catch(() => {});
    typing();
    run.typing = setInterval(typing, TYPING_MS);
    run.typing.unref?.();

    let r = null;
    let error = null;
    try {
      r = await ctx.bridge.runHeadless({
        prompt: run.prompt,
        cwd,
        ...(dirs.length ? { dirs } : {}),
        ...(resume ? { resume } : {}),
        permissionMode: MODES[st.mode].perm,
        abortController: run.abort, // honoured once runHeadless forwards it to query()
      });
    } catch (e) {
      error = e;
    }
    clearInterval(run.typing);
    if (task === run) task = null;

    const sessionId = r?.sessionId || resume || null;
    if (sessionId) ctx.emit('tg:session', { sessionId });
    if (run.cancelled) return emitUpdate();

    // Remember the chat so the next message continues it (unless the user picked something else meanwhile).
    let title = resume && st.chat?.sessionId === resume ? st.chat.title : '';
    if (sessionId) {
      const info = (await sessions()).find((s) => s.sessionId === sessionId);
      title = oneLine(info?.title) || title || clip(oneLine(run.prompt), 50);
      if (version === selVersion) {
        if (!resume && !st.chat) st.chat = { sessionId, title: clip(title, 80), cwd };
        else if (st.chat?.sessionId === resume) Object.assign(st.chat, { sessionId, title: clip(title, 80) });
        save();
      }
    }
    emitUpdate();

    const footer = `⏱ ${formatDuration(r?.durationMs || Date.now() - run.startedAt)}${title ? t('telegram.footerChat', { title: clip(title, 50) }) : ''}`;
    const body = error ? t('telegram.errorBody', { error: error?.message ?? error }) : (r?.isError ? '❌ ' : '') + (String(r?.text ?? '').trim() || t('telegram.emptyAnswer'));
    try {
      for (const chunk of toTelegramChunks(body, MSG_LIMIT, footer)) await sendChunk(chunk);
    } catch (e) {
      log('failed to deliver answer:', e.message);
    }
  }

  // ---------- updates ----------
  async function handleUpdate(u) {
    const msg = u?.message;
    if (!msg) return;
    const chat = String(msg.chat?.id ?? '');
    const from = String(msg.from?.id ?? '');
    // SECURITY: only the configured private chat (the user's own account) may control the app.
    if (!isConfigured() || chat !== cfg.chatId || from !== cfg.chatId) {
      const key = `${chat}/${from}`;
      if (!warned.has(key)) {
        warned.add(key);
        log(`ignoring message from a foreign chat ${chat} (user ${from})`);
      }
      return;
    }
    if (msg.date && onlineSince && msg.date < onlineSince - STALE_S) return; // sent long before the bot came online

    if (typeof msg.text !== 'string') {
      if (msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note || msg.sticker || msg.caption) return reply(t('telegram.textOnly'));
      return;
    }
    const text = msg.text.trim();
    if (!text) return;
    const m = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
    if (!m) {
      runPrompt(text); // runs in the background so /stop and /status keep working
      return;
    }
    const arg = (m[2] ?? '').trim();
    switch (m[1].toLowerCase()) {
      case 'start':
      case 'help':
        return reply(t('telegram.help'));
      case 'projects':
        return cmdProjects();
      case 'project':
        return cmdProject(arg);
      case 'chats':
        return cmdChats();
      case 'chat':
        return cmdChat(arg);
      case 'new':
        return cmdNew();
      case 'mode':
        return cmdMode(arg);
      case 'status':
        return cmdStatus();
      case 'stop':
        return cmdStop();
      default:
        return reply(t('telegram.unknownCommand'));
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
          api('setMyCommands', { commands: botCommands() }, { signal }).catch(() => {});
        }
        const updates = await api(
          'getUpdates',
          { ...(st.offset ? { offset: st.offset } : {}), timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
          { signal, timeoutMs: (POLL_TIMEOUT_S + 15) * 1000 },
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
    if (on && !was) reply(t('telegram.enabled'));
    return status();
  });

  // ---------- lifecycle ----------
  const offConfig = onTelegramConfig((c) => {
    if (c) cfg = c;
    sync();
  });
  // The bot speaks the UI language: re-register the command menu when it changes.
  const offLang = onLanguage(() => {
    if (polling && botName) api('setMyCommands', { commands: botCommands() }).catch((e) => log('setMyCommands failed:', e.message));
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
      stopLoop();
    },
    idle: () => task?.promise ?? Promise.resolve(),
    state: () => st,
  };
}

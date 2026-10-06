import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Folder,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Send,
  Trash2,
} from 'lucide-react';
import { useStore } from '../../store';
import { askConfirm } from '../../lib/dialog';
import { Markdown } from '../../components/Markdown';
import { spring } from '../../components/Popover';
import { ALL_EFFORTS, EFFORT_LABEL, basename, duration, modelLabel, timeAgo } from '../../lib/format';
import { locale, t } from '../../i18n';
import type { Effort } from '../../types';
import { TelegramControl } from '../telegram/TelegramControl';
import './schedule.css';

// ---------- types (mirror electron/features/scheduler.mjs) ----------

type SchedPerm = 'acceptEdits' | 'default' | 'bypassPermissions';
type Schedule = { type: 'interval'; minutes: number } | { type: 'daily'; time: string; days: number[] };

interface RunRecord {
  ts: number;
  ok: boolean;
  durationMs: number;
  text: string;
  sessionId: string | null;
  costUsd?: number;
}

interface SchedTask {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  model: string;
  effort: Effort | null;
  permissionMode: SchedPerm;
  schedule: Schedule;
  enabled: boolean;
  notify: { desktop: boolean; telegram: boolean };
  running: boolean;
  queued?: boolean;
  lastRun: number | null;
  nextRun: number | null;
  history: RunRecord[];
}

interface SchedState {
  tasks: SchedTask[];
  settings: { telegramChatId: string; hasToken: boolean };
}

type Draft = Omit<SchedTask, 'id' | 'running' | 'queued' | 'lastRun' | 'nextRun' | 'history' | 'schedule'> & {
  id?: string;
  kind: 'interval' | 'daily';
  minutes: number;
  time: string;
  days: number[];
};

// ---------- helpers ----------

const perms = (): { v: SchedPerm; label: string; hint: string }[] => [
  { v: 'acceptEdits', label: t('schedule.permAcceptEdits'), hint: t('schedule.permAcceptEditsHint') },
  { v: 'default', label: t('schedule.permDefault'), hint: t('schedule.permDefaultHint') },
  { v: 'bypassPermissions', label: t('schedule.permBypass'), hint: t('schedule.permBypassHint') },
];

/** Short weekday name for a JS day number (0 = Sunday), as Intl formats it in the UI locale. */
const dayName = (d: number) => new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(new Date(2024, 0, 7 + d));
const cap = (s: string) => s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1);

// Monday-first order for chips and labels.
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function daysLabel(days: number[]) {
  if (!days.length || days.length === 7) return '';
  const idx = WEEK.map((w, i) => (days.includes(w) ? i : -1)).filter((i) => i >= 0);
  const parts: string[] = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    if (j - i >= 2) parts.push(`${dayName(WEEK[idx[i]])}–${dayName(WEEK[idx[j]])}`);
    else for (let k = i; k <= j; k++) parts.push(dayName(WEEK[idx[k]]));
    i = j + 1;
  }
  return parts.join(', ');
}

function scheduleText(s: Schedule) {
  if (s.type === 'interval') {
    const m = s.minutes;
    if (m < 60) return t('schedule.everyMin', { m });
    if (m === 60) return t('schedule.everyHour');
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (!r && h % 24 === 0) return h === 24 ? t('schedule.oncePerDay') : t('schedule.everyDays', { d: h / 24 });
    return r ? t('schedule.everyHoursMin', { h, m: r }) : t('schedule.everyHours', { h });
  }
  const d = daysLabel(s.days);
  return t('schedule.dailyAt', { time: s.time }) + (d ? ` · ${d}` : '');
}

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function nextText(task: SchedTask, now: number) {
  if (task.running) return t('schedule.running');
  if (task.queued) return t('schedule.queued');
  if (!task.enabled || !task.nextRun) return t('schedule.off');
  const diff = task.nextRun - now;
  if (diff <= 60000) return t('schedule.anyMoment');
  if (diff < 3600000) return t('schedule.inMin', { m: Math.round(diff / 60000) });
  const d = new Date(task.nextRun);
  const today = new Date(now);
  const tomorrow = new Date(now + 86400000);
  const time = hhmm(task.nextRun);
  if (d.toDateString() === today.toDateString()) return t('schedule.todayAt', { time });
  if (d.toDateString() === tomorrow.toDateString()) return t('schedule.tomorrowAt', { time });
  return t('schedule.dateAt', { date: d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' }), time });
}

/** Puts a React node in place of the {link} placeholder of a translated string. */
function withLink(text: string, link: ReactNode) {
  const [before, after = ''] = text.split('{link}');
  return (
    <>
      {before}
      {link}
      {after}
    </>
  );
}

const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function toDraft(t?: SchedTask): Draft {
  return {
    id: t?.id,
    name: t?.name ?? '',
    prompt: t?.prompt ?? '',
    cwd: t?.cwd ?? useStore.getState().settings.cwd ?? '',
    model: t?.model ?? 'default',
    effort: t?.effort ?? null,
    permissionMode: t?.permissionMode ?? 'acceptEdits',
    enabled: t?.enabled ?? true,
    notify: t?.notify ?? { desktop: true, telegram: false },
    kind: t?.schedule.type ?? 'daily',
    minutes: t?.schedule.type === 'interval' ? t.schedule.minutes : 60,
    time: t?.schedule.type === 'daily' ? t.schedule.time : '09:00',
    days: t?.schedule.type === 'daily' ? t.schedule.days : [],
  };
}

// ---------- small controls (same look as Settings) ----------

function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button className={`toggle ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} title={title}>
      <motion.span className="toggle-knob" layout transition={spring} />
    </button>
  );
}

function Segmented<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: { v: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.v} type="button" className={`seg ${value === o.v ? 'is-on' : ''}`} onClick={() => onChange(o.v)}>
          {value === o.v && <motion.span layoutId={id} className="seg-bg" transition={spring} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="sched-field">
      <span className="sched-label">{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

// ---------- section ----------

export function SchedulesSection() {
  const toast = useStore((s) => s.toast);
  const [data, setData] = useState<SchedState | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // task id or 'new'
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    window.desk
      .call<SchedState>('sched:list')
      .then((d) => alive && setData(d))
      .catch((e) => {
        if (!alive) return;
        setData({ tasks: [], settings: { telegramChatId: '', hasToken: false } });
        toast(errText(e), 'error');
      });
    const off = window.desk.subscribe<SchedState>('sched:update', (d) => setData(d));
    const timer = setInterval(() => setNow(Date.now()), 20000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, []);

  const tasks = data?.tasks ?? [];
  const hasToken = data?.settings.hasToken ?? false;

  return (
    <div className="sched">
      <div className="set-head-row">
        <h2>{t('schedule.title')}</h2>
        <button className="btn sched-new" disabled={editing === 'new'} onClick={() => setEditing('new')}>
          <Plus size={13} /> {t('schedule.newTask')}
        </button>
      </div>
      <p className="muted small">{t('schedule.intro')}</p>

      <AnimatePresence initial={false}>
        {editing === 'new' && (
          <TaskForm key="new" draft={toDraft()} hasToken={hasToken} onClose={() => setEditing(null)} />
        )}
      </AnimatePresence>

      {!data ? (
        <div className="skeleton">
          {[80, 60].map((w, i) => (
            <div key={i} className="skeleton-line shimmer-bg" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : tasks.length === 0 && editing !== 'new' ? (
        <div className="sched-empty">
          <CalendarClock size={22} />
          <div>{t('schedule.empty')}</div>
          <div className="muted small">{t('schedule.emptyExample')}</div>
        </div>
      ) : (
        <div className="sched-list">
          <AnimatePresence initial={false}>
            {tasks.map((t) =>
              editing === t.id ? (
                <TaskForm key={`edit-${t.id}`} draft={toDraft(t)} hasToken={hasToken} onClose={() => setEditing(null)} />
              ) : (
                <TaskCard key={t.id} task={t} now={now} onEdit={() => setEditing(t.id)} />
              ),
            )}
          </AnimatePresence>
        </div>
      )}

      <p className="muted small sched-tg-hint">
        <Send size={12} /> {t('schedule.tgMovedHint')}
      </p>
    </div>
  );
}

/** Settings → Telegram: bot token, chat id, test message and remote control. */
export function TelegramSection() {
  const toast = useStore((s) => s.toast);
  const [settings, setSettings] = useState<SchedState['settings'] | null>(null);
  useEffect(() => {
    let alive = true;
    window.desk
      .call<SchedState>('sched:list')
      .then((d) => alive && setSettings(d.settings))
      .catch((e) => toast(errText(e), 'error'));
    const off = window.desk.subscribe<SchedState>('sched:update', (d) => setSettings(d.settings));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return (
    <div className="sched">
      <h2>Telegram</h2>
      <p className="muted small">{t('schedule.tgSectionIntro')}</p>
      {settings && <TelegramBlock settings={settings} />}
    </div>
  );
}

// ---------- task card ----------

function TaskCard({ task, now, onEdit }: { task: SchedTask; now: number; onEdit: () => void }) {
  const toast = useStore((s) => s.toast);
  const models = useStore((s) => s.models);
  const [open, setOpen] = useState(false);
  const last = task.history[0];

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(errText(e), 'error');
    }
  };

  const openChat = (rec: RunRecord) => {
    if (!rec.sessionId) return;
    useStore.getState().openSession({ sessionId: rec.sessionId, title: task.name, cwd: task.cwd, lastModified: rec.ts });
    useStore.setState({ settingsOpen: false });
  };

  const statusWord = (ok: boolean) => (ok ? t('schedule.statusDone') : t('schedule.statusFailed'));

  return (
    <motion.div
      layout="position"
      className={`sched-card ${task.enabled ? '' : 'is-off'}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0, transition: { duration: 0.16 } }}
      transition={spring}
    >
      <div className="sched-card-head">
        <div className="sched-card-title">
          <div className="truncate sched-name">{task.name}</div>
          <div className="muted small sched-meta">
            <span>{scheduleText(task.schedule)}</span>
            <span className="sched-dot">·</span>
            <span className="sched-proj" title={task.cwd}>
              <Folder size={11} /> {basename(task.cwd) || t('schedule.homeFolder')}
            </span>
            {task.model !== 'default' && (
              <>
                <span className="sched-dot">·</span>
                <span>{modelLabel(task.model, models)}</span>
              </>
            )}
          </div>
        </div>
        <Toggle
          on={task.enabled}
          title={task.enabled ? t('schedule.turnOff') : t('schedule.turnOn')}
          onChange={(v) => act(() => window.desk.call('sched:toggle', task.id, v))}
        />
      </div>

      <div className="sched-status small">
        {task.running ? (
          <span className="sched-state is-run">
            <Loader2 size={12} className="spin" /> {t('schedule.runningNow')}
          </span>
        ) : last ? (
          <button className={`sched-state ${last.ok ? 'is-ok' : 'is-err'}`} onClick={() => setOpen(!open)} title={t('schedule.showResult')}>
            {last.ok ? <CircleCheck size={12} /> : <CircleAlert size={12} />}
            {statusWord(last.ok)} {timeAgo(last.ts)}
            <ChevronDown size={12} className={`sched-chev ${open ? 'is-open' : ''}`} />
          </button>
        ) : (
          <span className="muted">{t('schedule.neverRun')}</span>
        )}
        <span className="spacer" />
        <span className="muted">{task.running || task.queued || !task.enabled ? nextText(task, now) : t('schedule.nextRun', { when: nextText(task, now) })}</span>
      </div>

      <AnimatePresence initial={false}>
        {open && last && !task.running && (
          <motion.div
            className="sched-result"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="sched-result-body">
              {last.text ? <Markdown text={last.text} /> : <span className="muted small">{t('schedule.emptyAnswer')}</span>}
            </div>
            <div className="sched-history">
              <span className="muted small">
                {new Date(last.ts).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {duration(last.durationMs)}
                {last.costUsd ? ` · $${last.costUsd.toFixed(2)}` : ''}
              </span>
              <span className="spacer" />
              {task.history.length > 1 &&
                task.history
                  .slice(0, 20)
                  .reverse()
                  .map((h, i) => (
                    <button
                      key={`${h.ts}-${i}`}
                      className={`sched-hdot ${h.ok ? 'is-ok' : 'is-err'}`}
                      title={`${new Date(h.ts).toLocaleString(locale())} — ${statusWord(h.ok)}${h.sessionId ? t('schedule.openChatHint') : ''}`}
                      onClick={() => openChat(h)}
                      disabled={!h.sessionId}
                    />
                  ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="sched-actions">
        <button
          className="btn sched-btn"
          disabled={task.running || task.queued}
          onClick={() => act(() => window.desk.call('sched:runNow', task.id), t('schedule.taskStarted'))}
        >
          <Play size={12} /> {t('schedule.runNow')}
        </button>
        <button className="btn ghost sched-btn" disabled={!last?.sessionId} onClick={() => last && openChat(last)}>
          <MessageSquare size={12} /> {t('schedule.openChat')}
        </button>
        <span className="spacer" />
        <button className="icon-btn sm" title={t('common.edit')} onClick={onEdit}>
          <Pencil size={12} />
        </button>
        <button
          className="icon-btn sm danger-hover"
          title={t('common.delete')}
          onClick={async () =>
            (await askConfirm({
              title: t('schedule.deleteTitle'),
              message: t('schedule.deleteMessage', { name: task.name }),
              confirmLabel: t('common.delete'),
              danger: true,
            })) && act(() => window.desk.call('sched:delete', task.id), t('schedule.taskDeleted'))
          }
        >
          <Trash2 size={12} />
        </button>
      </div>
    </motion.div>
  );
}

// ---------- create / edit form ----------

function TaskForm({ draft: initial, hasToken, onClose }: { draft: Draft; hasToken: boolean; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const models = useStore((s) => s.models);
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  const modelList = models.length ? models : [{ value: 'default', displayName: t('common.default'), description: '' }];
  const model = models.find((m) => m.value === d.model);
  const efforts: Effort[] = model ? model.supportedEffortLevels ?? [] : ALL_EFFORTS;
  const permList = perms();
  const perm = permList.find((p) => p.v === d.permissionMode) ?? permList[0];
  const minutesOk = Number.isFinite(d.minutes) && d.minutes >= 5;
  const valid = d.name.trim() && d.prompt.trim() && (d.kind === 'daily' ? /^\d{2}:\d{2}$/.test(d.time) : minutesOk);

  const save = async () => {
    setBusy(true);
    try {
      await window.desk.call('sched:save', {
        id: d.id,
        name: d.name,
        prompt: d.prompt,
        cwd: d.cwd,
        model: d.model,
        effort: d.effort && efforts.includes(d.effort) ? d.effort : null,
        permissionMode: d.permissionMode,
        enabled: d.enabled,
        notify: d.notify,
        schedule: d.kind === 'interval' ? { type: 'interval', minutes: Math.round(d.minutes) } : { type: 'daily', time: d.time, days: d.days },
      });
      toast(d.id ? t('schedule.taskSaved') : t('schedule.taskCreated'));
      onClose();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      className="sched-card sched-form"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <div className="sched-form-inner">
        <div className="sched-form-title">{d.id ? t('schedule.editTask') : t('schedule.newTask')}</div>
        <Field label={t('schedule.name')}>
          <input className="input" autoFocus placeholder={t('schedule.namePlaceholder')} value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t('schedule.prompt')}>
          <textarea
            className="input sched-prompt"
            rows={4}
            placeholder={t('schedule.promptPlaceholder')}
            value={d.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
          />
        </Field>
        <Field label={t('schedule.folder')}>
          <div className="sched-folder">
            <span className={`truncate ${d.cwd ? '' : 'muted'}`} title={d.cwd}>
              {d.cwd || t('schedule.homeFolder')}
            </span>
            <button
              type="button"
              className="btn"
              onClick={async (e) => {
                e.preventDefault();
                const p = await window.desk.pickFolder();
                if (p) set({ cwd: p });
              }}
            >
              <Folder size={13} /> {t('schedule.pickFolder')}
            </button>
          </div>
        </Field>

        <div className="sched-grid">
          <Field label={t('schedule.model')}>
            <select className="input select" value={d.model} onChange={(e) => set({ model: e.target.value })}>
              {modelList.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.value === 'default' ? t('common.default') : modelLabel(m.value, models)}
                </option>
              ))}
            </select>
          </Field>
          {efforts.length > 0 && (
            <Field label={t('schedule.effort')}>
              <select className="input select" value={d.effort && efforts.includes(d.effort) ? d.effort : ''} onChange={(e) => set({ effort: (e.target.value || null) as Effort | null })}>
                <option value="">{t('common.default')}</option>
                {efforts.map((e) => (
                  <option key={e} value={e}>
                    {EFFORT_LABEL[e]}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <Field label={t('schedule.permissions')} hint={perm.hint}>
          <select className={`input select ${d.permissionMode === 'bypassPermissions' ? 'sched-warn' : ''}`} value={d.permissionMode} onChange={(e) => set({ permissionMode: e.target.value as SchedPerm })}>
            {permList.map((p) => (
              <option key={p.v} value={p.v}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="sched-field">
          <span className="sched-label">{t('schedule.when')}</span>
          <Segmented<'interval' | 'daily'>
            id={`sched-kind-${d.id ?? 'new'}`}
            value={d.kind}
            onChange={(kind) => set({ kind })}
            options={[
              { v: 'interval', label: t('schedule.interval') },
              { v: 'daily', label: t('schedule.daily') },
            ]}
          />
          {d.kind === 'interval' ? (
            <div className="sched-inline">
              <span className="muted small">{t('schedule.every')}</span>
              <input
                className="input sched-num"
                type="number"
                min={5}
                step={5}
                value={Number.isFinite(d.minutes) ? d.minutes : ''}
                onChange={(e) => set({ minutes: e.target.value === '' ? NaN : Number(e.target.value) })}
              />
              <span className="muted small">{t('schedule.min')}</span>
              {!minutesOk && <span className="small sched-err">{t('schedule.minInterval')}</span>}
            </div>
          ) : (
            <div className="sched-inline">
              <span className="muted small">{t('schedule.at')}</span>
              <input className="input sched-time" type="time" value={d.time} onChange={(e) => set({ time: e.target.value })} />
              <div className="sched-days">
                {WEEK.map((w) => {
                  const on = d.days.includes(w);
                  return (
                    <button
                      key={w}
                      type="button"
                      className={`sched-day ${on ? 'is-on' : ''}`}
                      onClick={() => set({ days: on ? d.days.filter((x) => x !== w) : [...d.days, w] })}
                    >
                      {cap(dayName(w))}
                    </button>
                  );
                })}
              </div>
              <span className="muted small">{d.days.length && d.days.length < 7 ? daysLabel(d.days) : t('schedule.everyDay')}</span>
            </div>
          )}
        </div>

        <div className="sched-field">
          <span className="sched-label">{t('schedule.notify')}</span>
          <div className="sched-notify">
            <label className="sched-check">
              <Toggle on={d.notify.desktop} onChange={(desktop) => set({ notify: { ...d.notify, desktop } })} />
              <span>Windows</span>
            </label>
            <label className="sched-check">
              <Toggle on={d.notify.telegram} onChange={(telegram) => set({ notify: { ...d.notify, telegram } })} />
              <span>Telegram</span>
            </label>
            {d.notify.telegram && !hasToken && <span className="small sched-err">{t('schedule.setupBotFirst')}</span>}
          </div>
        </div>

        <div className="sched-form-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={save} disabled={!valid || busy}>
            {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
            {d.id ? t('common.save') : t('common.create')}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ---------- Telegram ----------

function TelegramBlock({ settings }: { settings: SchedState['settings'] }) {
  const toast = useStore((s) => s.toast);
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState(settings.telegramChatId);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  useEffect(() => setChatId(settings.telegramChatId), [settings.telegramChatId]);

  const dirty = token.trim() !== '' || chatId.trim() !== settings.telegramChatId;

  const persist = async () => {
    await window.desk.call('sched:setTelegram', { ...(token.trim() ? { token: token.trim() } : {}), chatId: chatId.trim() });
    setToken('');
  };

  const run = async (kind: 'save' | 'test') => {
    setBusy(kind);
    try {
      if (kind === 'save' || dirty) await persist();
      if (kind === 'test') await window.desk.call('sched:telegramTest');
      toast(kind === 'test' ? t('schedule.tgTestSent') : t('schedule.tgSaved'));
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h3>{t('schedule.tgBotTitle')}</h3>
      <ol className="sched-howto muted small">
        <li>{withLink(t('schedule.tgHowto1'), <a onClick={() => window.desk.openExternal('https://t.me/BotFather')}>@BotFather</a>)}</li>
        <li>{t('schedule.tgHowto2')}</li>
        <li>{withLink(t('schedule.tgHowto3'), <a onClick={() => window.desk.openExternal('https://t.me/userinfobot')}>@userinfobot</a>)}</li>
      </ol>
      <div className="sched-tg">
        <input
          className="input"
          type="password"
          autoComplete="off"
          placeholder={settings.hasToken ? t('schedule.tokenSavedPlaceholder') : t('schedule.tokenPlaceholder')}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <input className="input" placeholder={t('schedule.chatIdPlaceholder')} value={chatId} onChange={(e) => setChatId(e.target.value)} />
        <div className="sched-tg-actions">
          {settings.hasToken && (
            <button
              className="btn ghost"
              disabled={!!busy}
              onClick={async () =>
                (await askConfirm({
                  title: t('schedule.removeTokenTitle'),
                  message: t('schedule.removeTokenMessage'),
                  confirmLabel: t('common.delete'),
                  danger: true,
                })) &&
                window.desk
                  .call('sched:setTelegram', { token: '', chatId: chatId.trim() })
                  .then(() => toast(t('schedule.tokenRemoved')))
                  .catch((e) => toast(errText(e), 'error'))
              }
            >
              <Trash2 size={13} /> {t('schedule.removeToken')}
            </button>
          )}
          <span className="spacer" />
          <button className="btn" disabled={!!busy || !dirty} onClick={() => run('save')}>
            {busy === 'save' ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {t('common.save')}
          </button>
          <button className="btn" disabled={!!busy || (!settings.hasToken && !token.trim()) || !chatId.trim()} onClick={() => run('test')}>
            {busy === 'test' ? <Loader2 size={13} className="spin" /> : <Send size={13} />} {t('schedule.test')}
          </button>
        </div>
      </div>
      <TelegramControl />
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import { useStore, projectName } from '../store';
import { askConfirm } from '../lib/dialog';
import { t } from '../i18n';
import { AgentMark } from './AgentMark';
import type { ProviderId } from '../types';

/** Tabs for sections that differ per agent (MCP servers, …). */
export function AgentTabs({ value, onChange }: { value: ProviderId; onChange: (p: ProviderId) => void }) {
  const providers = useStore((s) => s.providers);
  const ids = Object.keys(providers) as ProviderId[];
  if (ids.length < 2) return null;
  return (
    <div className="agent-tabs">
      {ids.map((id) => (
        <button key={id} className={`agent-tab ${id === value ? 'is-active' : ''}`} disabled={!providers[id].available} onClick={() => onChange(id)}>
          <AgentMark provider={id} size={14} />
          {providers[id].label}
        </button>
      ))}
    </div>
  );
}

// ---------------- MCP servers ----------------

type McpRow = { name: string; status: string; scope?: string; tools: number; error?: string };

const STATUS_KEYS: Record<string, string> = {
  connected: 'settings.mcpConnected',
  failed: 'settings.mcpFailed',
  'needs-auth': 'settings.mcpNeedsAuth',
  pending: 'settings.mcpPending',
  disabled: 'settings.mcpDisabled',
};

export function McpManager() {
  const toast = useStore((s) => s.toast);
  const [rows, setRows] = useState<McpRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [agent, setAgent] = useState<ProviderId>('claude');
  const isClaude = agent === 'claude';
  const [form, setForm] = useState({ name: '', transport: 'stdio' as 'stdio' | 'http' | 'sse', target: '', args: '', scope: 'user' as 'user' | 'project' | 'local', env: '' });

  const load = () => {
    setRows(null);
    window.desk
      .mcpStatus(agent)
      .then((r) => {
        setRows(r);
        if (agent === 'claude') useStore.setState({ mcp: r });
      })
      .catch((e) => {
        setRows([]);
        toast(String(e?.message ?? e), 'error');
      });
  };
  useEffect(load, [agent]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast(ok);
      load();
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const removable = (r: McpRow) => ['user', 'project', 'local', 'config'].includes(r.scope ?? '');

  return (
    <>
      <div className="set-head-row">
        <h2>{t('settings.nav_mcp')}</h2>
        <button className="icon-btn" title={t('common.refresh')} onClick={load}>
          <RefreshCw size={14} />
        </button>
      </div>
      <AgentTabs value={agent} onChange={setAgent} />
      <p className="muted small">{isClaude ? t('settings.mcpIntro') : t('settings.mcpIntroCodex')}</p>
      {!rows ? (
        <div className="skeleton">
          {[80, 60, 70].map((w, i) => (
            <div key={i} className="skeleton-line shimmer-bg" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <div className="mcp-list">
          {rows.map((m) => (
            <div key={m.name} className="mcp-row" title={m.error}>
              <span className={`mcp-dot ${m.status === 'connected' ? 'ok' : m.status === 'failed' ? 'err' : 'warn'}`} />
              <span className="truncate">{m.name}</span>
              <span className="spacer" />
              <span className="muted small">
                {m.status === 'connected' ? t('settings.mcpTools', { count: m.tools }) : STATUS_KEYS[m.status] ? t(STATUS_KEYS[m.status]) : m.status}
                {m.scope ? ` · ${m.scope}` : ''}
              </span>
              <button className="icon-btn sm" title={t('settings.mcpReconnect')} disabled={!!busy} onClick={() => run(m.name, () => window.desk.mcpReconnect(m.name, agent), t('settings.mcpReconnected', { name: m.name }))}>
                <RotateCw size={12} className={busy === m.name ? 'spin' : ''} />
              </button>
              {removable(m) && (
                <button
                  className="icon-btn sm danger-hover"
                  title={t('settings.mcpRemove')}
                  disabled={!!busy}
                  onClick={async () =>
                    (await askConfirm({ title: t('settings.mcpRemoveTitle'), message: t('settings.mcpRemoveMessage', { name: m.name }), confirmLabel: t('common.delete'), danger: true })) &&
                    run(m.name, () => window.desk.mcpRemove(m.name, m.scope, agent), t('settings.mcpRemoved', { name: m.name }))
                  }
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <h3>{t('settings.mcpAdd')}</h3>
      <div className="mcp-form">
        <input className="input" placeholder={t('settings.mcpName')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className="input select" value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as any })}>
          <option value="stdio">{t('settings.mcpStdio')}</option>
          <option value="http">HTTP</option>
          {isClaude && <option value="sse">SSE</option>}
        </select>
        {isClaude && (
          <select className="input select" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as any })}>
            <option value="user">{t('settings.mcpScopeUser')}</option>
            <option value="local">{t('settings.mcpScopeLocal')}</option>
            <option value="project">{t('settings.mcpScopeProject')}</option>
          </select>
        )}
        <input
          className="input mcp-wide"
          placeholder={form.transport === 'stdio' ? t('settings.mcpCommandPh') : t('settings.mcpUrlPh')}
          value={form.target}
          onChange={(e) => setForm({ ...form, target: e.target.value })}
        />
        {form.transport === 'stdio' && (
          <>
            <input className="input mcp-wide" placeholder={t('settings.mcpArgsPh')} value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
            <input className="input mcp-wide" placeholder={t('settings.mcpEnvPh')} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
          </>
        )}
        <button
          className="btn primary"
          disabled={!form.name.trim() || !form.target.trim() || !!busy}
          onClick={() =>
            run(
              'add',
              () =>
                window.desk.mcpAdd({
                  provider: agent,
                  name: form.name.trim(),
                  transport: form.transport,
                  target: form.target.trim(),
                  scope: form.scope,
                  args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
                  env: Object.fromEntries(
                    form.env
                      .split(',')
                      .map((p) => p.trim())
                      .filter((p) => p.includes('='))
                      .map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]),
                  ),
                }),
              t('settings.mcpAdded', { name: form.name }),
            ).then(() => setForm({ ...form, name: '', target: '', args: '', env: '' }))
          }
        >
          <Plus size={13} /> {t('common.add')}
        </button>
      </div>
    </>
  );
}

// ---------------- Skills ----------------

export function SkillsList() {
  const claudeCommands = useStore((s) => s.commands);
  const cwd = useStore((s) => s.threads[s.activeId]?.cwd || '');
  const [agent, setAgent] = useState<ProviderId>('claude');
  const [other, setOther] = useState<{ name: string; description: string }[] | null>(null);
  useEffect(() => {
    if (agent === 'claude') return;
    setOther(null);
    window.desk
      .call<{ name: string; description: string }[]>('desk:skills', agent, cwd || null)
      .then(setOther)
      .catch(() => setOther([]));
  }, [agent, cwd]);
  const commands = agent === 'claude' ? claudeCommands : other ?? [];
  const [q, setQ] = useState('');
  const list = commands.filter((c) => !q || (c.name + ' ' + c.description).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <h2>{t('settings.skillsTitle')}</h2>
      <AgentTabs value={agent} onChange={setAgent} />
      <p className="muted small">{t('settings.skillsIntro')}</p>
      <input className="input" placeholder={t('settings.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mcp-list" style={{ marginTop: 10 }}>
        {list.slice(0, 300).map((c) => (
          <div key={c.name} className="mcp-row skill-row">
            <code>/{c.name}</code>
            <span className="muted small truncate">{c.description}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------- Stats ----------------

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function StatsView() {
  const [data, setData] = useState<{ turns: any[]; limits: any[] } | null>(null);
  const [days, setDays] = useState(14);
  useEffect(() => {
    window.desk.statsSummary(days).then(setData).catch(() => setData({ turns: [], limits: [] }));
  }, [days]);

  const agg = useMemo(() => {
    const turns = data?.turns ?? [];
    const byDay = new Map<string, { tokens: number; turns: number }>();
    const byModel = new Map<string, number>();
    const byProject = new Map<string, number>();
    let tokens = 0;
    let cost = 0;
    let duration = 0;
    for (let i = days - 1; i >= 0; i--) byDay.set(dayKey(Date.now() - i * 86400000), { tokens: 0, turns: 0 });
    for (const t of turns) {
      const tk = (t.models ?? []).reduce((a: number, m: any) => a + m.input + m.output + m.cacheRead + m.cacheWrite, 0);
      tokens += tk;
      cost += t.cost ?? 0;
      duration += t.durationMs ?? 0;
      const d = byDay.get(dayKey(t.ts));
      if (d) {
        d.tokens += tk;
        d.turns += 1;
      }
      for (const m of t.models ?? []) byModel.set(m.model, (byModel.get(m.model) ?? 0) + m.input + m.output + m.cacheRead + m.cacheWrite);
      byProject.set(t.cwd ?? '', (byProject.get(t.cwd ?? '') ?? 0) + tk);
    }
    return { turns: turns.length, tokens, cost, duration, byDay: [...byDay.entries()], byModel: [...byModel.entries()].sort((a, b) => b[1] - a[1]), byProject: [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) };
  }, [data, days]);

  const maxDay = Math.max(1, ...agg.byDay.map(([, v]) => v.tokens));
  const maxModel = Math.max(1, ...agg.byModel.map(([, v]) => v));
  const limits = data?.limits ?? [];

  return (
    <>
      <div className="set-head-row">
        <h2>{t('settings.nav_stats')}</h2>
        <select className="input select" style={{ width: 150 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>{t('settings.statsDays', { count: 7 })}</option>
          <option value={14}>{t('settings.statsDays', { count: 14 })}</option>
          <option value={30}>{t('settings.statsDays', { count: 30 })}</option>
        </select>
      </div>
      <p className="muted small">{t('settings.statsIntro')}</p>
      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-value">{agg.turns}</div>
          <div className="muted small">{t('settings.statsTurns')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{fmtTok(agg.tokens)}</div>
          <div className="muted small">{t('settings.statsTokens')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{t('settings.statsMinutes', { n: Math.round(agg.duration / 60000) })}</div>
          <div className="muted small">{t('settings.statsWork')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">${agg.cost.toFixed(2)}</div>
          <div className="muted small">{t('settings.statsApi')}</div>
        </div>
      </div>

      <h3>{t('settings.statsByDay')}</h3>
      <div className="bars">
        {agg.byDay.map(([d, v]) => (
          <div key={d} className="bar-col" title={t('settings.statsDayTitle', { day: d, tokens: fmtTok(v.tokens), turns: v.turns })}>
            <div className="bar" style={{ height: `${Math.max(2, (v.tokens / maxDay) * 100)}%` }} />
            <span className="bar-label">{d.slice(8)}</span>
          </div>
        ))}
      </div>

      <h3>{t('settings.statsByModel')}</h3>
      {agg.byModel.length === 0 && <p className="muted small">{t('settings.statsNoData')}</p>}
      {agg.byModel.map(([m, v]) => (
        <div key={m} className="hbar-row">
          <span className="truncate">{m}</span>
          <div className="hbar">
            <div style={{ width: `${(v / maxModel) * 100}%` }} />
          </div>
          <span className="muted small">{fmtTok(v)}</span>
        </div>
      ))}

      <h3>{t('settings.statsByProject')}</h3>
      {agg.byProject.map(([p, v]) => (
        <div key={p} className="hbar-row">
          <span className="truncate" title={p}>
            {projectName(p)}
          </span>
          <div className="hbar">
            <div style={{ width: `${(v / Math.max(1, agg.byProject[0]?.[1] ?? 1)) * 100}%` }} />
          </div>
          <span className="muted small">{fmtTok(v)}</span>
        </div>
      ))}

      {limits.length > 1 && (
        <>
          <h3>{t('settings.statsLimits')}</h3>
          <LimitsChart limits={limits} />
        </>
      )}
    </>
  );
}

function LimitsChart({ limits }: { limits: { ts: number; session: number | null; weekly: number | null }[] }) {
  const W = 560;
  const H = 120;
  const t0 = limits[0].ts;
  const t1 = limits[limits.length - 1].ts || t0 + 1;
  const pt = (ts: number, v: number) => `${((ts - t0) / Math.max(1, t1 - t0)) * W},${H - (Math.min(100, v) / 100) * H}`;
  const line = (key: 'session' | 'weekly') =>
    limits
      .filter((l) => l[key] != null)
      .map((l) => pt(l.ts, l[key]!))
      .join(' ');
  return (
    <svg className="limits-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline points={line('session')} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <polyline points={line('weekly')} fill="none" stroke="var(--warn)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---------------- About / update ----------------

export function AboutSection() {
  const toast = useStore((s) => s.toast);
  const [info, setInfo] = useState<{ canRebuild: boolean; newer: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.desk.buildInfo().then(setInfo).catch(() => {});
  }, []);
  return (
    <>
      <h2>{t('settings.nav_about')}</h2>
      <p className="muted small">{t('settings.aboutIntro')}</p>
      {info?.canRebuild ? (
        <div className="set-row">
          <div className="set-text">
            <div>{t('settings.updateApp')}</div>
            <div className="muted small">{t('settings.updateAppHint')}</div>
          </div>
          <div className="set-control" style={{ display: 'flex', gap: 8 }}>
            {info.newer && (
              <button className="btn" onClick={() => window.desk.relaunch()}>
                {t('settings.relaunch')}
              </button>
            )}
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await window.desk.rebuild();
                  toast(t('settings.rebuilt'));
                  setTimeout(() => window.desk.relaunch(), 600);
                } catch (e: any) {
                  toast(t('settings.rebuildFailed', { error: e?.message ?? e }), 'error');
                  setBusy(false);
                }
              }}
            >
              {busy ? <RefreshCw size={13} className="spin" /> : <RefreshCw size={13} />}
              {t('settings.rebuild')}
            </button>
          </div>
        </div>
      ) : (
        <p className="muted small">{t('settings.installedHint')}</p>
      )}
    </>
  );
}

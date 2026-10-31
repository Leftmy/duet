import { useCallback, useState } from 'react';
import { motion } from 'motion/react';
import { Minimize2 } from 'lucide-react';
import type { Thread } from '../types';
import { useStore } from '../store';
import { Popover, spring } from './Popover';
import { t } from '../i18n';
import { ContextManager } from './ContextManager';

const PALETTE = ['#e07a52', '#4d8ef7', '#c678dd', '#4fbf7f', '#e5b567', '#56b6c2', '#f472b6', '#9ccc65', '#a3a3a3'];
// Claude Code reports theme colour names; fall back to our palette when they aren't CSS colours.
const colorOf = (c: string, i: number) => (CSS.supports('color', c) ? c : PALETTE[i % PALETTE.length]);

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

/** Context window fill indicator with a breakdown and a compact button. */
export function ContextRing({ thread }: { thread: Thread }) {
  return <><ContextUsageRing thread={thread}/><ContextManager thread={thread}/></>;
}

function ContextUsageRing({ thread }: { thread: Thread }) {
  const send = useStore((s) => s.send);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ctx = thread.context;
  if (!ctx) return null;
  const pct = Math.min(100, Math.max(0, ctx.percentage));
  const r = 7;
  const len = 2 * Math.PI * r;
  const tone = pct >= 85 ? 'var(--danger)' : pct >= 65 ? 'var(--warn)' : 'var(--text-2)';
  return (
    <Popover
      open={open}
      onClose={close}
      align="right"
      width={280}
      trigger={() => (
        <button className="icon-btn ctx-btn" title={t('thread.contextPct', { pct: Math.round(pct) })} onClick={() => setOpen((v) => !v)}>
          <svg width="18" height="18" viewBox="0 0 18 18">
            <circle cx="9" cy="9" r={r} fill="none" stroke="var(--bg-active)" strokeWidth="2.2" />
            <motion.circle
              cx="9"
              cy="9"
              r={r}
              fill="none"
              stroke={tone}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeDasharray={len}
              initial={false}
              animate={{ strokeDashoffset: len * (1 - pct / 100) }}
              transition={spring}
              transform="rotate(-90 9 9)"
            />
          </svg>
        </button>
      )}
    >
      <div className="menu-title">
        <span>{t('thread.context')}</span>
        <span className="spacer" />
        <span>
          {fmt(ctx.totalTokens)} / {fmt(ctx.maxTokens)} · {Math.round(pct)}%
        </span>
      </div>
      <div className="ctx-bar">
        {ctx.categories.map((c, i) => (
          <span key={c.name} style={{ width: `${(c.tokens / ctx.maxTokens) * 100}%`, background: colorOf(c.color, i) }} title={c.name} />
        ))}
      </div>
      <div className="ctx-list">
        {ctx.categories.map((c, i) => (
          <div key={c.name} className="ctx-row">
            <span className="ctx-dot" style={{ background: colorOf(c.color, i) }} />
            <span className="truncate">{c.name}</span>
            <span className="spacer" />
            <span className="muted">{fmt(c.tokens)}</span>
          </div>
        ))}
      </div>
      <div className="menu-sep" />
      <button
        className="menu-item"
        disabled={thread.status === 'running'}
        onClick={() => {
          setOpen(false);
          send(thread.id, '/compact', []);
        }}
      >
        <span className="menu-icon">
          <Minimize2 size={14} />
        </span>
        <span className="menu-text">
          <span className="menu-label">{t('thread.compact')}</span>
          <span className="menu-hint">{t(thread.provider==='codex'?'codex.compactHint':'thread.compactHint')}</span>
        </span>
      </button>
    </Popover>
  );
}

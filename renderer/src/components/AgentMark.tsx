import { useStore } from '../store';
import type { ProviderId } from '../types';

/** Neutral look until the agent's probe (with its brand) has arrived. */
const fallback = (id: string) => ({ color: 'var(--text-3)', mark: id.slice(0, 1).toUpperCase() });

/** Small coloured letter that marks an agent (its brand comes from the provider). */
export function AgentMark({ provider, size = 14, title }: { provider: ProviderId; size?: number; title?: string }) {
  const p = useStore((s) => s.providers[provider]);
  const brand = p?.brand ?? fallback(provider);
  return (
    <span
      className="agent-mark"
      style={{ background: brand.color, width: size, height: size, fontSize: Math.round(size * 0.62), borderRadius: Math.round(size * 0.3) }}
      title={title ?? p?.label ?? provider}
    >
      {brand.mark}
    </span>
  );
}

/** Marks of several agents, overlapping (a chat that moved between agents). */
export function AgentMarks({ providers, size = 14 }: { providers: ProviderId[]; size?: number }) {
  const labels = useStore((s) => providers.map((p) => s.providers[p]?.label ?? p).join(' + '));
  return (
    <span className="agent-marks" title={labels}>
      {providers.map((p) => (
        <AgentMark key={p} provider={p} size={size} title={labels} />
      ))}
    </span>
  );
}

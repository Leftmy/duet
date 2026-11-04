import { useStore } from '../store';
import type { ProviderId } from '../types';
import kimiIcon from '../assets/providers/kimi.svg';
import claudeIcon from '../assets/providers/claude.svg';
import codexIcon from '../assets/providers/codex.svg';
import antigravityIcon from '../assets/providers/antigravity.svg';

const icons: Partial<Record<ProviderId, string>> = { kimi: kimiIcon, claude: claudeIcon, codex: codexIcon, antigravity: antigravityIcon };

/** Neutral look until the agent's probe (with its brand) has arrived. */
const fallback = (id: string) => ({ color: 'var(--text-3)', mark: id.slice(0, 1).toUpperCase() });

/** Bundled provider artwork, available before probes and without network access. */
export function AgentMark({ provider, size = 14, title }: { provider: ProviderId; size?: number; title?: string }) {
  const p = useStore((s) => s.providers[provider]);
  const brand = p?.brand ?? fallback(provider);
  const icon = icons[provider];
  return (
    <span
      className="agent-mark"
      style={{ background: icon ? 'transparent' : brand.color, width: size, height: size, fontSize: Math.round(size * 0.62), borderRadius: Math.round(size * 0.3) }}
      title={title ?? p?.label ?? provider}
      data-provider={provider}
    >
      {icon ? <img src={icon} width={size} height={size} alt="" draggable={false} /> : brand.mark}
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

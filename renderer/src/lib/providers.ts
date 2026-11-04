import type { ProviderId } from '../types';

/** Product order, independent of JSON object key ordering. Gemini history remains readable. */
export const PROVIDER_ORDER = ['claude', 'codex', 'antigravity', 'kimi'] as const;
export const providerEnabled = (id: ProviderId): boolean => (PROVIDER_ORDER as readonly string[]).includes(id);
export function providerEntries<T>(providers: Record<string, T>): [ProviderId, T][] {
  return PROVIDER_ORDER.filter((id) => providers[id] !== undefined).map((id) => [id, providers[id]]);
}

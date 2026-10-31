import type { Effort, PermMode } from '../types';
import { locale, t } from '../i18n';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function basename(p: string) {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function shortPath(p: string, cwd?: string) {
  if (!p) return '';
  if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase())) {
    const rest = p.slice(cwd.length).replace(/^[\\/]/, '');
    return rest || basename(p);
  }
  return p;
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('format.durS', { s });
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? t('format.durMS', { m, s: rs }) : t('format.durM', { m });
  const h = Math.floor(m / 60);
  return t('format.durHM', { h, m: m % 60 });
}

/** Compact age of a timestamp: "now", "5 min", "2 h", "3 d", "2 wk", then a short date. */
export function relativeTime(ts: number) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('format.now');
  if (m < 60) return t('format.minutes', { count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('format.hours', { count: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t('format.days', { count: d });
  const w = Math.floor(d / 7);
  if (w < 5) return t('format.weeks', { count: w });
  return new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

/** Like relativeTime, but with "ago" for unit values: "5 min ago", "now", or a date. */
export function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60000 || diff >= 5 * 7 * 86400000) return relativeTime(ts);
  return t('format.ago', { time: relativeTime(ts) });
}

export function resetTime(v?: string | number | null) {
  if (v == null) return '';
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Effort level labels (getters, so they follow the current UI language). */
export const EFFORT_LABEL: Record<Effort, string> = {
  get none(){return t('codex.effortNone');},
  get minimal(){return t('codex.effortMinimal');},
  get ultra(){return 'Ultra';},
  get low() {
    return t('format.effortLow');
  },
  get medium() {
    return t('format.effortMedium');
  },
  get high() {
    return t('format.effortHigh');
  },
  get xhigh() {
    return t('format.effortXhigh');
  },
  get max() {
    return t('format.effortMax');
  },
};

export const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

type PermModeInfo = { mode: PermMode; label: string; short: string; hint: string; tone?: 'warn' | 'accent' };

const permMode = (mode: PermMode, key: string, tone?: 'warn' | 'accent'): PermModeInfo => ({
  mode,
  get label() {
    return t(`format.${key}Label`);
  },
  get short() {
    return t(`format.${key}Short`);
  },
  get hint() {
    return t(`format.${key}Hint`);
  },
  ...(tone ? { tone } : {}),
});

export const PERM_MODES: PermModeInfo[] = [
  permMode('default', 'permDefault'),
  permMode('acceptEdits', 'permAcceptEdits'),
  permMode('auto', 'permAuto'),
  permMode('plan', 'permPlan', 'accent'),
  permMode('bypassPermissions', 'permBypass', 'warn'),
];

export function modelLabel(value: string, models: { value: string; displayName: string }[]) {
  const m = models.find((x) => x.value === value);
  if (!m) return value;
  if (m.value === 'default') return t('common.default');
  return m.displayName;
}

export function fileToAttachment(file: File): Promise<{ mediaType: string; data: string; name: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      const comma = res.indexOf(',');
      resolve({ mediaType: file.type || 'image/png', data: res.slice(comma + 1), name: file.name });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

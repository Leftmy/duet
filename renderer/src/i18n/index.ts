// UI translations. Strings live in locales/<lang>/<namespace>.json and are addressed as '<namespace>.<key>'.
// English is the default and the fallback for missing keys.
import { create } from 'zustand';

export type Lang = 'en' | 'ru';
/** Languages with their own names (each read from its dictionary: common.languageName). */
export const LANGS: { value: Lang; readonly label: string }[] = (['en', 'ru'] as const).map((value) => ({
  value,
  get label() {
    return dicts[value]?.['common.languageName'] ?? value;
  },
}));

type Dict = Record<string, string>;
const files = import.meta.glob('./locales/*/*.json', { eager: true, import: 'default' }) as Record<string, Dict>;
const dicts: Record<string, Dict> = {};
for (const [p, dict] of Object.entries(files)) {
  const m = p.match(/\.\/locales\/([\w-]+)\/([\w-]+)\.json$/);
  if (!m) continue;
  const into = (dicts[m[1]] ??= {});
  for (const [k, v] of Object.entries(dict)) into[`${m[2]}.${k}`] = v;
}

let current: Lang = 'en';

/** Current language; components re-render on change because the app tree is keyed by it. */
export const useLang = create<{ lang: Lang }>(() => ({ lang: 'en' }));

export function setLang(lang: Lang) {
  current = dicts[lang] ? lang : 'en';
  document.documentElement.lang = current;
  if (useLang.getState().lang !== current) useLang.setState({ lang: current });
}

export const getLang = () => current;

/** BCP-47 locale for Intl APIs (dates, numbers). */
export const locale = () => (current === 'ru' ? 'ru-RU' : 'en-US');

type Params = Record<string, string | number | null | undefined>;

function lookup(key: string): string | undefined {
  return dicts[current]?.[key] ?? dicts.en?.[key];
}

/**
 * Translate a key. `{name}` placeholders are filled from params.
 * With params.count, plural forms are looked up as key_one / key_few / key_many / key_other (Intl.PluralRules).
 */
export function t(key: string, params?: Params): string {
  let s: string | undefined;
  if (params && typeof params.count === 'number') {
    const rule = new Intl.PluralRules(locale()).select(params.count);
    s = dicts[current]?.[`${key}_${rule}`] ?? dicts[current]?.[`${key}_other`] ?? dicts.en?.[`${key}_${new Intl.PluralRules('en-US').select(params.count)}`] ?? dicts.en?.[`${key}_other`];
  }
  s ??= lookup(key);
  if (s == null) {
    if (import.meta.env.DEV) console.warn('[i18n] missing key', key);
    return key;
  }
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m)) : s;
}

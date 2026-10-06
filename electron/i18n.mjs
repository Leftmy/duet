// Main-process translations: electron/locales/<lang>/<namespace>.json, keys '<namespace>.<key>'.
// The language follows the UI setting (settings.json → ui.language); English by default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');
const dicts = {};
for (const lang of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  const into = (dicts[lang] = {});
  for (const f of fs.readdirSync(path.join(dir, lang)).filter((x) => x.endsWith('.json'))) {
    try {
      const ns = f.replace(/\.json$/, '');
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, lang, f), 'utf8')))) into[`${ns}.${k}`] = v;
    } catch (e) {
      console.error('[i18n]', lang, f, e);
    }
  }
}

let current = 'en';
const listeners = new Set();

export function setLanguage(lang) {
  const next = dicts[lang] ? lang : 'en';
  if (next === current) return;
  current = next;
  for (const cb of listeners) cb(current);
}

export const getLanguage = () => current;
export const onLanguage = (cb) => (listeners.add(cb), () => listeners.delete(cb));
export const locale = () => (current === 'ru' ? 'ru-RU' : 'en-US');

/** Every loaded translation of a key (e.g. to recognize a button label sent before a language switch). */
export const tAll = (key) => Object.values(dicts).map((d) => d[key]).filter((v) => typeof v === 'string');

/** Translate a key; `{name}` placeholders from params; params.count picks key_one/_few/_many/_other. */
export function t(key, params) {
  let s;
  if (params && typeof params.count === 'number') {
    const rule = new Intl.PluralRules(locale()).select(params.count);
    s = dicts[current]?.[`${key}_${rule}`] ?? dicts[current]?.[`${key}_other`] ?? dicts.en?.[`${key}_other`];
  }
  s ??= dicts[current]?.[key] ?? dicts.en?.[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m)) : s;
}

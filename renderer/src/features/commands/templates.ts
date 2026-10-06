// Starter templates for new slash commands and skills, plus a tiny front matter reader/writer.
import { t } from '../../i18n';

export type CmdKind = 'command' | 'skill';

export interface CmdTemplate {
  id: string;
  kind: CmdKind;
  label: string;
  name: string;
  description: string;
  argumentHint: string;
  allowedTools: string;
  body: string;
}

/** Language-independent template data; texts come from the commands dictionary (tpl.<id>.*). */
const TEMPLATE_DEFS: { id: string; kind: CmdKind; name: string; allowedTools: string; description?: true; argumentHint?: true }[] = [
  { id: 'review', kind: 'command', name: 'review', allowedTools: 'Bash(git status:*), Bash(git diff:*), Read, Grep, Glob', description: true, argumentHint: true },
  { id: 'tests', kind: 'command', name: 'write-tests', allowedTools: '', description: true, argumentHint: true },
  { id: 'explain', kind: 'command', name: 'explain', allowedTools: 'Read, Grep, Glob', description: true, argumentHint: true },
  { id: 'commit-msg', kind: 'command', name: 'commit-msg', allowedTools: 'Bash(git diff:*), Bash(git status:*), Bash(git log:*)', description: true },
  { id: 'blank-cmd', kind: 'command', name: '', allowedTools: '' },
  { id: 'skill-blank', kind: 'skill', name: '', allowedTools: '' },
  { id: 'skill-style', kind: 'skill', name: 'code-style', allowedTools: '', description: true },
];

/** Starter templates in the current UI language. */
export function getTemplates(): CmdTemplate[] {
  return TEMPLATE_DEFS.map((d) => ({
    id: d.id,
    kind: d.kind,
    name: d.name,
    allowedTools: d.allowedTools,
    label: t(`commands.tpl.${d.id}.label`),
    description: d.description ? t(`commands.tpl.${d.id}.description`) : '',
    argumentHint: d.argumentHint ? t(`commands.tpl.${d.id}.argumentHint`) : '',
    body: t(`commands.tpl.${d.id}.body`),
  }));
}

const YAML_SPECIAL = /^[\s\-?:,[\]{}#&*!|>'"%@`]|[:#]\s|\s$|^$|^(true|false|null|yes|no|on|off|~|[-+]?\d[\d._]*)$/i;
export const yamlValue = (v: string) => (YAML_SPECIAL.test(v) || /[\r\n]/.test(v) ? JSON.stringify(v) : v);

export interface FrontFields {
  name?: string;
  description: string;
  argumentHint: string;
  allowedTools: string;
}

/** Builds a Markdown file with YAML front matter (empty fields are omitted). */
export function buildFile(f: FrontFields, body: string): string {
  const lines: string[] = [];
  if (f.name) lines.push(`name: ${yamlValue(f.name)}`);
  if (f.description.trim()) lines.push(`description: ${yamlValue(f.description.trim())}`);
  if (f.argumentHint.trim()) lines.push(`argument-hint: ${yamlValue(f.argumentHint.trim())}`);
  if (f.allowedTools.trim()) lines.push(`allowed-tools: ${yamlValue(f.allowedTools.trim())}`);
  const text = body.replace(/^\s*\n/, '');
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n${text}` : text;
}

const unquote = (v: string): string => {
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean).join(', ');
  return v;
};

/** Front matter fields that matter for the "/" menu preview (simple YAML subset, same rules as the main process). */
export function readFront(raw: string): { description: string; argumentHint: string; hasFront: boolean } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m =/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const data: Record<string, string> = {};
  const body = m ? text.slice(m[0].length) : text;
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      let val = kv[2].trim();
      const block: string[] = [];
      while (i + 1 < lines.length && /^([ \t]+\S|[ \t]*$)/.test(lines[i + 1])) block.push(lines[++i].trim());
      if (/^[|>][+-]?$/.test(val)) val = val[0] === '>' ? block.filter(Boolean).join(' ') : block.join('\n').trim();
      else val = unquote([val, ...(/^["']/.test(val) ? [] : block)].filter(Boolean).join(' '));
      data[kv[1]] = val;
    }
  }
  let description = (data.description ?? '').trim();
  if (!description) {
    description = (body.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim();
    if (description.length > 120) description = description.slice(0, 117) + '…';
  }
  return { description, argumentHint: data['argument-hint'] ?? '', hasFront: !!m };
}

export const NAME_RE = /^[a-z0-9_-]{1,64}(:[a-z0-9_-]{1,64}){0,4}$/;
export const SKILL_NAME_RE = /^[a-z0-9_-]{1,64}$/;

export function nameError(kind: CmdKind, name: string): string | null {
  if (!name) return t('commands.name.required');
  if (kind === 'skill' && name.includes(':')) return t('commands.name.noColonInSkill');
  if (!(kind === 'skill' ? SKILL_NAME_RE : NAME_RE).test(name)) return t(kind === 'command' ? 'commands.name.charsCommand' : 'commands.name.charsSkill');
  if (kind === 'command' && name.split(':').at(-1) === 'skill') return t('commands.name.reserved');
  return null;
}

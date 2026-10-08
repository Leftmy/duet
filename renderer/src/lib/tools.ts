import { diffLines } from 'diff';
import { basename } from './format';
import { t } from '../i18n';
import type { ToolItem } from '../types';

export type ToolKind =
  | 'shell'
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'web'
  | 'agent'
  | 'todo'
  | 'question'
  | 'plan'
  | 'skill'
  | 'mcp'
  | 'other';

/** The run_agent tool of the desk-agents toolset: another agent working for this chat's agent. */
export const DESK_AGENT_TOOL = 'mcp__desk-agents__run_agent';

export function toolKind(name: string): ToolKind {
  if (name === 'Bash' || name === 'PowerShell' || name === 'BashOutput' || name === 'KillShell') return 'shell';
  if (name === 'Read' || name === 'LS') return 'read';
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit' || name === 'Patch') return 'edit';
  if (name === 'Write') return 'write';
  if (name === 'Grep' || name === 'Glob' || name === 'ToolSearch') return 'search';
  if (name === 'WebSearch' || name === 'WebFetch') return 'web';
  if (name === 'Task' || name === 'Agent' || name === DESK_AGENT_TOOL) return 'agent';
  if (name === 'TodoWrite') return 'todo';
  if (name === 'AskUserQuestion') return 'question';
  if (name === 'ExitPlanMode' || name === 'EnterPlanMode') return 'plan';
  if (name === 'Skill') return 'skill';
  if (name.startsWith('mcp__desk-browser__') || name.startsWith('mcp__claude-in-chrome__')) return 'web';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'sep';
  text: string;
}

function linesOf(s: string) {
  const parts = s.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function buildDiff(oldText: string, newText: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const part of diffLines(oldText ?? '', newText ?? '')) {
    const type = part.added ? 'add' : part.removed ? 'del' : 'ctx';
    const lines = linesOf(part.value);
    if (type === 'ctx' && lines.length > 6) {
      lines.slice(0, 3).forEach((text) => out.push({ type, text }));
      out.push({ type: 'sep', text: t('tools.unchanged', { count: lines.length - 6 }) });
      lines.slice(-3).forEach((text) => out.push({ type, text }));
    } else {
      lines.forEach((text) => out.push({ type, text }));
    }
  }
  return out;
}

/** Parses `git diff` output for a single file into display lines. */
export function parseUnifiedDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      const ctx = line.replace(/^@@[^@]*@@\s?/, '');
      out.push({ type: 'sep', text: ctx ? `⋯ ${ctx}` : '⋯' });
    } else if (!inHunk) {
      if (line.startsWith('Binary files')) out.push({ type: 'sep', text: t('tools.binaryFile') });
    } else if (line.startsWith('+')) out.push({ type: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) out.push({ type: 'del', text: line.slice(1) });
    else if (line.startsWith(' ')) out.push({ type: 'ctx', text: line.slice(1) });
    else if (line.startsWith('diff --git')) inHunk = false;
  }
  return out;
}

/** A unified-diff fragment without file headers (Codex patches): hunks, or plain lines for a new file. */
function patchLines(diff: string, kind: string): DiffLine[] {
  if (/^@@/m.test(diff)) return parseUnifiedDiff(diff).filter((l, n) => !(n === 0 && l.type === 'sep' && kind === 'add'));
  return linesOf(diff).map((text) => (text.startsWith('+') ? { type: 'add' as const, text: text.slice(1) } : text.startsWith('-') ? { type: 'del' as const, text: text.slice(1) } : { type: kind === 'add' ? ('add' as const) : ('ctx' as const), text: text.replace(/^ /, '') }));
}

export function toolDiff(item: ToolItem): DiffLine[] | null {
  const i = item.input ?? {};
  if (item.name === 'Edit') return buildDiff(i.old_string ?? '', i.new_string ?? '');
  if (item.name === 'Patch' && typeof i.diff === 'string') return patchLines(i.diff, i.kind);
  if (item.name === 'MultiEdit' && Array.isArray(i.edits)) {
    const out: DiffLine[] = [];
    i.edits.forEach((e: any, n: number) => {
      if (n) out.push({ type: 'sep', text: '⋯' });
      out.push(...buildDiff(e.old_string ?? '', e.new_string ?? ''));
    });
    return out;
  }
  if (item.name === 'Write' && typeof i.content === 'string') {
    return linesOf(i.content).map((text) => ({ type: 'add' as const, text }));
  }
  return null;
}

export function diffStats(lines: DiffLine[] | null) {
  if (!lines) return null;
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === 'add') add++;
    else if (l.type === 'del') del++;
  }
  return { add, del };
}

const trunc = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Returns [verb, subject] for a tool row, Codex-style: "Ran command" + `npm test`. */
export function toolSummary(item: ToolItem): { verb: string; subject?: string; code?: boolean; title?: string } {
  const i = item.input ?? {};
  const running = item.status === 'running';
  switch (item.name) {
    case 'Bash':
    case 'PowerShell':
      return {
        verb: running ? t('tools.runningCommand') : item.status === 'error' ? t('tools.commandFailed') : t('tools.ranCommand'),
        subject: trunc(String(i.command ?? '').split('\n')[0], 110),
        code: true,
        title: i.description,
      };
    case 'BashOutput':
      return { verb: t('tools.checkedBgOutput') };
    case 'KillShell':
      return { verb: t('tools.stoppedBgCommand') };
    case 'Read':
      return { verb: running ? t('tools.reading') : t('tools.read'), subject: basename(i.file_path ?? ''), title: i.file_path };
    case 'LS':
      return { verb: t('tools.listedFolder'), subject: basename(i.path ?? ''), title: i.path };
    case 'Edit':
    case 'MultiEdit':
      return { verb: running ? t('tools.editing') : t('tools.edited'), subject: basename(i.file_path ?? ''), title: i.file_path };
    case 'NotebookEdit':
      return { verb: t('tools.editedNotebook'), subject: basename(i.notebook_path ?? ''), title: i.notebook_path };
    case 'Write':
      return { verb: running ? t('tools.writing') : t('tools.wrote'), subject: basename(i.file_path ?? ''), title: i.file_path };
    case 'Patch':
      return {
        verb: i.kind === 'add' ? (running ? t('tools.writing') : t('tools.wrote')) : i.kind === 'delete' ? t('tools.deletedFile') : running ? t('tools.editing') : t('tools.edited'),
        subject: basename(i.move_path ?? i.file_path ?? ''),
        title: i.move_path ? `${i.file_path} → ${i.move_path}` : i.file_path,
      };
    case 'Grep':
      return { verb: t('tools.searched'), subject: trunc(String(i.pattern ?? ''), 70), code: true, title: i.path };
    case 'Glob':
      return { verb: t('tools.searchedFiles'), subject: trunc(String(i.pattern ?? ''), 70), code: true, title: i.path };
    case 'ToolSearch':
      return { verb: t('tools.loadedTools'), subject: trunc(String(i.query ?? ''), 60) };
    case 'WebSearch':
      return { verb: running ? t('tools.searchingWeb') : t('tools.searchedWeb'), subject: trunc(String(i.query ?? ''), 80) };
    case 'WebFetch': {
      let host = String(i.url ?? '');
      try {
        host = new URL(host).host;
      } catch {}
      return { verb: running ? t('tools.opening') : t('tools.opened'), subject: host, title: i.url };
    }
    case 'Task':
    case 'Agent':
      return {
        verb: running ? t('tools.agentRunning') : t('tools.agentDone'),
        subject: trunc(String(i.description ?? i.subagent_type ?? ''), 80),
      };
    case 'TodoWrite':
      return { verb: t('tools.updatedPlan') };
    case 'AskUserQuestion':
      return { verb: t('tools.askedQuestion') };
    case 'ExitPlanMode':
      return { verb: t('tools.proposedPlan') };
    case 'EnterPlanMode':
      return { verb: t('tools.enteredPlanMode') };
    case 'Skill':
      return { verb: t('tools.usedSkill'), subject: String(i.skill ?? i.name ?? ''), code: true };
    default:
      if (isBrowserTool(item.name)) return browserSummary(item);
      if (item.name.startsWith('mcp__')) {
        const [, server, ...rest] = item.name.split('__');
        return { verb: t('tools.called', { server }), subject: rest.join('__'), code: true };
      }
      return { verb: t('tools.used', { name: item.name }) };
  }
}

export const isBrowserTool = (name: string) => name.startsWith('mcp__desk-browser__') || name.startsWith('mcp__claude-in-chrome__');

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** Readable rows for the built-in browser and Claude in Chrome tools. */
function browserSummary(item: ToolItem): { verb: string; subject?: string; code?: boolean; title?: string } {
  const chrome = item.name.startsWith('mcp__claude-in-chrome__');
  const where = chrome ? 'Chrome' : t('tools.browser');
  const b = (key: string, params?: Record<string, string>) => t('tools.browserStep', { where, step: t(`tools.${key}`, params) });
  const action = item.name.split('__').pop() ?? '';
  const i = item.input ?? {};
  const running = item.status === 'running';
  switch (action) {
    case 'navigate':
      return { verb: b(running ? 'bOpening' : 'bOpened'), subject: hostOf(String(i.url ?? '')), title: i.url };
    case 'screenshot':
      return { verb: b('bScreenshot') };
    case 'read_page':
    case 'get_page_text':
      return { verb: b('bReadPage') };
    case 'click':
      return { verb: b('bClick'), subject: String(i.text ?? i.selector ?? i.ref ?? ''), code: Boolean(i.selector) };
    case 'type':
    case 'form_input':
      return { verb: b('bTyped'), subject: String(i.text ?? i.value ?? '').slice(0, 60) };
    case 'computer':
      return { verb: t('tools.browserStep', { where, step: String(i.action_summary ?? i.action ?? t('tools.bAction')) }) };
    case 'scroll':
      return { verb: b('bScroll') };
    case 'run_js':
    case 'javascript_tool':
      return { verb: b('bRanJs'), subject: String(i.code ?? i.text ?? '').split('\n')[0].slice(0, 70), code: true };
    case 'find':
      return { verb: b('bFind'), subject: String(i.query ?? '') };
    case 'tabs_create_mcp':
    case 'tabs_context_mcp':
      return { verb: b('bTabs') };
    default:
      return { verb: t('tools.browserStep', { where, step: action.replace(/_/g, ' ') }) };
  }
}

export function resultText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? t('tools.imagePlaceholder') : ''))
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export function subStepLabel(block: any): string {
  if (!block) return '';
  if (block.type === 'tool_use') {
    const s = toolSummary({
      kind: 'tool',
      id: '',
      name: block.name,
      input: block.input,
      inputJson: '',
      status: 'done',
      startedAt: 0,
      subSteps: 0,
    });
    return [s.verb, s.subject].filter(Boolean).join(' ');
  }
  return '';
}

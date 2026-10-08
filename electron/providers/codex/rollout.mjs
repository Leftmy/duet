// Saved Codex sessions: the rollout file (~/.codex/sessions/**/rollout-*.jsonl) → desk events.
// thread/read only rebuilds messages and file changes; the rollout also has every shell command,
// tool call and reasoning summary, so history is read from it.
import fs from 'node:fs';
import { askQuestions, itemEvents, readableUserText, stripAnsi, userInputText } from './translate.mjs';

const SHELL_TOOLS = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'unified_exec']);
const PLAN_STATUS = { pending: 'pending', in_progress: 'in_progress', inProgress: 'in_progress', completed: 'completed' };

const parseJson = (s) => {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

/** "Exit code: N\nWall time: …\nOutput:\n…" → { exitCode, text }. */
function splitOutput(raw) {
  const s = typeof raw === 'string' ? raw : raw?.content ?? JSON.stringify(raw ?? '');
  const m = String(s).match(/^Exit code: (-?\d+)\n(?:Wall time:[^\n]*\n)?Output:\n?([\s\S]*)$/);
  if (!m) return { exitCode: null, text: stripAnsi(s) };
  return { exitCode: Number(m[1]), text: stripAnsi(m[2]).trimEnd() };
}

/** apply_patch input → one { file_path, kind, diff } per file, with unified-diff-like hunks. */
export function parsePatch(text) {
  const files = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    const head = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (head) {
      cur = { file_path: head[2].trim(), kind: head[1].toLowerCase(), lines: [] };
      files.push(cur);
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move && cur) {
      cur.move_path = move[1].trim();
      continue;
    }
    if (!cur || line.startsWith('*** ')) continue;
    if (cur.kind === 'add') cur.lines.push(line.startsWith('+') ? line : `+${line}`);
    else cur.lines.push(line);
  }
  return files.map(({ lines, ...f }) => {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const body = lines.join('\n');
    return { ...f, diff: f.kind === 'add' && body ? `@@ -0,0 +1,${lines.length} @@\n${body}\n` : body ? `${body}\n` : '' };
  });
}

function toolCall(p) {
  const args = parseJson(p.arguments);
  const name = p.name ?? '';
  if (SHELL_TOOLS.has(name)) {
    const command = Array.isArray(args.command) ? args.command.join(' ') : String(args.command ?? args.cmd ?? '');
    return { name: 'Bash', input: { command } };
  }
  if (name === 'update_plan') {
    return {
      name: 'TodoWrite',
      input: { todos: (args.plan ?? []).map((s) => ({ content: s.step, activeForm: s.step, status: PLAN_STATUS[s.status] ?? 'pending' })) },
    };
  }
  if (name === 'view_image') return { name: 'Read', input: { file_path: args.path ?? '' } };
  if (name === 'request_user_input' || name === 'request_user_input_async') return { name: 'AskUserQuestion', input: { questions: askQuestions(args.questions) } };
  if (name === 'spawn_agent') return { name: 'Agent', input: { description: String(args.message ?? args.prompt ?? '').split('\n')[0].slice(0, 80), prompt: args.message ?? args.prompt ?? '' } };
  if (p.namespace) return { name: `mcp__${p.namespace}__${name}`, input: args };
  if (name.startsWith('mcp__')) return { name, input: args };
  const mcp = name.match(/^([\w-]+?)__(.+)$/);
  if (mcp) return { name: `mcp__${mcp[1]}__${mcp[2]}`, input: args };
  return { name, input: args };
}

const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** File changes of a recorded item: v2 array, or the older { path: { add | delete | update } } map. */
function recordedChanges(changes) {
  if (Array.isArray(changes)) return changes.map((c) => ({ path: c.path, kind: c.kind ?? { type: 'update' }, diff: c.diff ?? c.unified_diff ?? '' }));
  return Object.entries(changes ?? {}).map(([p, c]) => {
    const type = c.type ?? Object.keys(c)[0] ?? 'update';
    const body = c[type] ?? c;
    const diff = body.unified_diff ?? body.diff ?? (typeof body.content === 'string' ? body.content.split('\n').map((l) => `+${l}`).join('\n') : '');
    return { path: p, kind: { type, move_path: body.move_path ?? null }, diff };
  });
}

/** An item as newer Codex versions record it (PascalCase type, snake_case fields) → a v2 thread item. */
export function recordedItem(raw) {
  const it = Object.fromEntries(Object.entries(raw).map(([k, v]) => [camel(k), v]));
  const type = it.type.charAt(0).toLowerCase() + it.type.slice(1);
  switch (type) {
    case 'agentMessage':
      return { ...it, type, text: it.text ?? (it.content ?? []).map((c) => c.text ?? '').join('') };
    case 'reasoning':
      return { ...it, type, summary: it.summary ?? it.summaryText ?? [], content: it.content ?? it.rawContent ?? [] };
    case 'commandExecution':
      return {
        ...it,
        type,
        command: Array.isArray(it.command) ? it.command.join(' ') : it.command,
        commandActions: it.commandActions ?? (it.parsedCmd ?? []).map((c) => ({ ...c, command: c.cmd ?? c.command })),
        aggregatedOutput: it.aggregatedOutput ?? it.formattedOutput ?? [it.stdout, it.stderr].filter(Boolean).join('\n'),
        exitCode: it.exitCode,
      };
    case 'dynamicToolCall':
      return { ...it, type, contentItems: it.contentItems ?? [] };
    case 'fileChange':
      return { ...it, type, changes: recordedChanges(raw.changes) };
    case 'mcpToolCall':
      return { ...it, type, server: it.server ?? it.invocation?.server, tool: it.tool ?? it.invocation?.tool, arguments: it.arguments ?? it.invocation?.arguments };
    default:
      return { ...it, type };
  }
}

/** Desk events of a rollout file; null when it can't be read. */
export function rolloutEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // Newer Codex records every finished item; older versions only the raw model items.
  if (text.includes('"type":"item_completed"')) return recordedEvents(text);
  /** Turns as event lists, so rollbacks can drop the latest ones. */
  const turns = [];
  let cur = [];
  const open = () => {
    if (cur.length) turns.push(cur);
    cur = [];
  };
  const calls = new Map();
  let seq = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec.payload ?? {};
    if (rec.type === 'event_msg') {
      switch (p.type) {
        case 'user_message': {
          open();
          const images = (p.images ?? [])
            .map((url, i) => {
              const [, mediaType, data] = String(url).match(/^data:([^;]+);base64,(.*)$/) ?? [];
              return data ? { id: `img-${seq}-${i}`, mediaType, data } : null;
            })
            .filter(Boolean);
          cur.push({ type: 'user', text: readableUserText(p.message).trim(), images });
          break;
        }
        case 'turn_aborted':
          cur.push({ type: 'notice', code: 'reduce.interrupted', tone: 'warn', at: 'if-open' });
          break;
        case 'error':
          cur.push({ type: 'notice', text: String(p.message ?? ''), tone: 'error', at: 'open' });
          break;
        case 'context_compacted':
          cur.push({ type: 'notice', code: 'reduce.compacted', tone: 'info', at: 'open' });
          break;
        case 'thread_rolled_back': {
          open();
          turns.splice(Math.max(0, turns.length - (p.num_turns ?? 0)));
          break;
        }
      }
      continue;
    }
    if (rec.type === 'compacted') {
      cur.push({ type: 'notice', code: 'reduce.compacted', tone: 'info', at: 'open' });
      continue;
    }
    if (rec.type !== 'response_item') continue;
    switch (p.type) {
      case 'message':
        if (p.role !== 'assistant') break;
        {
          const t = (p.content ?? [])
            .filter((c) => c.type === 'output_text')
            .map((c) => c.text)
            .join('');
          if (t.trim()) cur.push({ type: 'text', id: `r${++seq}`, text: t, mode: 'final' });
        }
        break;
      case 'reasoning': {
        const t = (p.summary ?? [])
          .map((s) => s.text)
          .filter(Boolean)
          .join('\n\n');
        if (t.trim()) cur.push({ type: 'thinking', id: `r${++seq}`, text: t, mode: 'final' });
        break;
      }
      case 'function_call': {
        const { name, input } = toolCall(p);
        calls.set(p.call_id, name);
        cur.push({ type: 'tool', id: p.call_id, name, input, final: true });
        break;
      }
      case 'local_shell_call': {
        const command = (p.action?.command ?? []).join(' ');
        calls.set(p.call_id, 'Bash');
        cur.push({ type: 'tool', id: p.call_id, name: 'Bash', input: { command }, final: true });
        break;
      }
      case 'custom_tool_call':
        if (p.name === 'apply_patch') {
          const files = parsePatch(p.input);
          calls.set(p.call_id, files.length);
          files.forEach((f, i) => cur.push({ type: 'tool', id: i ? `${p.call_id}#${i}` : p.call_id, name: 'Patch', input: f, final: true }));
        } else {
          calls.set(p.call_id, p.name);
          cur.push({ type: 'tool', id: p.call_id, name: p.name, input: { input: p.input }, final: true });
        }
        break;
      case 'web_search_call': {
        const id = p.id ?? `ws${++seq}`;
        const a = p.action ?? {};
        if (a.type === 'open_page') cur.push({ type: 'tool', id, name: 'WebFetch', input: { url: a.url ?? '' }, final: true });
        else cur.push({ type: 'tool', id, name: 'WebSearch', input: { query: a.query ?? (a.queries ?? []).join(', ') }, final: true });
        cur.push({ type: 'tool.result', id, status: 'done', result: '' });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const kind = calls.get(p.call_id);
        const out = splitOutput(p.output);
        const status = out.exitCode != null && out.exitCode !== 0 ? 'error' : p.output?.success === false ? 'error' : 'done';
        if (typeof kind === 'number') {
          for (let i = 0; i < kind; i++) cur.push({ type: 'tool.result', id: i ? `${p.call_id}#${i}` : p.call_id, status, result: '' });
        } else {
          let result = out.text;
          if (kind === 'Bash' && out.exitCode) result += `${result ? '\n' : ''}(exit code ${out.exitCode})`;
          cur.push({ type: 'tool.result', id: p.call_id, status, result });
        }
        break;
      }
    }
  }
  open();
  return turns.flat();
}

/** Rollouts with recorded items (newer Codex): the same items the live stream reports. */
function recordedEvents(text) {
  const turns = [];
  let cur = [];
  const open = () => {
    if (cur.length) turns.push(cur);
    cur = [];
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'event_msg') continue;
    const p = rec.payload ?? {};
    switch (p.type) {
      case 'item_completed': {
        if (!p.item?.type) break;
        const item = recordedItem(p.item);
        if (item.type === 'userMessage') {
          open();
          const { text: t, images } = userInputText(item.content);
          cur.push({ type: 'user', text: t.trim(), images });
        } else if (!(item.type === 'reasoning' && !item.summary?.length)) cur.push(...itemEvents(item, 'end'));
        break;
      }
      case 'turn_aborted':
        cur.push({ type: 'notice', code: 'reduce.interrupted', tone: 'warn', at: 'if-open' });
        break;
      case 'error':
        cur.push({ type: 'notice', text: String(p.message ?? ''), tone: 'error', at: 'open' });
        break;
      case 'thread_rolled_back':
        open();
        turns.splice(Math.max(0, turns.length - (p.num_turns ?? 0)));
        break;
    }
  }
  open();
  return turns.flat();
}

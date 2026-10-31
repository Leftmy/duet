// Context handoff between agents: when a chat moves from one agent to another, the new agent gets
// the conversation (or what happened since it last worked here) as extra system instructions.
// Built from the provider-neutral feed, so it works the same for any pair of agents.
import type { AgentRun, BgTask, Entry, ProviderId, ToolItem, Turn } from '../types';
import { diffStats, toolDiff, toolKind, toolSummary } from './tools';

/** Transcript budget; older turns beyond it are summarized (or cut when summarizing fails). */
const FULL_LIMIT = 40_000;
const RECENT_KEEP = 14_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

function toolLine(item: ToolItem): string {
  const s = toolSummary(item);
  const head = [s.verb, s.subject].filter(Boolean).join(' ');
  const kind = toolKind(item.name);
  const failed = item.status === 'error' ? ' (failed)' : '';
  if (kind === 'shell') {
    const out = (item.result ?? '').trim();
    return `- Ran \`${clip(String(item.input?.command ?? ''), 300)}\`${failed}${out ? `\n  output: ${clip(out.replace(/\n/g, '\n  '), 600)}` : ''}`;
  }
  if (kind === 'edit' || kind === 'write') {
    const st = diffStats(toolDiff(item));
    return `- ${head}${st ? ` (+${st.add} −${st.del})` : ''}${failed}`;
  }
  if (kind === 'todo' && Array.isArray(item.input?.todos)) {
    return `- Plan:\n${item.input.todos.map((td: any) => `  [${td.status === 'completed' ? 'x' : td.status === 'in_progress' ? '~' : ' '}] ${td.content}`).join('\n')}`;
  }
  if (kind === 'agent') return `- Subagent: ${clip(String(item.input?.description ?? item.input?.prompt ?? ''), 200)}${item.result ? `\n  report: ${clip(item.result, 800)}` : ''}`;
  const res = (item.result ?? '').trim();
  return `- ${head}${failed}${res && kind !== 'read' ? `\n  result: ${clip(res.replace(/\n/g, ' '), 300)}` : ''}`;
}

function turnText(turn: Turn): string {
  const parts: string[] = [];
  for (const it of turn.items) {
    if (it.kind === 'text' && it.text.trim()) parts.push(it.text.trim());
    else if (it.kind === 'tool') parts.push(toolLine(it));
    else if (it.kind === 'steer') parts.push(`(User, mid-turn): ${it.text}`);
    else if (it.kind === 'notice' && it.tone === 'error') parts.push(`(Error: ${it.text})`);
  }
  if (turn.error) parts.push(`(Turn failed: ${turn.error})`);
  if (turn.interrupted) parts.push('(Interrupted by the user)');
  return parts.join('\n');
}

/** Plain-text transcript of feed entries, one block per message. */
export function transcript(entries: Entry[], label: (p?: ProviderId) => string): string[] {
  const blocks: string[] = [];
  for (const e of entries) {
    if (e.kind === 'user') {
      if (e.summary) blocks.push(`## Earlier context (summary)\n${clip(e.text, 6000)}`);
      else blocks.push(`## User\n${e.text}${e.images?.length ? `\n[${e.images.length} image(s) attached]` : ''}`);
    } else {
      const body = turnText(e);
      if (body) blocks.push(`## ${label(e.provider)}\n${body}`);
    }
  }
  return blocks;
}

/** Entries the target agent hasn't seen: everything after its own last turn in this chat (or all of it). */
export function unseenEntries(entries: Entry[], target: ProviderId): { entries: Entry[]; resumed: boolean } {
  let last = -1;
  entries.forEach((e, i) => {
    if (e.kind === 'turn' && e.provider === target) last = i;
  });
  return last < 0 ? { entries, resumed: false } : { entries: entries.slice(last + 1), resumed: true };
}

export interface HandoffInput {
  entries: Entry[];
  from: ProviderId;
  to: ProviderId;
  cwd: string;
  label: (p?: ProviderId) => string;
  /** Uncommitted changes in the working directory, e.g. "M src/app.ts". */
  changes?: string[];
  agents?: AgentRun[];
  tasks?: BgTask[];
  /** False for a fresh provider session, even when copied history includes that provider. */
  resume?: boolean;
  /** Earlier history read by the native core without loading it into the UI. */
  earlier?: string;
  /** Summarizes an older part of the transcript (a quick model call); may throw. */
  summarize?: (text: string) => Promise<string>;
}

/** The instructions text handed to the agent that takes over the chat; null when there is nothing to hand over. */
export async function buildHandoff({ entries, from, to, cwd, label, changes, agents = [], tasks = [], resume, earlier, summarize }: HandoffInput): Promise<string | null> {
  const { entries: unseen, resumed } = resume === false ? { entries, resumed: false } : unseenEntries(entries, to);
  const blocks = transcript(unseen, label);
  if (earlier?.trim()) blocks.unshift('## Earlier conversation retained on disk\n' + earlier.trim());
  if (agents.length) blocks.push('## Subagent work\n' + agents.map((a) =>
    `- ${a.name} (${a.status})\n  Task: ${clip(a.prompt, 1000)}\n  Result: ${clip(a.result || a.items.filter((i) => i.kind === 'text').map((i) => i.text).join('\n'), 3000)}`
  ).join('\n') + '\nThese are prior work records, not live agents you can address. Continue unfinished work or start your own helpers as needed.');
  if (tasks.length) blocks.push('## Task state\n' + tasks.map((task) => `- ${task.description} (${task.status})${task.summary ? ': ' + clip(task.summary, 1000) : ''}`).join('\n'));
  if (!blocks.length) return null;

  let body = blocks.join('\n\n');
  if (body.length > FULL_LIMIT) {
    // Keep the latest messages verbatim; condense what came before them.
    let recentLen = 0;
    let cut = blocks.length;
    while (cut > 1 && recentLen + blocks[cut - 1].length < RECENT_KEEP) recentLen += blocks[--cut].length + 2;
    const older = blocks.slice(0, cut).join('\n\n');
    let summary: string | null = null;
    try {
      summary = summarize ? (await summarize(older)).trim() || null : null;
    } catch {}
    const head = summary ?? `${older.slice(0, 6000)}\n…\n${older.slice(-6000)}`;
    body = `## Earlier part (${summary ? 'summary' : 'excerpt'})\n${head}\n\n${blocks.slice(cut).join('\n\n')}`;
  }

  const fromName = label(from);
  return [
    '<context_handoff>',
    from === to
      ? 'This conversation was rewound to an earlier point. Below is the conversation up to the rewind point.'
      : resumed
        ? `You worked in this chat before. While you were away the user continued it with another coding agent (${fromName}), and has now switched back to you. Below is what happened since your last turn.`
        : `The user started this chat with another coding agent (${fromName}) and has now switched to you. Below is the conversation so far.`,
    'Treat it as your own prior context: continue seamlessly from where it stopped, do not redo finished steps, and do not mention the switch unless the user asks. ' +
      'Files in the working directory already contain the changes described.',
    '',
    `Working directory: ${cwd}`,
    ...(changes?.length ? ['', 'Uncommitted changes:', ...changes.slice(0, 60).map((c) => `  ${c}`)] : []),
    '',
    body,
    '</context_handoff>',
  ].join('\n');
}

// Turns Agent SDK messages (live stream or saved transcript) into UI entries.
import type { AgentRun, BgTask, Entry, ImageAttachment, Item, Thread, Turn } from '../types';
import { resultText, subStepLabel } from './tools';
import { uid } from './format';
import { t as tr } from '../i18n';

export interface Runtime {
  msgId?: string;
  stream: Map<string, string>;
}

export const newRuntime = (): Runtime => ({ stream: new Map() });

class TurnEditor {
  private turn: Turn | null = null;
  constructor(private entries: Entry[], private now: number) {}

  get(): Turn {
    if (this.turn) return this.turn;
    const idx = this.entries.length - 1;
    const last = this.entries[idx];
    if (!last || last.kind !== 'turn' || last.done) {
      this.turn = { kind: 'turn', id: uid(), items: [], startedAt: this.now, done: false };
      this.entries.push(this.turn);
    } else {
      this.turn = { ...last, items: [...last.items] };
      this.entries[idx] = this.turn;
    }
    return this.turn;
  }

  /** The open turn, without creating one. */
  peek(): Turn | null {
    if (this.turn) return this.turn;
    const last = this.entries[this.entries.length - 1];
    if (!last || last.kind !== 'turn' || last.done) return null;
    return this.get();
  }

  findIndex(pred: (i: Item) => boolean) {
    return this.get().items.findIndex(pred);
  }

  patch(index: number, patch: Partial<Item>) {
    const t = this.get();
    t.items[index] = { ...t.items[index], ...patch } as Item;
  }

  push(item: Item) {
    this.get().items.push(item);
  }

  /** Searches every turn (newest first) for a tool item; used for late tool results. */
  patchTool(toolId: string, patch: Partial<Item>) {
    const open = this.peek();
    if (open) {
      const i = open.items.findIndex((x) => x.kind === 'tool' && x.id === toolId);
      if (i >= 0) {
        this.patch(i, patch);
        return true;
      }
    }
    for (let e = this.entries.length - 1; e >= 0; e--) {
      const entry = this.entries[e];
      if (entry.kind !== 'turn' || entry === this.turn) continue;
      const i = entry.items.findIndex((x) => x.kind === 'tool' && x.id === toolId);
      if (i >= 0) {
        const items = [...entry.items];
        items[i] = { ...items[i], ...patch } as Item;
        this.entries[e] = { ...entry, items };
        return true;
      }
    }
    return false;
  }
}

function applyAssistantContent(ed: TurnEditor, msgId: string | undefined, content: any[], now: number) {
  for (const block of content ?? []) {
    if (block.type === 'text') {
      const i = ed.findIndex((x) => x.kind === 'text' && x.msgId === msgId && !x.confirmed);
      if (i >= 0) ed.patch(i, { text: block.text, confirmed: true });
      else if (block.text?.trim()) ed.push({ kind: 'text', id: uid(), msgId, text: block.text, confirmed: true });
    } else if (block.type === 'thinking') {
      const i = ed.findIndex((x) => x.kind === 'thinking' && x.msgId === msgId && !x.confirmed);
      if (i >= 0) {
        const cur = ed.get().items[i] as any;
        ed.patch(i, { text: block.thinking || cur.text, confirmed: true, endedAt: cur.endedAt ?? now });
      } else {
        ed.push({ kind: 'thinking', id: uid(), msgId, text: block.thinking ?? '', confirmed: true, startedAt: now, endedAt: now });
      }
    } else if (block.type === 'tool_use') {
      const i = ed.findIndex((x) => x.kind === 'tool' && x.id === block.id);
      if (i >= 0) ed.patch(i, { input: block.input, name: block.name });
      else
        ed.push({
          kind: 'tool',
          id: block.id,
          name: block.name,
          input: block.input,
          inputJson: '',
          status: 'running',
          startedAt: now,
          subSteps: 0,
        });
    }
  }
}

function applyToolResults(ed: TurnEditor, content: any, now: number) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const images = Array.isArray(block.content)
      ? block.content
          .filter((c: any) => c?.type === 'image' && c.source?.type === 'base64')
          .map((c: any) => ({ mediaType: c.source.media_type, data: c.source.data }))
      : [];
    ed.patchTool(block.tool_use_id, {
      ...(images.length ? { images } : {}),
      result: resultText(block.content),
      status: block.is_error ? 'error' : 'done',
      endedAt: now,
    });
  }
}

/** Tracks Claude Code tasks (background shells, subagents) from task_* system events. */
function applyTaskEvent(tasks: Record<string, BgTask>, msg: any, now: number): Record<string, BgTask> {
  const next = { ...tasks };
  const cur = next[msg.task_id];
  switch (msg.subtype) {
    case 'task_started':
      next[msg.task_id] = {
        id: msg.task_id,
        description: msg.description || msg.subagent_type || tr('reduce.task'),
        type: msg.task_type ?? msg.subagent_type,
        status: 'running',
        background: Boolean(msg.is_backgrounded),
        startedAt: now,
        toolUseId: msg.tool_use_id,
      };
      break;
    case 'task_updated':
      if (!cur) break;
      next[msg.task_id] = {
        ...cur,
        ...(msg.patch.status ? { status: msg.patch.status } : {}),
        ...(msg.patch.description ? { description: msg.patch.description } : {}),
        ...(msg.patch.is_backgrounded != null ? { background: msg.patch.is_backgrounded } : {}),
        ...(msg.patch.error ? { error: msg.patch.error } : {}),
        ...(msg.patch.end_time ? { endedAt: msg.patch.end_time } : {}),
      };
      break;
    case 'task_progress':
      if (!cur) break;
      next[msg.task_id] = { ...cur, toolUses: msg.usage?.tool_uses, lastTool: msg.summary || msg.last_tool_name };
      break;
    case 'task_notification':
      next[msg.task_id] = {
        ...(cur ?? { id: msg.task_id, description: tr('reduce.task'), startedAt: now, background: true }),
        status: msg.status,
        endedAt: now,
        summary: msg.summary,
        outputFile: msg.output_file,
        toolUses: msg.usage?.tool_uses ?? cur?.toolUses,
      } as BgTask;
      break;
    case 'background_tasks_changed':
      for (const bt of msg.tasks ?? []) {
        if (bt.ambient) continue;
        const ex = next[bt.task_id];
        next[bt.task_id] = ex
          ? { ...ex, background: true }
          : { id: bt.task_id, description: bt.description, type: bt.task_type, status: 'running', background: true, startedAt: now };
      }
      break;
  }
  return next;
}

// ---------- subagents ----------

export const isAgentTool = (name: string) => name === 'Agent' || name === 'Task';

function agentName(input: any) {
  return String(input?.name || input?.description || input?.subagent_type || tr('reduce.agent'));
}

/** Creates or refreshes an agent from the lead's Agent/Task tool call. */
function upsertAgent(agents: Record<string, AgentRun>, id: string, input: any, now: number): Record<string, AgentRun> {
  const cur = agents[id];
  const prompt = String(input?.prompt ?? '');
  const base: AgentRun = cur ?? {
    id,
    name: agentName(input),
    prompt: '',
    color: Object.keys(agents).length,
    status: 'running',
    background: input?.run_in_background !== false,
    startedAt: now,
    items: [],
    toolUses: 0,
  };
  const next: AgentRun = {
    ...base,
    name: input?.name || input?.description ? agentName(input) : base.name,
    type: input?.subagent_type ?? base.type,
    model: input?.model ?? base.model,
    background: input?.run_in_background != null ? input.run_in_background !== false : base.background,
  };
  if (prompt && prompt !== base.prompt) {
    next.prompt = prompt;
    const promptItem = { kind: 'agentmsg' as const, id: `${id}:prompt`, agentId: id, dir: 'to' as const, text: prompt, label: tr('reduce.assignment') };
    const i = next.items.findIndex((x) => x.id === promptItem.id);
    next.items = i >= 0 ? next.items.map((x, n) => (n === i ? promptItem : x)) : [promptItem, ...next.items];
  }
  return { ...agents, [id]: next };
}

/** Runs `fn` against an agent's own item list using the same editor as the main feed. */
function editAgentItems(agent: AgentRun, now: number, fn: (ed: TurnEditor) => void): AgentRun {
  const fake: Entry[] = [{ kind: 'turn', id: agent.id, items: agent.items, startedAt: 0, done: false }];
  fn(new TurnEditor(fake, now));
  return { ...agent, items: (fake[0] as Turn).items };
}

/** Routes a subagent's own assistant/user message into its transcript. */
function tagUuid(turn: Turn, uuid: string) {
  turn.lastUuid = uuid;
  turn.uuids = [...(turn.uuids ?? []), uuid];
}

export function applySubagentMessage(agents: Record<string, AgentRun>, msg: any, now: number): Record<string, AgentRun> {
  const parentId: string = msg.parent_tool_use_id;
  let agent = agents[parentId];
  if (!agent) {
    agent = { id: parentId, name: tr('reduce.agent'), prompt: '', color: Object.keys(agents).length, status: 'running', background: true, startedAt: now, items: [], toolUses: 0 };
  }
  const content = msg.message?.content;
  if (msg.type === 'assistant') {
    const handback = (Array.isArray(content) ? content : []).find((b: any) => b.type === 'tool_use' && b.name === 'SubagentHandback');
    const rest = (Array.isArray(content) ? content : []).filter((b: any) => b !== handback);
    agent = editAgentItems(agent, now, (ed) => applyAssistantContent(ed, msg.message?.id, rest, now));
    agent.toolUses += rest.filter((b: any) => b.type === 'tool_use').length;
    if (handback) {
      const text = String(handback.input?.message ?? handback.input?.report ?? '');
      agent.result = text;
      agent.items = [...agent.items, { kind: 'agentmsg', id: `${agent.id}:report`, agentId: agent.id, dir: 'from', text, label: tr('reduce.report') }];
    }
  } else if (msg.type === 'user') {
    const hasResults = Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result');
    if (hasResults) agent = editAgentItems(agent, now, (ed) => applyToolResults(ed, content, now));
    else {
      const u = userTextOf(content);
      const text = u?.text.trim();
      const known = agent.items.some((x) => x.kind === 'agentmsg' && x.dir === 'to' && (x.text.trim() === text || (text && text.includes(x.text.trim()))));
      if (text && text !== agent.prompt.trim() && !known) {
        agent.items = [...agent.items, { kind: 'agentmsg', id: uid(), agentId: agent.id, dir: 'to', text, label: tr('reduce.message') }];
      }
    }
  }
  return { ...agents, [agent.id]: agent };
}

function finishAgent(agent: AgentRun, status: AgentRun['status'], result: string | undefined, now: number): AgentRun {
  const items = agent.items.map((x) => (x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'done' as const } : x));
  return { ...agent, status, endedAt: agent.endedAt ?? now, result: agent.result || result, items };
}

/** Builds agent records for a saved session from the lead's Agent tool calls. */
export function agentsFromEntries(entries: Entry[]): Record<string, AgentRun> {
  let agents: Record<string, AgentRun> = {};
  for (const e of entries) {
    if (e.kind !== 'turn') continue;
    for (const it of e.items) {
      if (it.kind !== 'tool' || !isAgentTool(it.name)) continue;
      if (it.status === 'error' && it.result?.includes('<tool_use_error>')) continue;
      agents = upsertAgent(agents, it.id, it.input, 0);
      const receipt = it.result && /^Async agent launched|agentId:/i.test(it.result.trim());
      agents[it.id] = { ...finishAgent(agents[it.id], it.status === 'error' ? 'error' : 'done', receipt ? undefined : it.result, 0), historical: true };
    }
  }
  return agents;
}

/** Applies one live SDK message to a thread. Returns a new thread object. */
export function applySdkMessage(t0: Thread, msg: any, rt: Runtime): Thread {
  const now = Date.now();
  const t: Thread = { ...t0, entries: [...t0.entries] };
  const ed = new TurnEditor(t.entries, now);
  /** Adds an item to the open turn, or to the last turn when Claude is idle. */
  const pushFeed = (item: Item) => {
    if (ed.peek()) return ed.push(item);
    const last = t.entries[t.entries.length - 1];
    if (last?.kind === 'turn') t.entries[t.entries.length - 1] = { ...last, items: [...last.items, item] };
  };
  const onLeadToolUse = (block: any) => {
    if (isAgentTool(block.name)) t.agents = upsertAgent(t.agents, block.id, block.input, now);
    else if (block.name === 'SendMessage' && block.input) {
      const to = String(block.input.to ?? block.input.recipient ?? '');
      const target = Object.values(t.agents).find((a) => a.name === to || a.id === to) ?? Object.values(t.agents).find((a) => a.status === 'running');
      const text = String(block.input.message ?? block.input.content ?? '');
      if (target && text && !target.items.some((x) => x.id === `${block.id}:msg`)) {
        t.agents = {
          ...t.agents,
          [target.id]: { ...target, items: [...target.items, { kind: 'agentmsg', id: `${block.id}:msg`, agentId: target.id, dir: 'to', text, label: tr('reduce.message') }] },
        };
      }
    }
  };

  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        t.sessionId = msg.session_id;
      } else if (msg.subtype === 'status') {
        t.activity = msg.status === 'compacting' ? tr('reduce.compacting') : undefined;
        if (msg.permissionMode) t.permissionMode = msg.permissionMode;
      } else if (msg.subtype === 'api_retry') {
        t.activity = tr('reduce.retrying', { attempt: msg.attempt, max: msg.max_retries });
      } else if (msg.subtype === 'compact_boundary') {
        ed.push({ kind: 'notice', id: uid(), text: tr('reduce.compacted'), tone: 'info' });
        t.activity = undefined;
      } else if (msg.subtype?.startsWith('task_') || msg.subtype === 'background_tasks_changed') {
        t.tasks = applyTaskEvent(t.tasks, msg, now);
        const agent = msg.tool_use_id ? t.agents[msg.tool_use_id] : undefined;
        if (agent) {
          let next = agent;
          if (msg.subtype === 'task_started') next = { ...agent, background: agent.background || Boolean(msg.is_backgrounded) };
          else if (msg.subtype === 'task_progress')
            next = { ...agent, progress: msg.summary || msg.last_tool_name || agent.progress, toolUses: msg.usage?.tool_uses ?? agent.toolUses };
          else if (msg.subtype === 'task_notification') {
            const status = msg.status === 'completed' ? 'done' : msg.status === 'failed' ? 'error' : 'stopped';
            next = finishAgent(agent, status, msg.summary, now);
            pushFeed({ kind: 'agentevent', id: uid(), agentId: agent.id, status });
          }
          t.agents = { ...t.agents, [agent.id]: next };
        }
        if (msg.subtype === 'task_notification' && !agent) {
          const task = t.tasks[msg.task_id];
          if (task?.background) {
            pushFeed({
              kind: 'notice',
              id: uid(),
              text: tr(msg.status === 'completed' ? 'reduce.bgTaskCompleted' : msg.status === 'failed' ? 'reduce.bgTaskFailed' : 'reduce.bgTaskStopped', { name: task.description }),
              tone: msg.status === 'completed' ? 'info' : 'warn',
            });
          }
        }
      }
      break;
    }
    case 'stream_event': {
      if (msg.parent_tool_use_id) break;
      const ev = msg.event;
      if (ev.type === 'message_start') {
        rt.msgId = ev.message?.id;
        t.activity = undefined;
        // Claude can start a turn on its own (e.g. reacting to a finished background task).
        t.status = 'running';
        // A new model call means messages sent mid-turn have been picked up.
        for (let e = t.entries.length - 1; e >= 0; e--) {
          const entry = t.entries[e];
          if (entry.kind !== 'turn') break;
          if (entry.items.some((x) => x.kind === 'steer' && !x.delivered)) {
            t.entries[e] = { ...entry, items: entry.items.map((x) => (x.kind === 'steer' && !x.delivered ? { ...x, delivered: true } : x)) };
          }
        }
        ed.get();
      } else if (ev.type === 'content_block_start') {
        const cb = ev.content_block;
        const key = `${rt.msgId}:${ev.index}`;
        if (cb.type === 'text') {
          const id = uid();
          ed.push({ kind: 'text', id, msgId: rt.msgId, text: cb.text ?? '', confirmed: false });
          rt.stream.set(key, id);
        } else if (cb.type === 'thinking') {
          const id = uid();
          ed.push({ kind: 'thinking', id, msgId: rt.msgId, text: cb.thinking ?? '', confirmed: false, startedAt: now });
          rt.stream.set(key, id);
        } else if (cb.type === 'tool_use') {
          if (isAgentTool(cb.name)) t.agents = upsertAgent(t.agents, cb.id, {}, now);
          if (ed.findIndex((x) => x.id === cb.id) < 0) {
            ed.push({
              kind: 'tool',
              id: cb.id,
              name: cb.name,
              input: {},
              inputJson: '',
              status: 'running',
              startedAt: now,
              subSteps: 0,
            });
          }
          rt.stream.set(key, cb.id);
        }
      } else if (ev.type === 'content_block_delta') {
        const id = rt.stream.get(`${rt.msgId}:${ev.index}`);
        if (!id) break;
        const i = ed.findIndex((x) => x.id === id);
        if (i < 0) break;
        const cur = ed.get().items[i] as any;
        const d = ev.delta;
        if (d.type === 'text_delta' && !cur.confirmed) ed.patch(i, { text: cur.text + d.text });
        else if (d.type === 'thinking_delta' && !cur.confirmed) ed.patch(i, { text: cur.text + d.thinking });
        else if (d.type === 'input_json_delta') {
          const inputJson = cur.inputJson + d.partial_json;
          let input = cur.input;
          try {
            input = JSON.parse(inputJson);
            if (isAgentTool(cur.name)) t.agents = upsertAgent(t.agents, cur.id, input, now);
          } catch {}
          ed.patch(i, { inputJson, input });
        }
      } else if (ev.type === 'content_block_stop') {
        const id = rt.stream.get(`${rt.msgId}:${ev.index}`);
        const i = id ? ed.findIndex((x) => x.id === id) : -1;
        if (i >= 0) {
          const cur = ed.get().items[i];
          if (cur.kind === 'thinking' && !cur.endedAt) ed.patch(i, { endedAt: now });
        }
      }
      break;
    }
    case 'assistant': {
      if (msg.parent_tool_use_id) {
        t.agents = applySubagentMessage(t.agents, msg, now);
        const first = (msg.message?.content ?? []).find((b: any) => b.type === 'tool_use');
        const turn = ed.peek();
        const i = turn ? turn.items.findIndex((x) => x.kind === 'tool' && x.id === msg.parent_tool_use_id) : -1;
        if (i >= 0 && first) {
          const cur = turn!.items[i] as any;
          const label = subStepLabel(first);
          ed.patch(i, { subSteps: cur.subSteps + 1, lastSub: label, subs: [...(cur.subs ?? []), label].slice(-200) });
        }
        break;
      }
      applyAssistantContent(ed, msg.message?.id, msg.message?.content, now);
      if (msg.uuid) tagUuid(ed.get(), msg.uuid);
      for (const block of msg.message?.content ?? []) if (block.type === 'tool_use') onLeadToolUse(block);
      if (msg.error) {
        const map: Record<string, string> = {
          rate_limit: tr('reduce.errRateLimit'),
          authentication_failed: tr('reduce.errAuth'),
          billing_error: tr('reduce.errBilling'),
          overloaded: tr('reduce.errOverloaded'),
        };
        const code = typeof msg.error === 'string' ? msg.error : msg.error?.type;
        ed.push({ kind: 'notice', id: uid(), text: map[code] ?? tr('reduce.errGeneric', { code }), tone: 'error' });
      }
      break;
    }
    case 'user': {
      if (msg.parent_tool_use_id) {
        t.agents = applySubagentMessage(t.agents, msg, now);
        break;
      }
      const content = msg.message?.content;
      applyToolResults(ed, content, now);
      if (msg.uuid && ed.peek()) ed.get().lastUuid = msg.uuid;
      for (const block of Array.isArray(content) ? content : []) {
        const agent = block?.type === 'tool_result' ? t.agents[block.tool_use_id] : undefined;
        if (!agent || agent.status !== 'running') continue;
        const text = resultText(block.content);
        // Rejected before it ever ran (bad input): it was never an agent.
        if (block.is_error && text.includes('<tool_use_error>') && agent.items.length <= 1) {
          const { [agent.id]: _dropped, ...rest } = t.agents;
          t.agents = rest;
          continue;
        }
        // A background agent's tool result is only the launch receipt; it finishes via task_notification.
        const launched = agent.background && !block.is_error && /background|launched|async|agentId/i.test(text.slice(0, 400));
        if (!launched) t.agents = { ...t.agents, [agent.id]: finishAgent(agent, block.is_error ? 'error' : 'done', text, now) };
      }
      break;
    }
    case 'result': {
      const turn = ed.peek();
      if (turn) {
        turn.done = true;
        turn.endedAt = now;
        turn.durationMs = msg.duration_ms ?? now - turn.startedAt;
        turn.interrupted = Boolean(t.stopRequested);
        if (msg.is_error && !t.stopRequested) {
          const errs = Array.isArray(msg.errors) ? msg.errors.join('\n') : '';
          turn.error = (msg.result || errs || msg.subtype || tr('common.error')).toString().slice(0, 600);
        }
        turn.items = turn.items.map((x) =>
          x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'error' as const, endedAt: now } : x,
        );
      }
      t.status = 'idle';
      t.activity = undefined;
      t.stopRequested = false;
      rt.stream.clear();
      break;
    }
  }
  return t;
}

const META_PREFIXES = ['<local-command', 'Caveat:', '<system-reminder>', '<bash-input>', '<bash-stdout>', '<bash-stderr>'];

function userTextOf(content: any): { text: string; images: ImageAttachment[] } | null {
  let text = '';
  const images: ImageAttachment[] = [];
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') text += (text ? '\n' : '') + b.text;
      else if (b?.type === 'image' && b.source?.type === 'base64')
        images.push({ id: uid(), mediaType: b.source.media_type, data: b.source.data });
    }
    if (!text && !images.length) return null;
  } else return null;

  const trimmed = text.trim();
  const cmd = trimmed.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (cmd) {
    const args = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return { text: [cmd[1].startsWith('/') ? cmd[1] : '/' + cmd[1], args].filter(Boolean).join(' '), images };
  }
  if (META_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
  return { text: trimmed, images };
}

/** Builds entries from a saved Claude Code transcript. */
export function entriesFromHistory(messages: any[]): Entry[] {
  const entries: Entry[] = [];
  const now = Date.now();
  const closeTurn = () => {
    const last = entries[entries.length - 1];
    if (last?.kind === 'turn' && !last.done) {
      entries[entries.length - 1] = {
        ...last,
        done: true,
        historical: true,
        items: last.items.map((x) => (x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'done' as const } : x)),
      };
    }
  };
  for (const m of messages) {
    if (m.parent_tool_use_id || m.isSidechain) continue;
    const message = m.message ?? {};
    if (m.type === 'user') {
      const content = message.content;
      const hasToolResult = Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result');
      if (hasToolResult) {
        const ed = new TurnEditor(entries, now);
        applyToolResults(ed, content, now);
        if (m.uuid && ed.peek()) ed.get().lastUuid = m.uuid;
        continue;
      }
      const u = userTextOf(content);
      if (!u) continue;
      if (u.text.startsWith('<task-notification>')) {
        // Claude Code injects background-task results as user messages; show them as notices.
        const summary = u.text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? tr('reduce.bgTaskDone');
        const failed = /<status>(failed|killed|stopped)<\/status>/.test(u.text);
        const toolUseId = u.text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim();
        const spawnedAgent =
          toolUseId &&
          entries.some((e) => e.kind === 'turn' && e.items.some((x) => x.kind === 'tool' && x.id === toolUseId && isAgentTool(x.name)));
        const notice: Item = spawnedAgent
          ? { kind: 'agentevent', id: uid(), agentId: toolUseId!, status: failed ? 'error' : 'done' }
          : { kind: 'notice', id: uid(), text: summary, tone: failed ? 'warn' : 'info' };
        const ed = new TurnEditor(entries, now);
        if (ed.peek()) ed.push(notice);
        else {
          const last = entries[entries.length - 1];
          if (last?.kind === 'turn') entries[entries.length - 1] = { ...last, items: [...last.items, notice] };
        }
        continue;
      }
      if (u.text.startsWith('[Request interrupted')) {
        const ed = new TurnEditor(entries, now);
        if (ed.peek()) ed.push({ kind: 'notice', id: uid(), text: tr('reduce.interrupted'), tone: 'warn' });
        continue;
      }
      closeTurn();
      const summary = m.isCompactSummary === true || /^This session is being continued from a previous conversation/i.test(u.text);
      entries.push({ kind: 'user', id: uid(), uuid: m.uuid, text: u.text, images: u.images, ts: now, ...(summary ? { summary } : {}) });
    } else if (m.type === 'assistant') {
      const ed = new TurnEditor(entries, now);
      applyAssistantContent(ed, message.id, message.content, now);
      if (m.uuid) tagUuid(ed.get(), m.uuid);
    }
  }
  closeTurn();
  return entries.map((e) => (e.kind === 'turn' ? { ...e, historical: true } : e));
}

// Folds desk events (live stream or a saved transcript) into UI entries. Provider-neutral:
// every agent provider translates its own messages into DeskEvent (see ../events.ts).
import type { AgentRun, BgTask, Entry, Item, ProviderId, Thread, Turn } from '../types';
import type { DeskEvent } from '../events';
import { DESK_AGENT_TOOL, subStepLabel } from './tools';
import { uid } from './format';
import { t as tr } from '../i18n';

class TurnEditor {
  private turn: Turn | null = null;
  constructor(
    private entries: Entry[],
    private now: number,
    private provider?: ProviderId,
  ) {}

  get(): Turn {
    if (this.turn) return this.turn;
    const idx = this.entries.length - 1;
    const last = this.entries[idx];
    if (!last || last.kind !== 'turn' || last.done) {
      this.turn = { kind: 'turn', id: uid(), items: [], startedAt: this.now, done: false, ...(this.provider ? { provider: this.provider } : {}) };
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

  /** Searches every turn (newest first) for an item; used for late tool results. */
  patchItem(id: string, fn: (item: Item) => Partial<Item>) {
    const open = this.peek();
    if (open) {
      const i = open.items.findIndex((x) => x.id === id);
      if (i >= 0) {
        this.patch(i, fn(open.items[i]));
        return true;
      }
    }
    for (let e = this.entries.length - 1; e >= 0; e--) {
      const entry = this.entries[e];
      if (entry.kind !== 'turn' || entry === this.turn) continue;
      const i = entry.items.findIndex((x) => x.id === id);
      if (i >= 0) {
        const items = [...entry.items];
        items[i] = { ...items[i], ...fn(items[i]) } as Item;
        this.entries[e] = { ...entry, items };
        return true;
      }
    }
    return false;
  }
}

/** Applies a text/thinking/tool event to an item list (the main feed or a subagent's transcript). */
function applyContent(ed: TurnEditor, ev: DeskEvent, now: number): boolean {
  switch (ev.type) {
    case 'text': {
      const i = ed.findIndex((x) => x.id === ev.id);
      if (i < 0) {
        if (ev.mode === 'final' && !ev.text.trim()) return true;
        ed.push({ kind: 'text', id: ev.id, text: ev.text, confirmed: ev.mode === 'final' });
      } else {
        const cur = ed.get().items[i] as any;
        if (ev.mode === 'final') ed.patch(i, { text: ev.text, confirmed: true });
        else if (!cur.confirmed) ed.patch(i, { text: cur.text + ev.text });
      }
      return true;
    }
    case 'thinking': {
      const i = ed.findIndex((x) => x.id === ev.id);
      if (i < 0) {
        if (ev.mode === 'end') return true;
        ed.push({ kind: 'thinking', id: ev.id, text: ev.text, confirmed: ev.mode === 'final', startedAt: now, ...(ev.mode === 'final' ? { endedAt: now } : {}) });
      } else {
        const cur = ed.get().items[i] as any;
        if (ev.mode === 'final') ed.patch(i, { text: ev.text || cur.text, confirmed: true, endedAt: cur.endedAt ?? now });
        else if (ev.mode === 'end') !cur.endedAt && ed.patch(i, { endedAt: now });
        else if (!cur.confirmed) ed.patch(i, { text: cur.text + ev.text });
      }
      return true;
    }
    case 'tool': {
      const i = ed.findIndex((x) => x.kind === 'tool' && x.id === ev.id);
      if (i >= 0) ed.patch(i, { name: ev.name, ...(ev.input !== undefined ? { input: ev.input } : {}) });
      else ed.push({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input ?? {}, inputJson: '', status: 'running', startedAt: now, subSteps: 0 });
      return true;
    }
    case 'tool.delta': {
      const i = ed.findIndex((x) => x.kind === 'tool' && x.id === ev.id);
      if (i < 0) return true;
      const cur = ed.get().items[i] as any;
      const inputJson = cur.inputJson + ev.json;
      let input = cur.input;
      // Tool inputs can contain whole files: do not parse unfinished JSON on every token.
      let end = inputJson.length - 1;
      while (end >= 0 && /\s/.test(inputJson[end])) end--;
      if (inputJson[end] === '}' || inputJson[end] === ']') {
        try { input = JSON.parse(inputJson); } catch {}
      }
      ed.patch(i, { inputJson, input });
      return true;
    }
    case 'tool.output':
      ed.patchItem(ev.id, (x) => ({ result: ((x as any).result ?? '') + ev.chunk }));
      return true;
    case 'tool.result':
      ed.patchItem(ev.id, () => ({ ...(ev.images?.length ? { images: ev.images } : {}), result: ev.result, status: ev.status, endedAt: now }));
      return true;
  }
  return false;
}

// ---------- subagents ----------

function newAgent(agents: Record<string, AgentRun>, id: string, now: number, historical: boolean): AgentRun {
  return {
    id,
    name: tr('reduce.agent'),
    prompt: '',
    color: Object.keys(agents).length,
    status: 'running',
    background: true,
    // Saved transcripts have no timing for agents.
    startedAt: historical ? 0 : now,
    items: [],
    toolUses: 0,
    ...(historical ? { historical: true } : {}),
  };
}

function finishAgent(agent: AgentRun, status: AgentRun['status'], result: string | undefined, now: number): AgentRun {
  const items = agent.items.map((x) => (x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'done' as const } : x));
  return { ...agent, status, endedAt: agent.endedAt ?? now, result: agent.result || result, items };
}

function applyAgent(agents: Record<string, AgentRun>, ev: Extract<DeskEvent, { type: 'agent' }>, now: number, historical: boolean) {
  const cur = agents[ev.id];
  const base = cur ?? { ...newAgent(agents, ev.id, now, historical), name: ev.name ?? ev.agentType ?? tr('reduce.agent') };
  let next: AgentRun = {
    ...base,
    ...(ev.name ? { name: ev.name } : {}),
    ...(ev.agentType ? { type: ev.agentType } : {}),
    ...(ev.model ? { model: ev.model } : {}),
    ...(ev.provider ? { provider: ev.provider } : {}),
    ...(ev.background != null ? { background: ev.background } : {}),
    ...(ev.progress ? { progress: ev.progress } : {}),
    ...(ev.toolUses != null ? { toolUses: ev.toolUses } : {}),
    ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
  };
  if (ev.prompt && ev.prompt !== base.prompt) {
    next.prompt = ev.prompt;
    const promptItem = { kind: 'agentmsg' as const, id: `${ev.id}:prompt`, agentId: ev.id, dir: 'to' as const, text: ev.prompt, label: tr('reduce.assignment') };
    const i = next.items.findIndex((x) => x.id === promptItem.id);
    next.items = i >= 0 ? next.items.map((x, n) => (n === i ? promptItem : x)) : [promptItem, ...next.items];
  }
  if (ev.status && ev.status !== 'running') next = finishAgent(next, ev.status, ev.result, now);
  // Resumed (e.g. a message sent to a finished agent): it works again.
  else if (ev.status === 'running' && base.status !== 'running') next = { ...next, status: 'running', endedAt: undefined, ...(historical ? {} : { startedAt: now }) };
  else if (ev.result) next = { ...next, result: ev.result };
  return { ...agents, [ev.id]: next };
}

/** Runs `fn` against an agent's own item list using the same editor as the main feed. */
function editAgentItems(agent: AgentRun, now: number, fn: (ed: TurnEditor) => void): AgentRun {
  const fake: Entry[] = [{ kind: 'turn', id: agent.id, items: agent.items, startedAt: 0, done: false }];
  fn(new TurnEditor(fake, now));
  return { ...agent, items: (fake[0] as Turn).items };
}

const LABELS = { assignment: 'reduce.assignment', report: 'reduce.report', message: 'reduce.message' } as const;

/** The answer text of a run_agent result (without its "run_id: …" header). */
const deskAgentAnswer = (result: string) => result.replace(/^run_id: [^\n]*\nstatus: [^\n]*\n\n?/, '');

/**
 * A run_agent call describes the agent it starts, so saved chats (and the moment before the core's
 * own record arrives) still show it as a subagent.
 */
function deskAgentFromTool(t: Thread, ev: DeskEvent, now: number, historical: boolean) {
  if (ev.type === 'tool' && ev.name === DESK_AGENT_TOOL && ev.final && ev.input?.task) {
    const task = String(ev.input.task);
    const cur = t.agents[ev.id];
    t.agents = applyAgent(
      t.agents,
      {
        type: 'agent',
        id: ev.id,
        ...(cur ? {} : { name: task.split('\n')[0].slice(0, 80) }),
        prompt: task,
        provider: ev.input.agent,
        background: Boolean(ev.input.background),
      },
      now,
      historical,
    );
  } else if (ev.type === 'tool.result' && historical && t.agents[ev.id]?.provider && t.agents[ev.id].status === 'running') {
    t.agents = applyAgent(t.agents, { type: 'agent', id: ev.id, status: ev.status === 'error' ? 'error' : 'done', result: deskAgentAnswer(ev.result) }, now, historical);
  }
}

/** Events that belong to a subagent's own transcript (ev.agent set) or to agent records. */
function applyAgentEvent(agents: Record<string, AgentRun>, ev: DeskEvent, now: number, historical: boolean): Record<string, AgentRun> | null {
  if (ev.type === 'agent') return applyAgent(agents, ev, now, historical);
  if (ev.type === 'agent.drop') {
    const { [ev.id]: _dropped, ...rest } = agents;
    return rest;
  }
  if (ev.type === 'agent.msg') {
    const agent = agents[ev.agent] ?? newAgent(agents, ev.agent, now, historical);
    const text = ev.text.trim();
    if (ev.dedupe) {
      const known = agent.items.some((x) => x.kind === 'agentmsg' && x.dir === 'to' && (x.text.trim() === text || (text && text.includes(x.text.trim()))));
      if (!text || text === agent.prompt.trim() || known) return agents;
    }
    const id = ev.id ?? uid();
    if (agent.items.some((x) => x.id === id)) return agents;
    const item: Item = { kind: 'agentmsg', id, agentId: agent.id, dir: ev.dir, text: ev.text, label: tr(LABELS[ev.label]) };
    return { ...agents, [agent.id]: { ...agent, items: [...agent.items, item] } };
  }
  const owner = (ev as { agent?: unknown }).agent;
  if (typeof owner !== 'string') return null;
  let agent = agents[owner] ?? newAgent(agents, owner, now, historical);
  const isNewTool = ev.type === 'tool' && !agent.items.some((x) => x.id === ev.id);
  agent = editAgentItems(agent, now, (ed) => applyContent(ed, ev, now));
  if (isNewTool) agent = { ...agent, toolUses: agent.toolUses + 1 };
  return { ...agents, [owner]: agent };
}

// ---------- background tasks ----------

const TASK_STATUS: Record<string, AgentRun['status']> = { completed: 'done', failed: 'error' };

function applyTask(t: Thread, ev: Extract<DeskEvent, { type: 'task' }>, now: number, pushFeed: (item: Item) => void) {
  const tasks = { ...t.tasks };
  if (ev.op === 'background') {
    for (const bt of ev.tasks) {
      const ex = tasks[bt.id];
      tasks[bt.id] = ex ? { ...ex, background: true } : { id: bt.id, description: bt.description, type: bt.taskType, status: 'running', background: true, startedAt: now };
    }
    t.tasks = tasks;
    return;
  }
  const cur = tasks[ev.id];
  if (ev.op === 'start') {
    tasks[ev.id] = {
      id: ev.id,
      description: ev.description || tr('reduce.task'),
      type: ev.taskType,
      status: 'running',
      background: Boolean(ev.background),
      startedAt: now,
      toolUseId: ev.toolUseId,
    };
  } else if (ev.op === 'update') {
    if (cur) {
      tasks[ev.id] = {
        ...cur,
        ...(ev.status ? { status: ev.status } : {}),
        ...(ev.description ? { description: ev.description } : {}),
        ...(ev.background != null ? { background: ev.background } : {}),
        ...(ev.error ? { error: ev.error } : {}),
        ...(ev.endedAt ? { endedAt: ev.endedAt } : {}),
      };
    }
  } else if (ev.op === 'progress') {
    if (cur) tasks[ev.id] = { ...cur, toolUses: ev.toolUses, lastTool: ev.lastTool };
  } else if (ev.op === 'end') {
    tasks[ev.id] = {
      ...(cur ?? { id: ev.id, description: tr('reduce.task'), startedAt: now, background: true }),
      status: ev.status,
      endedAt: now,
      summary: ev.summary,
      outputFile: ev.outputFile,
      toolUses: ev.toolUses ?? cur?.toolUses,
    } as BgTask;
  }
  t.tasks = tasks;

  // A task may be a subagent spawned by a tool call.
  const toolUseId = ev.op === 'start' || ev.op === 'end' ? ev.toolUseId : tasks[ev.id]?.toolUseId;
  const agent = toolUseId ? t.agents[toolUseId] : undefined;
  if (agent) {
    let next = agent;
    if (ev.op === 'start')
      next = { ...agent, background: agent.background || Boolean(ev.background), ...(agent.status !== 'running' ? { status: 'running' as const, endedAt: undefined, startedAt: now } : {}) };
    else if (ev.op === 'progress') next = { ...agent, progress: ev.lastTool || agent.progress, toolUses: ev.toolUses ?? agent.toolUses };
    else if (ev.op === 'end') {
      const status = TASK_STATUS[ev.status] ?? 'stopped';
      next = finishAgent(agent, status, ev.summary, now);
      pushFeed({ kind: 'agentevent', id: uid(), agentId: agent.id, status });
    }
    t.agents = { ...t.agents, [agent.id]: next };
  } else if (ev.op === 'end' && tasks[ev.id]?.background) {
    const key = ev.status === 'completed' ? 'reduce.bgTaskCompleted' : ev.status === 'failed' ? 'reduce.bgTaskFailed' : 'reduce.bgTaskStopped';
    pushFeed({ kind: 'notice', id: uid(), text: tr(key, { name: tasks[ev.id].description }), tone: ev.status === 'completed' ? 'info' : 'warn' });
  }
}

// ---------- threads ----------

/** Applies one desk event to a thread. Returns a new thread object. */
export function applyEvent(t0: Thread, ev: DeskEvent, opts: { history?: boolean } = {}): Thread {
  const historical = Boolean(opts.history);
  const last = t0.entries.at(-1);
  const now = ev.timestamp ?? (historical && last ? (last.kind === 'user' ? last.ts : last.startedAt) : Date.now());
  // Helper tokens do not edit the lead's history. Preserve its identity for memoized views.
  const agents = applyAgentEvent(t0.agents, ev, now, historical);
  if (agents) return agents === t0.agents ? t0 : { ...t0, agents };
  if (ev.type === 'session') return ev.sessionId === t0.sessionId ? t0 : { ...t0, sessionId: ev.sessionId };
  if (ev.type === 'context') return { ...t0, context: ev.usage };
  if (ev.type === 'status') return {
    ...t0,
    activity: ev.activity === 'compacting' ? tr('reduce.compacting') : ev.activity === 'retrying' ? tr('reduce.retrying', { attempt: ev.attempt, max: ev.max }) : undefined,
    ...(ev.permissionMode ? { permissionMode: ev.permissionMode } : {}),
  };
  const t: Thread = { ...t0, entries: [...t0.entries] };
  const ed = new TurnEditor(t.entries, now, t.provider);
  /** Adds an item to the open turn, or to the last turn when the agent is idle. */
  const pushFeed = (item: Item) => {
    if (ed.peek()) return ed.push(item);
    const last = t.entries[t.entries.length - 1];
    if (last?.kind === 'turn') t.entries[t.entries.length - 1] = { ...last, items: [...last.items, item] };
  };

  switch (ev.type) {
    case 'step':
      t.activity = undefined;
      // The agent can start a turn on its own (e.g. reacting to a finished background task).
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
      break;
    case 'text':
    case 'thinking':
    case 'tool':
    case 'tool.delta':
    case 'tool.output':
    case 'tool.result':
      applyContent(ed, ev, now);
      deskAgentFromTool(t, ev, now, historical);
      break;
    case 'tool.sub': {
      const turn = ed.peek();
      const i = turn ? turn.items.findIndex((x) => x.kind === 'tool' && x.id === ev.id) : -1;
      if (i >= 0) {
        const cur = turn!.items[i] as any;
        const label = subStepLabel({ type: 'tool_use', name: ev.name, input: ev.input });
        ed.patch(i, { subSteps: cur.subSteps + 1, lastSub: label, subs: [...(cur.subs ?? []), label].slice(-200) });
      }
      break;
    }
    case 'mark':
      if (ev.assistant) {
        const turn = ed.get();
        turn.lastUuid = ev.uuid;
        turn.uuids = [...(turn.uuids ?? []), ev.uuid];
      } else if (ed.peek()) ed.get().lastUuid = ev.uuid;
      break;
    case 'user': {
      closeTurn(t.entries, true);
      t.entries.push({ kind: 'user', id: uid(), uuid: ev.uuid, text: ev.text, images: ev.images, ts: now, ...(ev.summary ? { summary: true } : {}) });
      break;
    }
    case 'notice': {
      const item: Item = { kind: 'notice', id: uid(), text: ev.code ? tr(ev.code, ev.params as any) : ev.text ?? '', tone: ev.tone };
      if (ev.at === 'feed') pushFeed(item);
      else if (ev.at === 'if-open') ed.peek() && ed.push(item);
      else ed.push(item);
      if (ev.code === 'reduce.compacted') t.activity = undefined;
      break;
    }
    case 'task':
      applyTask(t, ev, now, pushFeed);
      break;
    case 'agent.mark':
      pushFeed({ kind: 'agentevent', id: uid(), agentId: ev.id, status: ev.status });
      break;
    case 'turn.end': {
      const turn = ed.peek();
      if (turn) {
        turn.done = true;
        turn.endedAt = now;
        turn.durationMs = ev.durationMs ?? now - turn.startedAt;
        turn.interrupted = Boolean(t.stopRequested);
        if (ev.isError && !t.stopRequested) turn.error = (ev.error || tr('common.error')).slice(0, 600);
        turn.items = turn.items.map((x) => (x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'error' as const, endedAt: now } : x));
      }
      t.status = 'idle';
      t.activity = undefined;
      t.stopRequested = false;
      break;
    }
  }
  return t;
}

/** Closes the open turn of a saved transcript. */
function closeTurn(entries: Entry[], historical: boolean) {
  const last = entries[entries.length - 1];
  if (last?.kind === 'turn' && !last.done) {
    entries[entries.length - 1] = {
      ...last,
      done: true,
      ...(historical ? { historical: true } : {}),
      items: last.items.map((x) => (x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'done' as const } : x)),
    };
  }
}

/** Builds entries and subagent records from a saved transcript's events. */
export function fromHistory(events: DeskEvent[], provider?: ProviderId): { entries: Entry[]; agents: Record<string, AgentRun> } {
  let t = { entries: [], agents: {}, tasks: {}, status: 'idle', provider } as unknown as Thread;
  for (const ev of events) t = applyEvent(t, ev, { history: true });
  const entries = [...t.entries];
  closeTurn(entries, true);
  const agents = Object.fromEntries(
    Object.entries(t.agents).map(([k, a]) => [k, { ...(a.status === 'running' ? finishAgent(a, 'done', undefined, 0) : a), historical: true }]),
  );
  return { entries: entries.map((e) => (e.kind === 'turn' ? { ...e, historical: true } : e)), agents };
}

/** Adds saved subagent transcripts to agents the thread already knows. */
export function applyAgentTranscripts(agents: Record<string, AgentRun>, events: DeskEvent[]): Record<string, AgentRun> {
  let out = agents;
  for (const ev of events) {
    const owner = ev.type === 'agent' ? ev.id : (ev as { agent?: unknown }).agent;
    if (typeof owner !== 'string' || !out[owner]) continue;
    out = applyAgentEvent(out, ev, 0, true) ?? out;
  }
  return out;
}

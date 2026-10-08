// Codex app-server notifications and saved thread items → desk events (renderer/src/events.ts).
// Codex items map onto the desk's tool vocabulary: shell commands → Bash, file changes → Patch
// (one row per file), MCP and client tools → mcp__<server>__<tool>, the plan → TodoWrite,
// collab agents → Agent + subagent records.

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');

/** Codex wraps errors from the API as a JSON string; pull out the readable message. */
export function errorText(err) {
  const raw = typeof err === 'string' ? err : err?.message ?? '';
  try {
    const j = JSON.parse(raw);
    return String(j?.error?.message ?? j?.message ?? raw);
  } catch {
    return String(raw);
  }
}

const shellCommand = (item) => {
  const actions = (item.commandActions ?? []).map((a) => a.command).filter(Boolean);
  return actions.length ? actions.join(' && ') : String(item.command ?? '');
};

const patchId = (itemId, i) => (i === 0 ? itemId : `${itemId}#${i}`);
const patchInput = (c) => ({
  file_path: c.path,
  kind: c.kind?.type ?? 'update',
  ...(c.kind?.move_path ? { move_path: c.kind.move_path } : {}),
  diff: c.diff ?? '',
});

const PLAN_STATUS = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' };

function mcpResult(result, error) {
  if (error) return { status: 'error', result: String(error.message ?? error) };
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n');
  const images = content.filter((c) => c?.type === 'image' && c.data).map((c) => ({ mediaType: c.mimeType ?? 'image/png', data: c.data }));
  return { status: 'done', result: text || (result?.structuredContent ? JSON.stringify(result.structuredContent, null, 2) : ''), ...(images.length ? { images } : {}) };
}

function dynamicResult(item) {
  const items = item.contentItems ?? [];
  const text = items
    .filter((c) => c.type === 'inputText')
    .map((c) => c.text)
    .join('\n');
  const images = items
    .filter((c) => c.type === 'inputImage' && /^data:/.test(c.imageUrl))
    .map((c) => {
      const [, mediaType, data] = c.imageUrl.match(/^data:([^;]+);base64,(.*)$/) ?? [];
      return { mediaType, data };
    })
    .filter((x) => x.data);
  return { status: item.success === false || item.status === 'failed' ? 'error' : 'done', result: text, ...(images.length ? { images } : {}) };
}

const statusOf = (s) => (s === 'completed' ? 'done' : 'error');

/** User input items → text and images. */
export function userInputText(content = []) {
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  const images = content
    .filter((c) => c.type === 'image' && /^data:/.test(c.url))
    .map((c, i) => {
      const [, mediaType, data] = c.url.match(/^data:([^;]+);base64,(.*)$/) ?? [];
      return { id: `img-${i}`, mediaType, data };
    })
    .filter((x) => x.data);
  return { text, images };
}

/**
 * Events for one item. phase 'start' = item/started, 'end' = item/completed (also used for saved items).
 * agent = the collab spawn item this item belongs to (subagent transcripts).
 */
export function itemEvents(item, phase, agent) {
  const a = agent ? { agent } : {};
  const out = [];
  switch (item.type) {
    case 'agentMessage':
      out.push({ type: 'text', id: item.id, text: phase === 'end' ? item.text ?? '' : '', mode: phase === 'end' ? 'final' : 'delta', ...a });
      break;
    case 'reasoning': {
      const text = (item.summary?.length ? item.summary : item.content ?? []).join('\n\n');
      out.push({ type: 'thinking', id: item.id, text: phase === 'end' ? text : '', mode: phase === 'end' ? 'final' : 'delta', ...a });
      break;
    }
    case 'commandExecution': {
      const command = shellCommand(item);
      out.push({ type: 'tool', id: item.id, name: 'Bash', input: { command, ...(command !== item.command ? { description: item.command } : {}) }, final: true, ...a });
      if (phase === 'end') {
        let result = stripAnsi(item.aggregatedOutput ?? '').trimEnd();
        if (item.exitCode != null && item.exitCode !== 0) result += `${result ? '\n' : ''}(exit code ${item.exitCode})`;
        out.push({ type: 'tool.result', id: item.id, status: item.status === 'completed' ? 'done' : 'error', result, ...a });
      }
      break;
    }
    case 'fileChange':
      (item.changes ?? []).forEach((c, i) => {
        out.push({ type: 'tool', id: patchId(item.id, i), name: 'Patch', input: patchInput(c), final: true, ...a });
        if (phase === 'end') out.push({ type: 'tool.result', id: patchId(item.id, i), status: statusOf(item.status), result: '', ...a });
      });
      break;
    case 'mcpToolCall':
      out.push({ type: 'tool', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {}, final: true, ...a });
      if (phase === 'end') out.push({ type: 'tool.result', id: item.id, ...mcpResult(item.result, item.error), ...a });
      break;
    case 'dynamicToolCall':
      out.push({ type: 'tool', id: item.id, name: `mcp__${item.namespace || 'desk'}__${item.tool}`, input: item.arguments ?? {}, final: true, ...a });
      if (phase === 'end') out.push({ type: 'tool.result', id: item.id, ...dynamicResult(item), ...a });
      break;
    case 'webSearch': {
      const act = item.action ?? {};
      if (act.type === 'openPage') out.push({ type: 'tool', id: item.id, name: 'WebFetch', input: { url: act.url ?? '' }, final: true, ...a });
      else out.push({ type: 'tool', id: item.id, name: 'WebSearch', input: { query: item.query || act.query || (act.queries ?? []).join(', ') }, final: true, ...a });
      if (phase === 'end') out.push({ type: 'tool.result', id: item.id, status: 'done', result: '', ...a });
      break;
    }
    case 'imageView':
      out.push({ type: 'tool', id: item.id, name: 'Read', input: { file_path: item.path }, final: true, ...a });
      if (phase === 'end') out.push({ type: 'tool.result', id: item.id, status: 'done', result: '', ...a });
      break;
    case 'imageGeneration':
      out.push({ type: 'tool', id: item.id, name: 'ImageGeneration', input: { prompt: item.revisedPrompt ?? '' }, final: true, ...a });
      if (phase === 'end') out.push({ type: 'tool.result', id: item.id, status: item.status === 'failed' ? 'error' : 'done', result: item.savedPath ?? '', ...a });
      break;
    case 'collabAgentToolCall':
      out.push(...collabEvents(item, phase, a));
      break;
    case 'contextCompaction':
      if (phase === 'end') out.push({ type: 'notice', code: 'reduce.compacted', tone: 'info', at: 'open' });
      break;
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      if (phase === 'end' && item.review) out.push({ type: 'notice', text: item.review, tone: 'info', at: 'open' });
      break;
  }
  return out;
}

/** Codex's own subagents (collab tools): spawnAgent becomes an Agent row plus a subagent record. */
function collabEvents(item, phase, a) {
  const out = [];
  if (item.tool === 'spawnAgent') {
    const prompt = item.prompt ?? '';
    out.push({ type: 'tool', id: item.id, name: 'Agent', input: { description: prompt.split('\n')[0].slice(0, 80), prompt, ...(item.model ? { model: item.model } : {}) }, final: true, ...a });
    if (!a.agent) out.push({ type: 'agent', id: item.id, prompt, background: true, ...(item.model ? { model: item.model } : {}) });
    if (phase === 'end') {
      const state = Object.values(item.agentsStates ?? {})[0];
      out.push({ type: 'tool.result', id: item.id, status: item.status === 'failed' ? 'error' : 'done', result: state?.message ?? '', ...a });
      if (!a.agent && item.status === 'failed') out.push({ type: 'agent', id: item.id, status: 'error', result: state?.message ?? '' });
    }
  } else {
    out.push({ type: 'tool', id: item.id, name: `Agent.${item.tool}`, input: { ...(item.prompt ? { prompt: item.prompt } : {}), targets: item.receiverThreadIds ?? [] }, final: true, ...a });
    if (phase === 'end') out.push({ type: 'tool.result', id: item.id, status: item.status === 'failed' ? 'error' : 'done', result: '', ...a });
  }
  return out;
}

const COLLAB_DONE = { completed: 'done', errored: 'error', interrupted: 'stopped', shutdown: 'done', notFound: 'error' };

/**
 * Live translator for one Codex thread. push(method, params) → desk events.
 * Subagent threads spawned by collab tools are routed into their spawn item's agent transcript.
 */
export function createTranslator() {
  let turnId = null;
  let lastText = '';
  let lastError = '';
  /** child thread id → spawn item id */
  const children = new Map();
  /** reasoning item id → summary parts seen */
  const parts = new Map();

  return {
    get turnId() {
      return turnId;
    },
    /** Thread ids this translator follows besides its own (collab subagents). */
    children,

    push(method, p, ownThreadId) {
      const out = [];
      const agent = p.threadId && p.threadId !== ownThreadId ? children.get(p.threadId) : undefined;
      if (p.threadId && p.threadId !== ownThreadId && !agent) return out;
      const a = agent ? { agent } : {};
      switch (method) {
        case 'turn/started':
          if (agent) break;
          turnId = p.turn?.id ?? turnId;
          lastText = '';
          lastError = '';
          out.push({ type: 'step' });
          break;
        case 'item/started':
          if (!agent && p.item?.type !== 'userMessage') out.push({ type: 'step' });
          out.push(...itemEvents(p.item, 'start', agent));
          break;
        case 'item/completed': {
          const item = p.item;
          if (!agent && item.type === 'agentMessage' && item.text) lastText = item.text;
          out.push(...itemEvents(item, 'end', agent));
          if (!agent && item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
            for (const id of item.receiverThreadIds ?? []) children.set(id, item.id);
            const state = Object.values(item.agentsStates ?? {})[0];
            if (state && COLLAB_DONE[state.status]) out.push({ type: 'agent', id: item.id, status: COLLAB_DONE[state.status], result: state.message ?? '' });
          }
          if (!agent && item.type === 'collabAgentToolCall' && item.tool !== 'spawnAgent') {
            for (const [tid, state] of Object.entries(item.agentsStates ?? {})) {
              const spawn = children.get(tid);
              if (spawn && COLLAB_DONE[state.status]) out.push({ type: 'agent', id: spawn, status: COLLAB_DONE[state.status], result: state.message ?? '' });
            }
          }
          break;
        }
        case 'item/agentMessage/delta':
          out.push({ type: 'text', id: p.itemId, text: p.delta, mode: 'delta', ...a });
          break;
        case 'item/reasoning/summaryPartAdded':
          parts.set(p.itemId, (parts.get(p.itemId) ?? 0) + 1);
          if (p.summaryIndex > 0) out.push({ type: 'thinking', id: p.itemId, text: '\n\n', mode: 'delta', ...a });
          break;
        case 'item/reasoning/summaryTextDelta':
          out.push({ type: 'thinking', id: p.itemId, text: p.delta, mode: 'delta', ...a });
          break;
        case 'item/commandExecution/outputDelta':
          out.push({ type: 'tool.output', id: p.itemId, chunk: stripAnsi(p.delta), ...a });
          break;
        case 'item/fileChange/patchUpdated':
          (p.changes ?? []).forEach((c, i) => out.push({ type: 'tool', id: patchId(p.itemId, i), name: 'Patch', input: patchInput(c), final: true, ...a }));
          break;
        case 'turn/plan/updated':
          if (agent) break;
          out.push({
            type: 'tool',
            id: `plan-${p.turnId}`,
            name: 'TodoWrite',
            input: { todos: (p.plan ?? []).map((s) => ({ content: s.step, activeForm: s.step, status: PLAN_STATUS[s.status] ?? 'pending' })) },
            final: true,
          });
          out.push({ type: 'tool.result', id: `plan-${p.turnId}`, status: 'done', result: p.explanation ?? '' });
          break;
        case 'error':
          if (agent) break;
          if (p.willRetry) out.push({ type: 'status', activity: 'retrying' });
          else lastError = errorText(p.error);
          break;
        case 'turn/completed': {
          if (agent) break;
          const turn = p.turn ?? {};
          const failed = turn.status === 'failed';
          out.push({
            type: 'turn.end',
            durationMs: turn.durationMs ?? undefined,
            isError: failed,
            ...(failed ? { error: errorText(turn.error) || lastError } : {}),
            text: lastText,
          });
          turnId = null;
          break;
        }
        case 'thread/tokenUsage/updated': {
          if (agent) break;
          const u = p.tokenUsage ?? {};
          const used = u.last?.totalTokens ?? 0;
          const max = u.modelContextWindow ?? 0;
          if (max) out.push({ type: 'context', usage: { totalTokens: used, maxTokens: max, percentage: Math.round((used / max) * 1000) / 10, categories: [] } });
          break;
        }
        case 'warning':
          if (!agent && p.message) out.push({ type: 'notice', text: String(p.message), tone: 'warn', at: 'feed' });
          break;
        case 'model/rerouted':
          if (!agent) out.push({ type: 'notice', text: `${p.fromModel ?? ''} → ${p.toModel ?? ''}`.trim(), tone: 'info', at: 'feed' });
          break;
      }
      return out;
    },
  };
}

/** Rate-limit snapshot → desk limits event (Codex windows: 5 h and weekly). */
export function limitsEvent(rl) {
  if (!rl) return null;
  const ev = { type: 'limits' };
  for (const w of [rl.primary, rl.secondary]) {
    if (!w) continue;
    const win = { pct: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null };
    if ((w.windowDurationMins ?? 0) <= 600) ev.session = win;
    else ev.weekly = win;
  }
  if (rl.rateLimitReachedType) ev.rejected = true;
  return ev;
}

/** A saved thread (thread/read with turns) as desk events. */
export function historyEvents(thread) {
  const out = [];
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const { text, images } = userInputText(item.content);
        out.push({ type: 'user', text, images });
        continue;
      }
      if (item.type === 'reasoning' && !(item.summary?.length || item.content?.length)) continue;
      out.push(...itemEvents(item, 'end'));
    }
    if (turn.status === 'failed' && turn.error) out.push({ type: 'notice', text: errorText(turn.error), tone: 'error', at: 'open' });
    if (turn.status === 'interrupted') out.push({ type: 'notice', code: 'reduce.interrupted', tone: 'warn', at: 'if-open' });
  }
  return out;
}

/** Saved collab subagent threads as desk events of their spawn items. */
export function subagentEvents(spawns) {
  const out = [];
  for (const { spawnId, thread } of spawns) {
    for (const turn of thread?.turns ?? []) {
      for (const item of turn.items ?? []) {
        if (item.type === 'userMessage') {
          const { text } = userInputText(item.content);
          if (text) out.push({ type: 'agent.msg', agent: spawnId, dir: 'to', text, label: 'message', dedupe: true });
          continue;
        }
        if (item.type === 'reasoning' && !(item.summary?.length || item.content?.length)) continue;
        out.push(...itemEvents(item, 'end', spawnId));
      }
    }
  }
  return out;
}

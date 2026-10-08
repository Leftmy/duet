// Agent SDK messages → desk events (renderer/src/events.ts). All Claude Code specifics live here:
// streaming blocks, the Agent/Task/SendMessage tools, subagent sidechains, task_* notifications.
// One translator per stream: 'live' for a running query, 'history' for a saved transcript.
import { randomUUID } from 'node:crypto';
import { t } from '../../i18n.mjs';

const META_PREFIXES = ['<local-command', 'Caveat:', '<system-reminder>', '<bash-input>', '<bash-stdout>', '<bash-stderr>'];

export const isAgentTool = (name) => name === 'Agent' || name === 'Task';

export function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? t('core.imagePlaceholder') : ''))
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/** Visible text and images of a user message, or null for Claude Code's own meta messages. */
export function userTextOf(content) {
  let text = '';
  const images = [];
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') text += (text ? '\n' : '') + b.text;
      else if (b?.type === 'image' && b.source?.type === 'base64') images.push({ id: randomUUID(), mediaType: b.source.media_type, data: b.source.data });
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

function toolImages(content) {
  return Array.isArray(content)
    ? content.filter((c) => c?.type === 'image' && c.source?.type === 'base64').map((c) => ({ mediaType: c.source.media_type, data: c.source.data }))
    : [];
}

/** Agent run fields from an Agent/Task tool input. */
function agentFields(input = {}) {
  return {
    ...(input.name || input.description ? { name: String(input.name || input.description) } : {}),
    ...(input.subagent_type ? { agentType: input.subagent_type } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.prompt ? { prompt: String(input.prompt) } : {}),
    ...(input.run_in_background != null ? { background: input.run_in_background !== false } : {}),
  };
}

const ERROR_CODES = { rate_limit: 'reduce.errRateLimit', authentication_failed: 'reduce.errAuth', billing_error: 'reduce.errBilling', overloaded: 'reduce.errOverloaded' };

/**
 * @param {'live' | 'history'} mode
 * @returns {{ push(msg: any): object[] }}
 */
export function createTranslator(mode = 'live') {
  let msgId;
  /** content block index of the current message → streaming item id */
  const stream = new Map();
  /** streamed text/thinking items not yet confirmed by their assistant message */
  let pending = [];
  /** tool id → { name, json } */
  const tools = new Map();
  /** subagents spawned by the lead: tool id → { name, background, running, msgs } */
  const agents = new Map();
  let seq = 0;
  const nid = () => `c${++seq}-${randomUUID().slice(0, 8)}`;

  const upsertAgent = (out, id, input) => {
    const f = agentFields(input);
    let a = agents.get(id);
    if (!a) agents.set(id, (a = { name: undefined, background: true, running: true, msgs: 0 }));
    if (f.name) a.name = f.name;
    if (f.background != null) a.background = f.background;
    out.push({ type: 'agent', id, ...f });
  };

  /** Confirms streamed items with the final content of an assistant message. */
  const assistantContent = (out, id, content, agent) => {
    for (const block of content ?? []) {
      if (block.type === 'text') {
        const i = agent ? -1 : pending.findIndex((p) => p.kind === 'text' && p.msgId === id);
        if (i >= 0) out.push({ type: 'text', id: pending.splice(i, 1)[0].id, text: block.text, mode: 'final' });
        else if (block.text?.trim()) out.push({ type: 'text', id: nid(), text: block.text, mode: 'final', ...(agent ? { agent } : {}) });
      } else if (block.type === 'thinking') {
        const i = agent ? -1 : pending.findIndex((p) => p.kind === 'thinking' && p.msgId === id);
        const itemId = i >= 0 ? pending.splice(i, 1)[0].id : nid();
        out.push({ type: 'thinking', id: itemId, text: block.thinking ?? '', mode: 'final', ...(agent ? { agent } : {}) });
      } else if (block.type === 'tool_use') {
        if (!agent) tools.set(block.id, { name: block.name, json: tools.get(block.id)?.json ?? '' });
        out.push({ type: 'tool', id: block.id, name: block.name, input: block.input, final: true, ...(agent ? { agent } : {}) });
      }
    }
  };

  const toolResults = (out, content, agent) => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const images = toolImages(block.content);
      out.push({
        type: 'tool.result',
        id: block.tool_use_id,
        status: block.is_error ? 'error' : 'done',
        result: resultText(block.content),
        ...(images.length ? { images } : {}),
        ...(agent ? { agent } : {}),
      });
    }
  };

  /** The lead's own tool calls that drive subagents. */
  const leadToolUse = (out, block) => {
    if (isAgentTool(block.name)) upsertAgent(out, block.id, block.input);
    else if (block.name === 'SendMessage' && block.input) {
      const to = String(block.input.to ?? block.input.recipient ?? '');
      const target =
        [...agents].find(([id, a]) => a.name === to || id === to)?.[0] ?? [...agents].find(([, a]) => a.running)?.[0];
      const text = String(block.input.message ?? block.input.content ?? '');
      if (target && text) out.push({ type: 'agent.msg', agent: target, id: `${block.id}:msg`, dir: 'to', text, label: 'message' });
    }
  };

  /** Finishes subagents whose spawning tool call returned. */
  const agentResults = (out, content, history) => {
    for (const block of Array.isArray(content) ? content : []) {
      const a = block?.type === 'tool_result' ? agents.get(block.tool_use_id) : undefined;
      if (!a || !a.running) continue;
      const text = resultText(block.content);
      // Rejected before it ever ran (bad input): it was never an agent.
      if (block.is_error && text.includes('<tool_use_error>') && (history || a.msgs === 0)) {
        agents.delete(block.tool_use_id);
        out.push({ type: 'agent.drop', id: block.tool_use_id });
        continue;
      }
      // A background agent's tool result is only the launch receipt; it finishes via task_notification.
      const receipt = !block.is_error && (history ? /^Async agent launched|agentId:/i.test(text.trim()) : a.background && /background|launched|async|agentId/i.test(text.slice(0, 400)));
      if (receipt && !history) continue;
      a.running = false;
      out.push({ type: 'agent', id: block.tool_use_id, status: block.is_error ? 'error' : 'done', ...(receipt ? {} : { result: text }) });
    }
  };

  /** A subagent's own message (live sidechain or a saved subagent transcript). */
  const subagentMessage = (out, msg) => {
    const parent = msg.parent_tool_use_id;
    const a = agents.get(parent);
    if (a) a.msgs++;
    const content = msg.message?.content;
    if (msg.type === 'assistant') {
      const blocks = Array.isArray(content) ? content : [];
      const handback = blocks.find((b) => b.type === 'tool_use' && b.name === 'SubagentHandback');
      assistantContent(out, msg.message?.id, blocks.filter((b) => b !== handback), parent);
      if (handback) {
        const text = String(handback.input?.message ?? handback.input?.report ?? '');
        out.push({ type: 'agent', id: parent, result: text });
        out.push({ type: 'agent.msg', agent: parent, id: `${parent}:report`, dir: 'from', text, label: 'report' });
      }
      const first = blocks.find((b) => b.type === 'tool_use');
      if (first && mode === 'live') out.push({ type: 'tool.sub', id: parent, name: first.name, input: first.input });
    } else if (msg.type === 'user') {
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) toolResults(out, content, parent);
      else {
        const text = userTextOf(content)?.text.trim();
        if (text) out.push({ type: 'agent.msg', agent: parent, dir: 'to', text, label: 'message', dedupe: true });
      }
    }
  };

  const system = (out, msg) => {
    switch (msg.subtype) {
      case 'init':
        out.push({ type: 'session', sessionId: msg.session_id, ...(msg.model ? { model: msg.model } : {}) });
        return;
      case 'status':
        out.push({ type: 'status', activity: msg.status === 'compacting' ? 'compacting' : null, ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}) });
        return;
      case 'api_retry':
        out.push({ type: 'status', activity: 'retrying', attempt: msg.attempt, max: msg.max_retries });
        return;
      case 'compact_boundary':
        out.push({ type: 'notice', code: 'reduce.compacted', tone: 'info', at: 'open' });
        out.push({ type: 'status', activity: null });
        return;
      case 'task_started':
        out.push({
          type: 'task',
          op: 'start',
          id: msg.task_id,
          description: msg.description || msg.subagent_type || undefined,
          taskType: msg.task_type ?? msg.subagent_type,
          background: Boolean(msg.is_backgrounded),
          toolUseId: msg.tool_use_id,
        });
        if (msg.is_backgrounded && agents.has(msg.tool_use_id)) agents.get(msg.tool_use_id).background = true;
        return;
      case 'task_updated': {
        const p = msg.patch ?? {};
        out.push({
          type: 'task',
          op: 'update',
          id: msg.task_id,
          ...(p.status ? { status: p.status } : {}),
          ...(p.description ? { description: p.description } : {}),
          ...(p.is_backgrounded != null ? { background: p.is_backgrounded } : {}),
          ...(p.error ? { error: p.error } : {}),
          ...(p.end_time ? { endedAt: p.end_time } : {}),
        });
        return;
      }
      case 'task_progress':
        out.push({ type: 'task', op: 'progress', id: msg.task_id, toolUses: msg.usage?.tool_uses, lastTool: msg.summary || msg.last_tool_name });
        return;
      case 'task_notification': {
        const a = agents.get(msg.tool_use_id);
        if (a) a.running = false;
        out.push({
          type: 'task',
          op: 'end',
          id: msg.task_id,
          status: msg.status,
          summary: msg.summary,
          outputFile: msg.output_file,
          toolUses: msg.usage?.tool_uses,
          toolUseId: msg.tool_use_id,
        });
        return;
      }
      case 'background_tasks_changed':
        out.push({
          type: 'task',
          op: 'background',
          tasks: (msg.tasks ?? []).filter((bt) => !bt.ambient).map((bt) => ({ id: bt.task_id, description: bt.description, taskType: bt.task_type })),
        });
        return;
    }
  };

  const streamEvent = (out, ev) => {
    if (ev.type === 'message_start') {
      msgId = ev.message?.id;
      out.push({ type: 'step' });
    } else if (ev.type === 'content_block_start') {
      const cb = ev.content_block;
      const key = `${msgId}:${ev.index}`;
      if (cb.type === 'text' || cb.type === 'thinking') {
        const id = nid();
        stream.set(key, id);
        pending.push({ kind: cb.type, id, msgId });
        out.push({ type: cb.type, id, text: (cb.type === 'text' ? cb.text : cb.thinking) ?? '', mode: 'delta' });
      } else if (cb.type === 'tool_use') {
        stream.set(key, cb.id);
        tools.set(cb.id, { name: cb.name, json: '' });
        out.push({ type: 'tool', id: cb.id, name: cb.name, input: {} });
        if (isAgentTool(cb.name)) upsertAgent(out, cb.id, {});
      }
    } else if (ev.type === 'content_block_delta') {
      const id = stream.get(`${msgId}:${ev.index}`);
      if (!id) return;
      const d = ev.delta;
      if (d.type === 'text_delta') out.push({ type: 'text', id, text: d.text, mode: 'delta' });
      else if (d.type === 'thinking_delta') out.push({ type: 'thinking', id, text: d.thinking, mode: 'delta' });
      else if (d.type === 'input_json_delta') {
        out.push({ type: 'tool.delta', id, json: d.partial_json });
        const tool = tools.get(id);
        if (tool && isAgentTool(tool.name)) {
          tool.json += d.partial_json;
          try {
            upsertAgent(out, id, JSON.parse(tool.json));
          } catch {}
        }
      }
    } else if (ev.type === 'content_block_stop') {
      const id = stream.get(`${msgId}:${ev.index}`);
      if (id && pending.some((p) => p.id === id && p.kind === 'thinking')) out.push({ type: 'thinking', id, text: '', mode: 'end' });
    }
  };

  const live = (out, msg) => {
    switch (msg.type) {
      case 'system':
        return system(out, msg);
      case 'stream_event':
        if (!msg.parent_tool_use_id) streamEvent(out, msg.event);
        return;
      case 'assistant':
        if (msg.parent_tool_use_id) return subagentMessage(out, msg);
        assistantContent(out, msg.message?.id, msg.message?.content);
        if (msg.uuid) out.push({ type: 'mark', uuid: msg.uuid, assistant: true });
        for (const block of msg.message?.content ?? []) if (block.type === 'tool_use') leadToolUse(out, block);
        if (msg.error) {
          const code = typeof msg.error === 'string' ? msg.error : msg.error?.type;
          out.push({ type: 'notice', code: ERROR_CODES[code] ?? 'reduce.errGeneric', params: { code }, tone: 'error', at: 'open' });
        }
        return;
      case 'user': {
        if (msg.parent_tool_use_id) return subagentMessage(out, msg);
        const content = msg.message?.content;
        toolResults(out, content);
        if (msg.uuid) out.push({ type: 'mark', uuid: msg.uuid, assistant: false });
        agentResults(out, content, false);
        return;
      }
      case 'result':
        pending = [];
        stream.clear();
        out.push({
          type: 'turn.end',
          durationMs: msg.duration_ms,
          isError: Boolean(msg.is_error),
          ...(msg.is_error ? { error: String(msg.result || (Array.isArray(msg.errors) ? msg.errors.join('\n') : '') || msg.subtype || '').slice(0, 600) } : {}),
          text: msg.result ?? '',
          costUsd: msg.total_cost_usd ?? 0,
        });
        return;
      case 'rate_limit_event': {
        const info = msg.rate_limit_info ?? {};
        const win = info.utilization != null ? { pct: info.utilization, resetsAt: info.resetsAt } : undefined;
        out.push({
          type: 'limits',
          ...(win && info.rateLimitType === 'five_hour' ? { session: win } : {}),
          ...(win && info.rateLimitType === 'seven_day' ? { weekly: win } : {}),
          ...(info.status === 'rejected' ? { rejected: true } : {}),
        });
        return;
      }
    }
  };

  const history = (out, m) => {
    if (m.parent_tool_use_id || m.isSidechain) return;
    const message = m.message ?? {};
    if (m.type === 'user') {
      const content = message.content;
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
        toolResults(out, content);
        agentResults(out, content, true);
        if (m.uuid) out.push({ type: 'mark', uuid: m.uuid, assistant: false });
        return;
      }
      const u = userTextOf(content);
      if (!u) return;
      if (u.text.startsWith('<task-notification>')) {
        // Claude Code injects background-task results as user messages; show them as notices.
        const failed = /<status>(failed|killed|stopped)<\/status>/.test(u.text);
        const toolUseId = u.text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim();
        if (toolUseId && tools.has(toolUseId) && isAgentTool(tools.get(toolUseId).name)) {
          out.push({ type: 'agent.mark', id: toolUseId, status: failed ? 'error' : 'done' });
        } else {
          const summary = u.text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
          out.push({ type: 'notice', ...(summary ? { text: summary } : { code: 'reduce.bgTaskDone' }), tone: failed ? 'warn' : 'info', at: 'feed' });
        }
        return;
      }
      if (u.text.startsWith('[Request interrupted')) {
        out.push({ type: 'notice', code: 'reduce.interrupted', tone: 'warn', at: 'if-open' });
        return;
      }
      const summary = m.isCompactSummary === true || /^This session is being continued from a previous conversation/i.test(u.text);
      out.push({ type: 'user', uuid: m.uuid, text: u.text, images: u.images, ...(summary ? { summary: true } : {}) });
    } else if (m.type === 'assistant') {
      assistantContent(out, message.id, message.content);
      if (m.uuid) out.push({ type: 'mark', uuid: m.uuid, assistant: true });
      for (const block of message.content ?? []) if (block.type === 'tool_use' && isAgentTool(block.name)) upsertAgent(out, block.id, block.input);
    }
  };

  return {
    push(msg) {
      const out = [];
      if (!msg || typeof msg !== 'object') return out;
      if (mode === 'history') history(out, msg);
      else live(out, msg);
      return out;
    },
  };
}

/** A saved transcript as desk events. */
export function historyEvents(messages) {
  const tr = createTranslator('history');
  return messages.flatMap((m) => tr.push(m));
}

/** Saved subagent transcripts (each message tagged with its spawning tool id) as desk events. */
export function subagentEvents(messages) {
  const tr = createTranslator('live');
  return messages.filter((m) => m.parent_tool_use_id && (m.type === 'assistant' || m.type === 'user')).flatMap((m) => tr.push(m));
}

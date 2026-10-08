// Shape checks for desk events (renderer/src/events.ts is the reference). Used by
// scripts/provider-check.mjs to verify a provider before it is wired into the app.

const str = (v) => typeof v === 'string';
const opt = (check) => (v) => v === undefined || check(v);
const oneOf = (...values) => (v) => values.includes(v);
const bool = (v) => typeof v === 'boolean';
const num = (v) => typeof v === 'number';

/** Required/optional fields per event type: field → check. */
const SHAPES = {
  session: { sessionId: str, model: opt(str) },
  status: { activity: (v) => v === null || oneOf('compacting', 'retrying')(v) },
  step: {},
  text: { id: str, text: str, mode: oneOf('delta', 'final'), agent: opt(str) },
  thinking: { id: str, text: str, mode: oneOf('delta', 'final', 'end'), agent: opt(str) },
  tool: { id: str, name: str, final: opt(bool), agent: opt(str) },
  'tool.delta': { id: str, json: str },
  'tool.output': { id: str, chunk: str, agent: opt(str) },
  'tool.result': { id: str, status: oneOf('done', 'error'), result: str, agent: opt(str) },
  'tool.sub': { id: str, name: str },
  mark: { uuid: str, assistant: bool },
  user: { text: str },
  notice: { tone: oneOf('info', 'warn', 'error'), code: opt(str), text: opt(str) },
  task: { op: oneOf('start', 'update', 'progress', 'end', 'background') },
  agent: { id: str },
  'agent.msg': { agent: str, dir: oneOf('to', 'from'), text: str, label: oneOf('assignment', 'report', 'message') },
  'agent.mark': { id: str, status: str },
  'agent.drop': { id: str },
  'turn.end': { durationMs: opt(num), isError: opt(bool), error: opt(str), text: opt(str) },
  limits: {},
  context: { usage: (v) => v && num(v.totalTokens) && num(v.maxTokens) },
};

/** null when the event is well-formed, else what is wrong with it. */
export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') return 'not an object';
  const shape = SHAPES[ev.type];
  if (!shape) return `unknown type ${JSON.stringify(ev.type)}`;
  for (const [field, check] of Object.entries(shape)) if (!check(ev[field])) return `${ev.type}.${field} is ${JSON.stringify(ev[field])}`;
  if (ev.type === 'notice' && !ev.code && !ev.text) return 'notice without code or text';
  return null;
}

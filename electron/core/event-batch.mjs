/** Batch renderer delivery only. Core observers and approval promises stay synchronous. */
export function createEventBatcher(send, { delay = 32, maxEvents = 128, maxText = 65536 } = {}) {
  let pending = [], timer = null;
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    send(batch);
  }
  return {
    flush,
    push(payload) {
      const previous = pending.at(-1);
      const a = previous?.ev, b = payload.ev;
      const field = (b.type === 'text' || b.type === 'thinking') && b.mode === 'delta' ? 'text'
        : b.type === 'tool.output' ? 'chunk' : b.type === 'tool.delta' ? 'json' : null;
      if (field && previous?.threadId === payload.threadId && a.type === b.type && a.id === b.id && a.agent === b.agent && a.mode === b.mode && a[field].length + b[field].length <= maxText) {
        pending[pending.length - 1] = { ...previous, ev: { ...a, [field]: a[field] + b[field] } };
      } else pending.push(payload);
      if (pending.length >= maxEvents || (field && b[field].length >= maxText) || ['session', 'turn.end', 'limits'].includes(b.type)) flush();
      else if (!timer) { timer = setTimeout(flush, delay); timer.unref?.(); }
    },
  };
}

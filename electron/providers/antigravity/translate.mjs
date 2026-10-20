// Documented agy headless NDJSON protocol: init → step_update* → result, once per turn.
// https://antigravity.google/docs/cli/headless
const asText = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);

export function toolCall(name, p = {}) {
  switch (name) {
    case 'run_command': return { name: 'Bash', input: { ...p, command: p.CommandLine ?? p.command ?? '', description: p.Description } };
    case 'view_file': return { name: 'Read', input: { ...p, file_path: p.AbsolutePath ?? p.TargetFile ?? p.path } };
    case 'list_dir': return { name: 'LS', input: { ...p, path: p.DirectoryPath ?? p.path } };
    case 'write_to_file': return { name: 'Write', input: { ...p, file_path: p.TargetFile ?? p.path, content: p.CodeContent ?? p.content ?? '' } };
    case 'replace_file_content': return { name: 'Edit', input: { ...p, file_path: p.TargetFile, old_string: p.TargetContent ?? '', new_string: p.ReplacementContent ?? '' } };
    case 'multi_replace_file_content': return { name: 'MultiEdit', input: { ...p, file_path: p.TargetFile, edits: (p.ReplacementChunks ?? []).map((c) => ({ old_string: c.TargetContent, new_string: c.ReplacementContent })) } };
    case 'grep_search': return { name: 'Grep', input: { ...p, pattern: p.Query ?? p.SearchPattern, path: p.SearchPath } };
    case 'find_by_name': return { name: 'Glob', input: { ...p, pattern: p.Pattern, path: p.SearchDirectory } };
    case 'search_web': return { name: 'WebSearch', input: { ...p, query: p.query ?? p.Query } };
    case 'read_url_content': return { name: 'WebFetch', input: { ...p, url: p.Url ?? p.url } };
    default: return { name, input: p };
  }
}

export function createTranslator(prefix) {
  const texts = new Map();
  const tools = new Set();
  const finished = new Set();
  const agents = new Set();
  let started = false;
  return {
    push(message) {
      const out = [];
      if (message.event === 'step_update') {
        const s = message.step_update ?? {};
        const id = `${prefix}:${s.step_index}`;
        if (s.step_type !== 'user_input' && !started) { started = true; out.push({ type: 'step' }); }
        if (s.step_type === 'agent_response' && s.text_delta) {
          texts.set(id, (texts.get(id) ?? '') + s.text_delta);
          out.push({ type: 'text', id, text: s.text_delta, mode: 'delta' });
        }
        if (s.step_type === 'agent_response' && s.state === 'DONE' && texts.has(id)) out.push({ type: 'text', id, text: texts.get(id), mode: 'final' });
        if (s.step_type === 'tool' && (s.tool_name || s.tool_info?.name)) {
          const info = s.tool_info ?? {};
          const tool = toolCall(info.name ?? s.tool_name, info.parameters);
          if (!tools.has(id) || s.state === 'DONE') out.push({ type: 'tool', id, ...tool, final: true });
          tools.add(id);
          if (s.state === 'DONE' && !finished.has(id)) {
            finished.add(id);
            out.push({ type: 'tool.result', id, status: info.error ? 'error' : 'done', result: asText(info.error?.message ?? info.output) });
          }
        }
        for (const a of s.subagent_info?.subagents ?? []) {
          const agentId = `${prefix}:agent:${a.conversation_id ?? s.step_index}`;
          if (!agents.has(agentId)) {
            agents.add(agentId);
            out.push({ type: 'agent', id: agentId, name: a.role || a.type_name || 'Antigravity agent', agentType: a.type_name, prompt: a.role ?? '', provider: 'antigravity' });
          }
          // A completed spawn step does not mean that its child has finished.
        }
      } else if (message.event === 'result') {
        const r = message.result ?? {};
        const streamed = [...texts.values()].join('');
        if (!streamed && r.response) out.push({ type: 'text', id: `${prefix}:answer`, text: r.response, mode: 'final' });
        else for (const [id, text] of texts) out.push({ type: 'text', id, text, mode: 'final' });
        for (const id of tools) if (!finished.has(id)) out.push({ type: 'tool.result', id, status: 'error', result: r.error || 'Tool did not finish.' });
        for (const id of agents) out.push({ type: 'agent', id, status: r.status === 'SUCCESS' ? 'done' : 'stopped' });
        out.push({ type: 'turn.end', isError: r.status !== 'SUCCESS', error: r.status === 'SUCCESS' ? undefined : r.error || `Antigravity: ${r.status ?? 'unknown result'}`, text: r.response || streamed });
      }
      return out;
    },
  };
}

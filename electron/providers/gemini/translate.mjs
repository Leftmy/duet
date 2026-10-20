// Gemini CLI headless stream-json protocol: init → (message | tool_use | tool_result | error)* → result
const asText = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);

export function toolCall(name, p = {}) {
  switch (name) {
    case 'run_shell_command': return { name: 'Bash', input: { ...p, command: p.command ?? p.CommandLine ?? '', description: p.description ?? p.Description } };
    case 'read_file': return { name: 'Read', input: { ...p, file_path: p.file_path ?? p.AbsolutePath ?? p.path } };
    case 'read_many_files': return { name: 'Read', input: { ...p, file_path: Array.isArray(p.include) ? p.include.join(', ') : Array.isArray(p.paths) ? p.paths.join(', ') : p.file_path ?? '' } };
    case 'list_directory': return { name: 'LS', input: { ...p, path: p.dir_path ?? p.DirectoryPath ?? p.path } };
    case 'write_file': return { name: 'Write', input: { ...p, file_path: p.file_path ?? p.TargetFile ?? p.path, content: p.content ?? p.CodeContent ?? '' } };
    case 'replace': return { name: 'Edit', input: { ...p, file_path: p.file_path ?? p.TargetFile ?? p.path, old_string: p.old_string ?? p.TargetContent ?? '', new_string: p.new_string ?? p.ReplacementContent ?? '' } };
    case 'grep_search':
    case 'search_file_content': return { name: 'Grep', input: { ...p, pattern: p.pattern ?? p.query ?? p.Query ?? '', path: p.dir_path ?? p.SearchPath ?? p.path } };
    case 'glob': return { name: 'Glob', input: { ...p, pattern: p.pattern ?? p.Pattern ?? '', path: p.dir_path ?? p.SearchDirectory ?? p.path } };
    case 'google_web_search': return { name: 'WebSearch', input: { ...p, query: p.query ?? p.Query ?? '' } };
    case 'web_fetch': return { name: 'WebFetch', input: { ...p, url: p.url ?? p.Url ?? p.prompt ?? '' } };
    default: return { name, input: p };
  }
}

export function createTranslator(prefix) {
  const texts = new Map();
  const tools = new Set();
  const finished = new Set();
  const agents = new Set();
  let segment = 0;
  let started = false;
  let lastError = null;
  return {
    push(message) {
      const out = [];
      const kind = message.type ?? message.event;
      if (kind === 'message') {
        if (message.role === 'assistant' && message.content) {
          if (!started) { started = true; out.push({ type: 'step' }); }
          const id = `${prefix}:text:${segment}`;
          if (message.delta) {
            texts.set(id, (texts.get(id) ?? '') + message.content);
            out.push({ type: 'text', id, text: message.content, mode: 'delta' });
          } else {
            texts.set(id, message.content);
            out.push({ type: 'text', id, text: message.content, mode: 'final' });
          }
        }
      } else if (kind === 'tool_use') {
        if (!started) { started = true; out.push({ type: 'step' }); }
        segment += 1;
        const id = message.tool_id ? `${prefix}:${message.tool_id}` : `${prefix}:tool:${segment}`;
        const rawName = message.tool_name || 'tool';
        const params = message.parameters ?? {};
        if (rawName === 'invoke_agent') {
          const agentId = `${prefix}:agent:${message.tool_id ?? segment}`;
          if (!agents.has(agentId)) {
            agents.add(agentId);
            out.push({
              type: 'agent',
              id: agentId,
              name: params.agent_name || params.name || 'Gemini agent',
              agentType: params.agent_name || params.name,
              prompt: params.prompt ?? params.task ?? '',
              provider: 'gemini',
            });
          }
        }
        const tool = toolCall(rawName, params);
        out.push({ type: 'tool', id, ...tool, final: true });
        tools.add(id);
      } else if (kind === 'tool_result') {
        const id = message.tool_id ? `${prefix}:${message.tool_id}` : [...tools].at(-1);
        if (id && !finished.has(id)) {
          finished.add(id);
          const isErr = message.status === 'error' || Boolean(message.error);
          const resultText = asText(message.error?.message ?? message.output);
          out.push({ type: 'tool.result', id, status: isErr ? 'error' : 'done', result: resultText });
          const agentId = `${prefix}:agent:${message.tool_id}`;
          if (agents.has(agentId)) out.push({ type: 'agent', id: agentId, status: isErr ? 'error' : 'done', result: resultText });
        }
      } else if (kind === 'error') {
        const text = asText(message.message || message.error?.message || 'Gemini error');
        if (message.severity === 'warning') {
          out.push({ type: 'notice', tone: 'warn', at: 'feed', text });
        } else {
          lastError = text;
          out.push({ type: 'notice', tone: 'error', at: 'feed', text });
        }
      } else if (kind === 'result') {
        const status = (message.status ?? message.result?.status ?? '').toLowerCase();
        const isSuccess = status === 'success';
        const errText = message.error?.message ?? (typeof message.error === 'string' ? message.error : undefined) ?? message.result?.error ?? lastError;
        const responseText = message.response ?? message.result?.response;
        const streamed = [...texts.values()].join('');
        if (!streamed && responseText) out.push({ type: 'text', id: `${prefix}:answer`, text: responseText, mode: 'final' });
        else for (const [id, text] of texts) out.push({ type: 'text', id, text, mode: 'final' });
        for (const id of tools) if (!finished.has(id)) out.push({ type: 'tool.result', id, status: 'error', result: errText || 'Tool did not finish.' });
        for (const id of agents) out.push({ type: 'agent', id, status: isSuccess ? 'done' : 'stopped' });
        out.push({
          type: 'turn.end',
          isError: !isSuccess,
          error: isSuccess ? undefined : errText || `Gemini: ${message.status ?? 'unknown result'}`,
          text: responseText || streamed,
        });
      }
      return out;
    },
  };
}

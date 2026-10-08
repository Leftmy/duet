// "desk-agents": lets any agent hand work to another agent the app knows (Claude ↔ Codex, …).
// The child runs through the core like a chat of its own: its steps show up as a subagent of the
// calling tool row, its permission requests go to the parent chat, and stopping the parent stops it.
import { z } from 'zod';
import { defineTool, textResult } from './tools.mjs';

/** Toolset for one chat (key = its thread id). */
export function agentsToolset(core, key) {
  const providers = core.registry.all().map((p) => ({ id: p.id, label: p.label }));
  const ids = providers.map((p) => p.id);
  const list = providers.map((p) => `${p.id} (${p.label})`).join(', ');
  const answer = (r) => textResult(`run_id: ${r.runId}\nstatus: ${r.status}\n\n${r.text || '(no answer)'}`, r.status === 'error');

  return {
    name: 'desk-agents',
    instructions:
      `Other coding agents available in this app: ${list}. Use run_agent to delegate a task to one of them — ` +
      'for a second opinion or review, for parallel work, or for something the other agent is better at. ' +
      'It works in the same project folder and does not see this conversation, so the task must be self-contained.',
    tools: [
      defineTool(
        'run_agent',
        `Delegate a task to another coding agent (${list}) and get its final answer. It works in the same folder with ` +
          'the same permissions (or read-only), can run commands and edit files, and does not see this conversation: ' +
          'describe the task completely. With background: true it returns a run_id at once; collect the answer with wait_agent.',
        {
          agent: z.enum(ids),
          task: z.string().describe('Self-contained task description, including relevant context and the expected output.'),
          model: z.string().optional().describe("Model id of that agent; omit for its default."),
          read_only: z.boolean().optional().describe('Investigate and answer only, without changing files.'),
          background: z.boolean().optional(),
        },
        async ({ agent, task, model, read_only, background }, ctx) => {
          const run = core.spawnAgent({ parentId: key, toolUseId: ctx.toolUseId, provider: agent, prompt: task, model, readOnly: read_only, background });
          if (background) return textResult(`run_id: ${run.runId}\nstatus: running in the background — use wait_agent to get the answer.`);
          return answer(await core.waitAgent(run.runId, { signal: ctx.signal }));
        },
      ),
      defineTool(
        'message_agent',
        'Send a follow-up message to an agent started with run_agent (it remembers its earlier work) and get its answer.',
        { run_id: z.string(), message: z.string() },
        async ({ run_id, message }, ctx) => answer(await core.messageAgent(run_id, message, { signal: ctx.signal })),
      ),
      defineTool(
        'wait_agent',
        'Wait for an agent started with background: true to finish and get its answer.',
        { run_id: z.string(), timeout_sec: z.number().optional() },
        async ({ run_id, timeout_sec }, ctx) => answer(await core.waitAgent(run_id, { signal: ctx.signal, timeoutMs: (timeout_sec ?? 1800) * 1000 })),
      ),
      defineTool('stop_agent', 'Stop an agent started with run_agent.', { run_id: z.string() }, async ({ run_id }) => {
        core.stopAgent(run_id);
        return textResult(`Stopped ${run_id}.`);
      }),
    ],
  };
}

// Session helpers the agent can call from Duet (same names as the Claude app's ccd_session tools):
// chapters for the transcript table of contents and suggested follow-up tasks. The renderer draws
// them from the tool calls themselves; these handlers only acknowledge.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool, textResult } from './core/tools.mjs';

export function sessionToolset() {
  return {
    name: 'ccd_session',
    instructions:
      'Duet session helpers. mark_chapter starts a new chapter in the transcript (shown as a divider and in the table of contents). ' +
      'spawn_task suggests a separate follow-up task the user can start in a new chat with one click; dismiss_task withdraws one.',
    tools: [
      defineTool(
        'mark_chapter',
        'Mark the start of a new chapter in this session (a short noun-phrase title, optional one-line summary). Use sparingly, 3–8 per session.',
        { title: z.string(), summary: z.string().optional() },
        async ({ title }) => textResult(`Chapter marked: "${title}". Continue your current work.`),
      ),
      defineTool(
        'spawn_task',
        'Suggest an out-of-scope follow-up task as a chip the user can start in a new chat. The prompt must stand alone.',
        { title: z.string(), prompt: z.string(), tldr: z.string(), cwd: z.string().optional() },
        async () => textResult(`task_id: task_${randomUUID().slice(0, 8)} — suggestion shown to the user.`),
      ),
      defineTool(
        'dismiss_task',
        'Withdraw a task suggestion previously created with spawn_task.',
        { task_id: z.string(), reason: z.string().optional() },
        async ({ task_id }) => textResult(`Dismissed ${task_id}.`),
      ),
    ],
  };
}

// Desk toolsets: tools the app itself gives every agent (session helpers, the built-in browser,
// other agents as subagents). Defined once, provider-neutral; each provider exposes them its own way
// (Claude: in-process SDK MCP servers, Codex: dynamic tools).
//
// Toolset: { name, instructions?, tools: Tool[] }
// Tool:    { name, description, schema: zod raw shape, run(args, ctx) → { content: [...], isError? } }
//          content items are MCP-style: { type: 'text', text } | { type: 'image', data, mimeType }
//          ctx: { signal?, toolUseId? }
import { z } from 'zod';

export const defineTool = (name, description, schema, run) => ({ name, description, schema, run });

export const textResult = (t, isError = false) => ({
  content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** JSON schema of a tool's input. */
export const inputSchema = (tool) => {
  const { $schema, ...schema } = z.toJSONSchema(z.object(tool.schema));
  return schema;
};

/** Validates input and runs a tool; errors become an error result instead of a throw. */
export async function runTool(tool, args, ctx = {}) {
  const parsed = z.object(tool.schema).safeParse(args ?? {});
  if (!parsed.success) return textResult(`Invalid input: ${parsed.error.message}`, true);
  try {
    return await tool.run(parsed.data, ctx);
  } catch (e) {
    return textResult(`Error: ${e?.message ?? e}`, true);
  }
}

/** Finds a tool by toolset and tool name. */
export const findTool = (toolsets, set, name) => toolsets.find((s) => s.name === set)?.tools.find((t) => t.name === name);

// Agent providers known to the core. Adding a provider = one module under electron/providers/
// that implements the contract below, plus one register() call in main.mjs.
//
// Provider contract (see renderer/src/events.ts for the event format):
//   id, label
//   brand: { color, mark }                  how the UI marks the agent's chats (a colour and a letter)
//   caps: { steer, interrupt, images, fork, rollback: 'anchor' | 'turns' | false,
//           rewindFiles, subagents, backgroundTasks, contextUsage, slashCommands,
//           segments, chrome, modes: PermMode[] }
//   open(spec, sink) → run                  spec: { threadId, cwd, dirs, model, effort, permissionMode, resume, resumeAt,
//                                                   instructions, tools: Toolset[] (core/tools.mjs), chrome }
//                                           sink: { event(ev), approval(req) → Promise<{ decision, updatedInput?, message? }>,
//                                                   closed({ error?, stderr? }) }
//                                           run:  { send({ text, images, uuid, priority }), configure({ model, effort, permissionMode }),
//                                                   interrupt(), close(), ready()?, rewindFiles?, contextUsage?, stopTask?,
//                                                   backgroundTask?, usage? }
//   probe(force) → { available, version, models, account, commands, usage, mcp, error? }
//   listSessions() → SessionInfo[] (with provider)
//   loadHistory(sessionId, cwd, segment?) → DeskEvent[]
//   renameSession, deleteSession, and optionally: fork, rollback, listSegments, loadSubagents,
//   taskOutput, usage, mcpStatus, mcpReconnect, runHeadless, quickText

export function createRegistry() {
  const providers = new Map();
  return {
    register(p) {
      providers.set(p.id, p);
      return p;
    },
    get(id) {
      const p = providers.get(id || 'claude');
      if (!p) throw new Error(`Unknown provider: ${id}`);
      return p;
    },
    has: (id) => providers.has(id),
    all: () => [...providers.values()],
  };
}

<div align="center">

<img src="build/icon.png" width="96" alt="Duet">

# Duet

**One desktop app for all your coding agents.**
Claude Code, Codex, Antigravity and Gemini in one window. Switch agents mid-chat without losing context,
and let them hand work to each other.

![Windows](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-x64%20%7C%20arm64-FCC624?logo=linux&logoColor=black)
![Electron](https://img.shields.io/badge/Electron-React%2019-47848F?logo=electron&logoColor=white)
![Status](https://img.shields.io/badge/status-0.1-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

Duet is a desktop UI for coding agents. It doesn't ship its own model or ask for API keys. It drives the
agent CLIs that are already **installed and signed in on your machine**, so every chat runs on your own
subscriptions and limits.

What sets it apart from a single-agent client:

- **🔀 Swap agents mid-chat.** Press `Ctrl+.` and the next message goes to another agent. That agent gets
  a handoff of everything it hasn't seen yet. Switch back and the first agent resumes its own session,
  catching up only on what happened while it was away. The chat stays one row in the sidebar.
- **🤝 Agents as subagents of each other.** Claude can delegate a task to Codex, and Codex to Claude. The
  helper appears in the Agents panel with a live transcript, asks for approvals in the same chat and stops
  with it.
- **📊 Every account at a glance.** Plan, session and weekly limits for each agent, refreshed on their own.

## Supported agents

| Agent | Runs through | Install | Approvals | Rewind / fork |
|---|---|---|---|---|
| **Claude Code** | Claude Agent SDK | bundled with Duet, sign in once | ✅ | ✅ |
| **Codex** | `codex app-server` (JSON-RPC) | `npm i -g @openai/codex` or the Codex desktop app | ✅ | ✅ |
| **Antigravity** | `agy` CLI, headless | [Antigravity CLI](https://antigravity.google/docs/cli/headless) | CLI rules | — |
| **Gemini** | `gemini` CLI, headless | `npm i -g @google/gemini-cli` | CLI rules | — |

Duet finds the binaries on its own. You can override the paths with `DUET_CODEX_BIN`,
`DUET_ANTIGRAVITY_BIN` and `DUET_GEMINI_BIN`. For Codex it picks the newest of the npm CLI, the
desktop app and `codex` on `PATH`.

## Features

For UI regressions under agent load, run `npm run build` and `npm run test:ui`.
The tests use synthetic events and an isolated Electron profile, with no provider calls.
Streaming UI updates are batched, diffs have a time/memory budget, and long transcripts
mount a bounded tail with earlier messages available on demand. UI errors are recorded
in `diagnostics.log` under the app's user-data directory. A React recovery view preserves
running chats and event subscriptions without restarting the core.

<table>
<tr><td valign="top" width="50%">

### 💬 Chats
- Streaming steps: commands with live output, edits with diffs, reads, searches, plans and subagents
- Approvals with diffs, agent questions and plan review
- Model, effort and permission mode, all switchable mid-session
- Queued follow-ups and steering while the agent works
- Context ring with compaction; rewind to any message; forks
- Short auto-generated chat titles
- Images, `@`-mentions of project files, slash commands and skills
- Split view and chats in separate windows

</td><td valign="top" width="50%">

### 🛠 Code & Git
- Changes panel with every file edited in the chat
- Git tab: commit with a generated message, push and branches, pull requests and CI via `gh`
- Worktree mode: a chat works in its own branch; apply its changes back in one click
- Built-in terminal, file tree and browser panel (agents can use the browser too)
- "Open in" VS Code, JetBrains IDEs or a terminal

</td></tr>
<tr><td valign="top">

### 🤖 Agents & tasks
- Agents panel with live subagent transcripts; collapsible
- Detects subagents that are resumed or restarted
- Background tasks get their own tab; finished ones stay in the quick bar for 2 minutes
- Live sync with other windows and CLIs writing to the same session

</td><td valign="top">

### ⏰ Automation & extras
- **Schedules:** run a prompt with any agent on an interval or daily
- **Telegram:** drive Duet from your phone; approve actions with buttons
- **Voice input:** Whisper runs inside the app
- **Command palette** (`Ctrl+K`) and full-text search across all transcripts
- Editors for `CLAUDE.md`, `AGENTS.md`, `config.toml`, hooks, custom commands, skills and MCP servers
- Light and dark themes; English and Russian

</td></tr>
</table>

## Quick start

You need **Node.js 20+** and **git**. Sign in to at least one agent first:

- **Claude:** no separate install, the CLI ships with Duet. If you have never signed in to Claude Code, run
  `claude` → `/login` once (or the bundled one, see Linux notes).
- **Codex:** `codex login`
- **Antigravity / Gemini:** run `agy` or `gemini` once and sign in with your Google account.

Then build and start:

```bash
npm install
npm run build
npm start
```

Use `npm run dev` for hot reload. `npm run shortcut` adds Desktop and Start-menu shortcuts on Windows,
or an applications-menu entry on Linux.

### Installers

```bash
npm run dist:win     # NSIS setup  → release/
npm run dist:linux   # AppImage + .deb → release/
npm run dist         # for the current OS
```

<details>
<summary><b>Linux notes</b></summary>

- The terminal's native module (`node-pty`) has no Linux prebuilds, so install the build tools:
  `sudo apt install build-essential python3` (Fedora: `sudo dnf groupinstall "Development Tools"`).
- With no `~/.claude` login yet, sign in through the bundled CLI:
  `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` → `/login`.
- Codex runs sandboxed (`workspace-write` for "Ask" and "Allow edits").
- *"The SUID sandbox helper binary was found, but is not configured correctly"* (Ubuntu 24.04+): either run
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`
  or start with `npx electron . --no-sandbox`. The `.deb` package sets this up itself.

</details>

<details>
<summary><b>Antigravity & Gemini details</b></summary>

Both providers use only cached account sign-in and subscription quotas. Duet strips API-key, Vertex and
ADC environment variables from the child process and rejects API-provider or ADC settings. It never
changes your global auth settings. Models and limits come from the CLI; the usage bar shows the
most-used quota bucket across model families.

Supported: streaming text, tool calls, model changes, queued follow-ups, interrupts, background jobs
and switching agents within a chat. Duet keeps its own journal of these chats and resumes the native
conversation by ID. Chats started outside Duet are not imported.

Limitations of the headless CLI protocol:
- Actions that need approval are denied, because Duet can't show approval dialogs for them.
- There are no image attachments and no native forks or rewinds.
- Duet's own tools are not available, so these agents can't delegate outward. Claude and Codex can still
  delegate *to* them.

</details>

## Shortcuts

| Keys | Action |
|---|---|
| `Enter` / `Shift+Enter` | Send / new line |
| `Esc` | Stop the current turn |
| `Ctrl+.` | Switch the chat to another agent |
| `Ctrl+N` | New chat |
| `Ctrl+K` | Command palette |
| `Ctrl+Shift+F` | Search all chats |
| `` Ctrl+` `` / `Ctrl+E` | Terminal / files |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+,` | Settings |
| `/` | Slash commands and skills (in an empty composer) |

## How it works

```
 ┌─────────────── renderer (React + Zustand) ───────────────┐
 │  chat feed  ◄── reduce.ts ◄── DeskEvent stream           │
 │  handoff.ts builds the context for an agent switch       │
 └───────────────────────────▲──────────────────────────────┘
                             │ IPC
 ┌───────────────────────────┴──── electron/core ───────────┐
 │  runs.mjs: chats → runs, approvals, routing              │
 │  agents.mjs: run_agent / message_agent / wait_agent      │
 │  watch.mjs: picks up session changes from outside        │
 └──────┬──────────────┬───────────────┬─────────────┬──────┘
   providers/claude  providers/codex  .../antigravity  .../gemini
   Agent SDK         app-server       agy CLI          gemini CLI
```

Each provider translates its native stream and saved sessions into one neutral event protocol,
`DeskEvent` (`renderer/src/events.ts`, validated by `electron/core/events.mjs`). The UI folds those events
the same way for live runs and history, so it doesn't care which agent is on the other end.

| Path | What's there |
|---|---|
| `electron/core/` | Provider-neutral core: runs, approval broker, registry with the provider contract, toolsets |
| `electron/providers/<id>/` | One module per agent: start runs, translate events, list and load sessions |
| `electron/features/` | Telegram, schedules, search, PRs, instructions and commands editors, voice, windows |
| `renderer/src/lib/reduce.ts` | DeskEvent → chat feed |
| `renderer/src/lib/handoff.ts` | Context passed between agents |
| `electron/main.mjs` | Window, IPC, settings (`%APPDATA%\Duet\settings.json`) |

### Adding an agent

1. Create `electron/providers/<id>/index.mjs` and default-export a factory that returns a provider. It needs
   `open(spec, sink)` to run a session and report desk events, with approvals going through
   `sink.approval`. It also needs `probe`, `listSessions`, `loadHistory` and the session operations. The
   contract is documented in `electron/core/registry.mjs`.
2. Expose the desk toolsets (`spec.tools`, plain definitions from `electron/core/tools.mjs`) in whatever way
   the agent supports tools: MCP, client tools and so on.
3. Run `node scripts/provider-check.mjs <id>`. It drives the provider through the real core (streaming, a
   command, an approval, a desk tool, resume and history) and validates every event.
4. Register the provider in `electron/main.mjs`. The UI reads models, modes and capabilities from the probe,
   so chats, switching and `run_agent` work without further changes.

### Tests

```bash
npm run typecheck
npm run test:chat                                    # chat lifecycle
npm run test:antigravity && npm run test:gemini      # fake CLIs, no account needed
node scripts/provider-check.mjs claude               # against the real agent
```

## Privacy

Duet has no backend of its own and doesn't store any agent credentials: each agent signs in through its own CLI. Chats live where each agent keeps them (`~/.claude`, `~/.codex` and so on), and Duet keeps
its settings in its user-data folder.

## License

[MIT](LICENSE) for Duet's own code. The Claude Agent SDK and the Claude Code binary it brings are
proprietary software of Anthropic under [their own terms](https://code.claude.com/docs/en/legal-and-compliance).
Built installers include that binary, so share the source rather than the builds.

---

<sub>Duet is an independent project, not affiliated with Anthropic, OpenAI or Google. Product names belong to their owners.</sub>

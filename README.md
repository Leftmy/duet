<div align="center">

<img src="build/icon.png" width="96" alt="Duet">

# Duet

**One desktop app for all your coding agents.**
Claude Code, Codex and Antigravity in one window. Switch agents mid-chat without losing context,
and let them hand work to each other.

![Windows](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-x64%20%7C%20arm64-FCC624?logo=linux&logoColor=black)
![Tauri](https://img.shields.io/badge/Tauri%202-React%2019-24C8D8?logo=tauri&logoColor=white)
![Status](https://img.shields.io/badge/status-native%20preview-orange)
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
  Agents can message parents and teammates, queue follow-ups while busy and inspect
  every descendant's events through a replayable journal. See the
  [multi-agent MCP audit](docs/MULTI_AGENT_MCP.md) for contracts, limits and verification.
- **🗂 Editable model context.** Archive selected blocks, compress them with a chosen subscription model, pin important results and undo edits. Originals remain readable. Agents use the same scoped tools; changes apply at a safe turn boundary in the same chat. See [context management](docs/CONTEXT_MANAGEMENT.md).
- **📊 Every account at a glance.** Plan, session and weekly limits for each agent, refreshed on their own.

## Supported agents

| Agent | Runs through | Install | Approvals | Rewind / fork |
|---|---|---|---|---|
| **Claude Code** | native Claude CLI, streaming stdio | bundled with Duet, sign in once | ✅ | ✅ |
| **Codex** | `codex app-server` (JSON-RPC) | `npm i -g @openai/codex` or the Codex desktop app | ✅ | ✅ |
| **Antigravity** | `agy` CLI, headless | [Antigravity CLI](https://antigravity.google/docs/cli/headless) | CLI rules | — |

Gemini is disabled as a provider. Existing Gemini journals remain readable; switch to an enabled
provider to continue a legacy chat. All provider selectors use Claude → Codex → Antigravity order.
The provider icons are bundled SVG assets (see `renderer/src/assets/providers/README.md`).

Duet finds the binaries on its own. You can override the paths with `DUET_CODEX_BIN`,
`DUET_ANTIGRAVITY_BIN`. For Codex it picks the newest of the npm CLI, the
desktop app and `codex` on `PATH`.

## Features

Codex has native review, compaction, goals, skill selection, scoped approvals, typed
MCP forms and server/tool discovery in the chat header. Markdown file links open
the source chat's project at the requested line. See the
[Codex integration record](docs/CODEX_INTEGRATION.md) for supported commands,
verification and the boundaries of the app-server integration.

For UI regressions under agent load, run `npm run build` and `npm run test:ui`.
The tests use synthetic events; native WebView2/WebKitGTK integration runs in isolated profiles.
Streaming UI updates are batched, diffs have a time/memory budget, and long transcripts
mount a bounded tail with earlier messages available on demand. UI errors are recorded
in `diagnostics.log` under the app's user-data directory. A React recovery view preserves
running chats and event subscriptions without restarting the core.

The application runs a Rust core inside Tauri 2: WebView2 on Windows and WebKitGTK on Linux.
All 123 application commands are handled in Rust, including providers, history, search, Git,
terminals, schedules and Telegram. There is no persistent Node sidecar or JavaScript SDK adapter.
The previous Electron implementation, Node bridge and JavaScript provider SDK have been removed.
Idle agent sessions release their client processes after
five minutes and resume from their saved session on the next message. Running tasks, approvals
and delegated work are preserved; the timeout is configurable in Settings. Account discovery
does not start Claude's configured MCP servers.
The [migration record](docs/RUST_CORE_MIGRATION.md) describes the implementation and verification.
The native browser supports multiple tabs per chat, manual sleep and configurable idle sleep
(five minutes by default). Sleeping tabs release their WebView and reload when woken;
page input, media, downloads and pinning protect against automatic sleep.
See [browser tabs](docs/BROWSER_TABS.md) for behavior, agent tools and limits.
The checked `desktop/ipc-ownership.json` inventory prevents commands falling back to the old core.
The file editor, terminal and settings are loaded on demand instead of parsing their editor
and terminal libraries at startup. See [native cleanup](docs/NATIVE_CLEANUP.md) for the current build and test layout.

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

To build from source you need **Node.js 22.12+**, **git**, a stable **Rust** toolchain and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows install
Visual Studio C++ Build Tools and WebView2. On Ubuntu 24.04:

```bash
sudo apt install build-essential python3 pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev patchelf
```

Built packages include the native Claude executable and require no Node runtime for Duet itself.
An independently installed provider CLI may require its own runtime.
Sign in to at least one agent first:

- **Claude:** no separate install, the CLI ships with Duet. If you have never signed in to Claude Code, run
  `claude` → `/login` once (or the bundled one, see Linux notes).
- **Codex:** `codex login`
- **Antigravity:** run `agy` once and sign in with your Google account.

Then build and start:

```bash
npm install
npm run native:build
npm start
```

`npm run dev` builds a debug native app with a separate preview profile. `npm run native:preview`
opens the release build with a separate profile and disables schedules and Telegram, so an existing
installation can keep working. Normal `npm start` uses the existing Duet settings and CLI sessions.
`npm run shortcut` adds Desktop and Start-menu shortcuts on Windows, or an applications-menu
entry on Linux, pointing at `release/native/`.

### Installers

```bash
npm run dist:win     # on Windows: NSIS setup
npm run dist:linux   # on Linux: AppImage + .deb
npm run dist         # for the current OS
```

Installers are written to `src-tauri/target/release/bundle/`. A portable application is also copied
to `release/native/`: keep its executable and `runtime/` directory together. The Windows/Linux
workflow in `.github/workflows/native.yml` builds both targets. Integration tests exercise
WebView2 on Windows and WebKitGTK under Xvfb on Linux.

<details>
<summary><b>Linux notes</b></summary>

- The terminal uses Rust `portable-pty`; it does not load `node-pty`.
- With no `~/.claude` login yet, sign in through the bundled CLI:
  `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` → `/login`.
- Codex runs sandboxed (`workspace-write` for "Ask" and "Allow edits").
- The native shell uses the distribution's WebKitGTK 4.1 runtime. It does not need Electron's
  `chrome-sandbox` helper.

</details>

<details>
<summary><b>Antigravity details</b></summary>

Antigravity uses only cached account sign-in and subscription quotas. Duet strips API-key, Vertex and
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
 ┌───────────────────────────┴──── Rust core ───────────────┐
 │  agents.rs: chats, runs, approvals, tools, delegation    │
 │  history.rs / search.rs: streaming JSONL + disk SQLite   │
 │  desktop.rs: windows, browser, session change watches    │
 └──────┬──────────────┬───────────────┬─────────────┬──────┘
   native Claude     Codex             Antigravity
   CLI stdio         app-server        agy CLI
```

Each provider translates its native stream and saved sessions into one neutral event protocol,
`DeskEvent` (`renderer/src/events.ts`, translated in `src-tauri/src/core/events.rs` and `live.rs`). The UI folds those events
the same way for live runs and history, so it doesn't care which agent is on the other end.
Tauri's Rust host owns native windows, dialogs, browser views and page captures. UI commands call
the Rust core directly. Remote browser content cannot call the app's agent or file commands.
History is paginated by complete turns; a selected subagent loads its own transcript on demand.
Context for an agent switch is read separately from disk with an explicit text budget.

| Path | What's there |
|---|---|
| `src-tauri/src/core/` | Rust providers, history, search, approvals, Git, PTY, settings and automation |
| `src-tauri/src/` | Tauri entry point, bounded event pump, native browser/media integration |
| `desktop/` | Native preload, IPC ownership inventory and native window controls |
| `renderer/src/lib/reduce.ts` | DeskEvent → chat feed |
| `renderer/src/lib/handoff.ts` | Context passed between agents |
| `src-tauri/src/core/storage.rs` | Atomic settings and native data (`%APPDATA%\Duet\`) |

### Adding an agent

1. Add CLI discovery and subscription checks in `src-tauri/src/core/cli.rs`.
2. Implement the protocol in `agents.rs` / `live.rs` using the native subprocess supervisor and approval broker.
3. Translate saved sessions in `history.rs` / `events.rs` and expose the schemas in `toolsets.rs`.
4. Extend the subprocess fixtures and history goldens, then verify a real signed-in two-turn session.
   The UI reads models, modes and capabilities from the native probe.

### Tests

```bash
npm run typecheck
npm run test:chat                                    # chat lifecycle
npm run test:native-bridge                           # native IPC and event subscriptions
npm run test:ui                                      # renderer state and performance
npm run test:agents                                  # native team coordination
npm run test:native                                  # Windows: debug native integration
                            # build the Rust test driver first:
cargo build --locked --manifest-path src-tauri/Cargo.toml --examples
npm run test:rust-core                               # subprocess protocols + history goldens
xvfb-run -a dbus-run-session -- npm run test:native-linux # Linux WebKitGTK integration
node scripts/native-inspect.mjs --packaged            # Windows: portable package integration
node scripts/smoke-rust-providers.mjs                # real Claude/Codex subscriptions; uses quota
```

The native integration test uses an isolated temporary profile. Add `--provider-smoke` to
exercise a real signed-in Codex subscription and two-turn context (uses your quota and archives
only the test session). Add `--fixtures` for CI with isolated fake provider CLIs; no subscription or user data is required.

## Privacy

Duet has no backend of its own and doesn't store any agent credentials: each agent signs in through its own CLI. Chats live where each agent keeps them (`~/.claude`, `~/.codex` and so on), and Duet keeps
its settings in its user-data folder.

## License

[MIT](LICENSE) for Duet's own code. The bundled native Claude Code executable is
proprietary software of Anthropic under [their own terms](https://code.claude.com/docs/en/legal-and-compliance).
Built installers include that binary, so share the source rather than the builds.

---

<sub>Duet is an independent project, not affiliated with Anthropic, OpenAI or Google. Product names belong to their owners.</sub>

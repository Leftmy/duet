# Kimi Code integration

Duet 0.4.0 includes Kimi Code 2.4.1 for Windows and Linux. The installer pins the official native executable and verifies its SHA-256; `desktop/kimi-version.json` records each platform. The upstream MIT license ships as `KIMI-LICENSE`. No external Node installation is needed for bundled Kimi.

## Account and sessions

Choose Kimi and open its header controls → account, or Settings → accounts. Select global or mainland China, start device sign-in and open the displayed verification page. OAuth stays in `KIMI_CODE_HOME` / `~/.kimi-code`. Duet does not receive OAuth credentials in the renderer and does not accept API keys. The server bearer remains in Rust. Parent-shell model/API overrides are removed; only managed subscription models are selectable. Five-hour and monthly quotas keep their actual period labels.

One owned `kimi web --no-open --debug-endpoints` process serves independent chats over authenticated loopback HTTP/WebSocket. Closing/switching one chat unsubscribes and releases that session without killing siblings. Duet's Rust core owns lifecycle, routing, permissions, history and MCP. The provider executable internally embeds its own runtime.

## Implemented surfaces

- Images/video, assistant/reasoning streams, incremental tool output and errors, retries, todo plans, context usage and per-turn usage statistics.
- Mid-turn prompt queue and immediate steering via Kimi's `prompts::steer`; interrupt cancels the current provider turn.
- Manual, automatic and explicit bypass permissions; plan mode. The unsupported edit-only permission mode is not offered. Reviewer/researcher tool allowlists exclude shell/write tools and external MCP; Duet MCP enforces the actual role independently.
- Approval cards preserve plan option labels, question IDs, multi-select values and free text. Approval requests remain scoped to the owning chat.
- Native subagent transcript events, direct messages and stop controls; Duet MCP delegation/messages/waits/event cursors work across providers.
- Resume, rename/archive, fork (including known turn anchors), turn undo, imported CLI history, paged transcript and file start/end snapshots. Imports commit atomically, with an explicit 32 MiB / 10,000-message bound. Long histories remain available in the paged provider transcript view.
- Native context compaction, model-selected Duet selective context compression, archive/pin/restore/undo. Provider compaction is asynchronous; Duet monitors its service until completion and does not infer success from an HTTP acknowledgement.
- Model/thinking and permission configuration, goals set only by an explicit user action, goal pause/resume/cancel, Swarm and Tower worktree modes, read-only side conversations.
- Skills/catalog and activation, running tasks and stop, tool catalogs, plugin marketplace/install/enable/disable/remove, hook inspection, global MCP add/update/remove/test and OAuth begin/complete/cancel.
- `/status`, `/help`, `/login`, `/model`, `/permissions`, `/compact`, `/goal`, `/swarm`, `/tower`, `/btw`, `/tasks`, `/agents`, `/skills`, `/mcp`, `/plugins`, `/hooks`, `/fork`, `/new`, `/clear` route to native controls. Unknown slash text remains ordinary user input.

The official v2 server is the compatibility boundary, not the archived Python Wire API. Ephemeral per-session MCP and tool-policy overlays use authenticated SDK service endpoints and are tested against the pinned published CLI. Upstream upgrades require the contract tests before changing the pin. Terminal-specific interactive widgets and operating Kimi's own terminal UI are outside the desktop integration. Native undo does not promise filesystem rollback; use Duet's Git/worktree tools for file review and merging.

## Verification

`npm run test:kimi` exercises the Rust core against a realistic isolated HTTP/WebSocket fixture: subscription model/environment guards, streaming, Unicode-safe transcript replay, approvals/questions/plans, actual Duet HTTP MCP calls, native agents, steering, shared-process isolation, compaction, catalogs, goals, session history/fork/resume and hot switching.

`npm run test:kimi-published` runs the pinned real binary with a temporary home and verifies session/profile/tool/catalog APIs plus authenticated WebSocket subscription without signing in or making an inference request. Provider model quality, real quota consumption and a user's OAuth session require a signed-in account and are not simulated as a real inference test.

Rust unit tests cover transcript ordering, UTF-16 offsets/replay, native child event contracts and releasing completed frame caches. Packaged WebView tests cover bundled icons, Kimi controls and subscription login UI in isolated fixture profiles.

Official protocol reference: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html

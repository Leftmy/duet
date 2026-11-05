# Duet project guide

This file is the project context and decision record for contributors and coding
agents. Keep it current when architecture, workflows, or constraints change.
It describes the checked-in implementation; historical verification results in
linked documents are not evidence that checks passed in a new checkout.

## Product and supported platforms

Duet is a desktop UI for subscription-based coding agents. It uses locally
authenticated provider CLIs, supports switching providers within one logical
chat, and coordinates delegated work. It has no application backend or own model.
The supported desktop targets are Windows (WebView2) and Linux (WebKitGTK).

Provider order is **Claude, Codex, Antigravity, Kimi**, defined in
`renderer/src/lib/providers.ts`. Gemini is disabled for new work; its existing
journals must remain readable.

| Provider | Integration boundary | Important constraints |
| --- | --- | --- |
| Claude | Bundled native CLI, streaming stdio | Platform SDK-named packages supply a native executable, not a JavaScript runtime adapter. |
| Codex | `codex app-server`, JSON-RPC | Preserve isolation between chats using a shared app-server. |
| Antigravity | Installed `agy` headless CLI | Subscription-only environment; no native image input, forks, rewinds, or interactive approvals. Preserve its scoped context helper. |
| Kimi | Bundled, pinned native v2 server, loopback HTTP/WebSocket | One owned server serves independent chats. Check published protocol contracts before updating the executable pin. |

Models, quotas and capabilities come from provider discovery. Do not invent model
IDs or silently fall back to API-key billing. Provider credentials stay with the
providers; Kimi's server bearer stays in Rust rather than the renderer.

## Architecture and source map

React/Zustand receives normalized `DeskEvent` events through the native preload.
The Rust core handles application commands, provider processes, persistence and
automation. Live events and saved history feed the same renderer reducer.

| Path | Responsibility |
| --- | --- |
| `renderer/src/App.tsx`, `store.ts` | Application UI and shared state |
| `renderer/src/events.ts`, `types.ts`, `desk.d.ts` | Event, domain and native bridge contracts |
| `renderer/src/lib/reduce.ts`, `handoff.ts`, `chat-sessions.ts` | Transcript reduction, provider handoff and chat lifecycle |
| `renderer/src/components/`, `features/`, `i18n/` | UI panels, feature modules and English/Russian translations |
| `desktop/preload.js`, `window-controls.js` | Tauri bridge, subscriptions and native window controls |
| `desktop/ipc-ownership.json` | Audited inventory of Rust-owned application commands |
| `src-tauri/src/main.rs`, `host.rs`, `pump.rs` | Native host and bounded delivery to the WebView |
| `src-tauri/src/core/agents.rs`, `live.rs`, `cli.rs`, `codex.rs`, `kimi*.rs` | Provider discovery, orchestration and protocol integration |
| `src-tauri/src/core/process.rs`, `rpc.rs`, `rpc_frame.rs` | Owned subprocesses and bounded protocol transport |
| `src-tauri/src/core/history.rs`, `events.rs`, `jsonl.rs`, `search.rs` | History, normalization and disk-backed search |
| `src-tauri/src/core/context*.rs`, `collaboration.rs`, `toolsets.rs` | Context edits, team journals and scoped tools |
| `src-tauri/src/core/dispatch.rs`, `roles_agent.rs`, `workspaces.rs`, `queue_log.rs` | Admission, roles, workspaces and input recovery |
| `src-tauri/src/core/storage.rs`, `config.rs` | Atomic settings and configuration |
| `src-tauri/src/core/git.rs`, `pr.rs`, `terminal.rs`, `browser.rs` | Git/gh, PTY and native browser services |
| `src-tauri/src/core/scheduler.rs`, `telegram.rs` | Automation through the same core registry |
| `scripts/`, `scripts/fixtures/` | Build tooling, isolated provider fixtures and history goldens |
| `.github/workflows/native.yml` | Windows/Linux CI checks and packaging |

## Decisions and invariants

1. **Native core only.** The Electron shell, persistent Node sidecar, JavaScript
   provider SDK and Node PTY were removed. Do not restore those paths. Node is a
   development/test dependency; bundled Duet runs without a Node installation.
   The ownership audit enforces this boundary.
2. **One logical chat across provider sessions.** Preserve session aliases,
   cursors, history, queued input and scoped approvals during switching, resume,
   fork and rewind. Read handoff context separately from disk with an explicit
   budget, not merely from the mounted transcript.
3. **Bounded resource use.** Keep event batching/backpressure, complete-turn
   pagination, bounded transcript mounting, lazy editor/terminal/settings loads,
   and bounded search/diff work. Large live CLI frames spill to temporary files;
   their limits differ from saved JSONL history limits. See the transport record.
4. **Process ownership and isolation.** Clean up only owned processes. Closing
   one chat must not kill another chat's shared provider server. Idle release
   preserves saved sessions, active work, pending approvals and descendants.
5. **Scoped capabilities.** Remote browser pages cannot invoke application/file
   commands. Approval responses, team events and context tools must validate chat
   ownership. Reviewer/researcher restrictions cannot be upgraded by a permission
   picker or writable delegation.
6. **Durable, reversible context editing.** Keep immutable originals and revisions.
   Protect user instructions, pinned blocks and incomplete tool/result pairs.
   Apply projections at safe boundaries; commit after provider acknowledgement
   and roll back failed rebases without losing incoming messages.
7. **Team work survives turn boundaries.** Parent completion, provider switching
   and context checkpoints preserve Duet-managed descendants. Explicit stop/close
   recursively stops the relevant branch. Preserve event cursors, mailbox ordering
   and approval routing through the root chat.
8. **Admission is separate from cancellation.** Workload limits queue new work;
   changing limits does not interrupt running turns. Approval waits release
   compute capacity. Crash recovery restores unsent drafts without invoking models.
   Isolated worktrees are never automatically merged or removed at completion.
9. **Local data compatibility.** Settings live in the Duet user-data directory
   (`%APPDATA%/Duet` on Windows); native SQLite databases live beneath it.
   Provider transcripts remain in provider stores, with Duet journals/metadata
   where needed. Preserve legacy history and atomic writes.
10. **Separate preview from normal use.** Preview/dev uses a temporary profile and
    disables schedules and Telegram. Normal start uses existing settings and
    sessions. Do not overwrite a running installation or use real user data as
    disposable test fixtures.

## Setup and common commands

Use Node.js 22.12+ (CI uses Node 24), npm, Git, stable Rust and the Tauri platform
prerequisites. Windows needs Visual Studio C++ Build Tools and WebView2. Linux
needs WebKitGTK 4.1 and native build libraries; see `README.md` and CI for packages.
GitHub PR/CI features also use `gh`.

```sh
npm ci
npm run typecheck
npm run build          # frontend only, writes dist/
npm run native:build   # frontend, native runtime and release executable
npm run native:preview # release executable with isolated preview profile
npm run dev            # builds and launches a debug native preview
npm start              # existing native build with normal user profile
npm run native:package
```

`npm run dev` runs the native build script, not a standalone Vite watch server.
`vite.config.mjs` defines the renderer root and frontend output.
Installers are generated under `src-tauri/target/release/bundle/`; portable files
are copied to `release/native/`. Keep the portable executable and `runtime/`
together. `dist:win` and `dist:linux` package for the host OS, not cross-compilation.

Provider executable overrides include `DUET_CODEX_BIN`, `DUET_ANTIGRAVITY_BIN`
and `DUET_KIMI_BIN`. Native tooling uses `DUET_NATIVE_USER_DATA`,
`DUET_NATIVE_PREVIEW`, `CARGO_TARGET_DIR` and `DUET_NATIVE_PORTABLE_DIR` for
profile/output isolation; consult `scripts/native.mjs` before changing them.

Generated dependencies/artifacts (`node_modules/`, `dist/`, `release/`, `.tools/`,
`src-tauri/target/`, `src-tauri/gen/`, `src-tauri/resources/`) are ignored. Do not
commit provider credentials, profiles, transcripts or generated runtime binaries.
For releases, keep versions in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json`, plus affected lockfiles, consistent.

## Verification

`npm ci` / `npm install` enables `.githooks/pre-commit` through the `prepare`
script. Existing checkouts can enable it with `npm run hooks:install`. The hook
checks staged whitespace and runs `npm run verify`; any failed check blocks the
commit. Verification includes hook regression tests, typechecking, Markdown,
chat, paste, bridge, UI and ownership checks, then the frontend build.
Hook tests compare canonical directory paths because Windows temporary paths
can use 8.3 names while Git Bash prints their full names.
Rust subprocess tests use the compiled test binary as a child fixture so Unicode
capture does not depend on cold PowerShell startup within the test deadline.

Choose additional checks based on the change; CI is the full platform validation
reference. Documentation-only changes also need link/path checks. Rust/native
checks remain separate from the local hook. Report commands actually run and
any unavailable prerequisites.

| Change | Relevant checks |
| --- | --- |
| TypeScript/UI | `npm run typecheck`, `npm run build`, `npm run test:ui` |
| Chat/history/handoff | `npm run test:chat`, native history fixtures in `test:rust-core` |
| Markdown/pasting | `npm run test:markdown`, `npm run test:paste` |
| Native bridge/command ownership | `npm run test:native-bridge`, `npm run test:native-ownership` |
| Rust core | `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml` |
| Provider protocols/lifecycle | Build examples below, then `npm run test:rust-core` |
| Context/teams/steering/workbench/Kimi | `test:context`, `test:teams`, `test:steering`, `test:workbench`, `test:kimi` npm scripts |
| Pinned Kimi upgrade | `npm run test:kimi-published` plus Kimi fixture tests |

Build the native test driver before subprocess suites:

```sh
cargo build --locked --manifest-path src-tauri/Cargo.toml --examples
npm run test:rust-core
```

Native UI tests also need prepared runtime resources, frontend output and a native
shell build; follow CI's preparation order. Windows uses
`node scripts/native-inspect.mjs --fixtures`; Linux uses
`xvfb-run -a dbus-run-session -- npm run test:native-linux`.

Prefer isolated fake-provider fixtures for routine checks. Published Kimi tests
use the pinned real executable with a temporary home and no inference request.
Signed-in smoke scripts such as `scripts/smoke-rust-providers.mjs` consume actual
subscription quota; run them intentionally and distinguish them from fixtures.
Fixture coverage does not establish real-model quality or live account behavior.

## Feature references

- [Overview, installation and shortcuts](README.md)
- [Rust core migration and historical verification](docs/RUST_CORE_MIGRATION.md)
- [Native-only source and dependency decisions](docs/NATIVE_CLEANUP.md)
- [Large live CLI frames and parser boundaries](docs/CLI_TRANSPORT.md)
- [Codex integration](docs/CODEX_INTEGRATION.md)
- [Kimi integration and published contract checks](docs/KIMI_INTEGRATION.md)
- [Team MCP lifecycle, journals and limits](docs/MULTI_AGENT_MCP.md)
- [Context management, revision checks and rollback](docs/CONTEXT_MANAGEMENT.md)
- [Task admission, roles, recovery and conflict previews](docs/TASK_SUPERVISION.md)
- [Browser tabs, sleep and tool behavior](docs/BROWSER_TABS.md)
- [Pasted-text behavior](docs/PASTED_TEXT.md)
- [Fixture provenance](scripts/fixtures/README.md)
- [Provider icon assets](renderer/src/assets/providers/README.md)

Older migration records describe earlier provider sets and limits. Prefer current
code, configuration and feature-specific records when historical notes differ.

## Maintaining this record

Update this file alongside changes to setup, commands, architecture or invariants.
Record the decision, reason, affected behavior and verification in the appropriate
feature document, then link it here. Distinguish implemented behavior from plans
and unresolved issues. Avoid copying transient test counts, local paths, secrets
or entire conversation logs into permanent project context.

# Native-only source tree (0.2.6)

The application has one desktop implementation: Rust inside Tauri, with the existing React
frontend. The old desktop source tree, JavaScript core/sidecar, launch commands, packaging
configuration, JS provider SDK, Electron packages and Node PTY have been removed.

`desktop/preload.js` calls Tauri directly and provides the renderer API and event subscriptions.
`src-tauri/build.rs` embeds this script and the native window controls. The IPC inventory
contains only Rust commands and is checked against the native command list and preload.
Its audit also rejects reintroducing the retired source directories or runtime dependencies.

Claude uses a bundled native executable. The optional platform packages whose names start
with `@anthropic-ai/claude-agent-sdk-` contain that executable; the JavaScript SDK umbrella
package is no longer installed. `prepare-native.mjs` copies the binary, license and manifest.
Node remains a development tool for the frontend and deterministic CLI test peers.

Old parser implementations are not kept under another directory. History compatibility
uses `scripts/fixtures/history-goldens.json`: fixed input records and expected normalized
events captured before retiring the reference parsers. Native tests also write archived
Antigravity/Gemini journal files directly and check reads, rollback and fork behavior.

Renderer state/performance tests run through Vite without a desktop runtime. Native
WebView2 integration tests cover rendering, bounded event delivery and React failure
recovery without stopping a running chat. WebKitGTK integration and the native core
fixtures cover Linux. Protocol, lifecycle, permission, collaboration and steering tests
exercise the Rust implementation, rather than a removed JavaScript implementation.

Previously built application folders and user profiles are preserved. Source/dependency
cleanup does not stop or overwrite an existing running application.

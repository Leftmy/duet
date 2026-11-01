# Multi-agent MCP audit and implementation

The active implementation is native Rust: `agents.rs`, `collaboration.rs`,
`rpc.rs` and `toolsets.rs`. Claude exposes it through its native CLI control transport; Codex exposes the same operations through app-server dynamic tools. The previous desktop adapter has been removed.

## Scheduling and roles (0.3.0)

Duet-managed turns share app, project, team and provider concurrency limits.
Approval waits release compute capacity while retaining workspace write ownership.
When delegation queues, the parent receives the run ID immediately and can finish
a checkpoint; completion resumes the parent in its existing chat. Dispatch, role
and workspace changes are included in the family event journal.

Helpers default to the read-only reviewer role. Researchers have the same write
restrictions. Writable helpers require `role: "executor", workspace: "isolated"`;
their worktree is created after admission and is never merged automatically.
Roles follow a logical chat across provider switches and saved session aliases.
The Tasks and attention panel controls limits, ownership and queued input, and
offers explicit draft recovery after a crash. See [task supervision](TASK_SUPERVISION.md).

## Weaknesses found and corrected

| Previous behavior | Current behavior |
| --- | --- |
| Only selected text/tool events reached the immediate parent's UI; the model mainly received a final answer. | A family-scoped SQLite event journal includes every normalized descendant event, permission request/resolution and message lifecycle. The root can replay the stream, and wait results include unread events automatically. |
| Children could not call the agent toolset, contact parents or siblings, or delegate. | All levels can message and inspect their own team. Delegation supports three levels below the root. Nested UI IDs are namespaced; session ownership and approvals resolve to the root. |
| A message to a busy child was rejected. | Messages receive an ID, queue in order, and are delivered in batches after the active turn. Parents, children and siblings use the same mailbox behavior. |
| Background completion did not wake a model. | Completion queues a compact notification for the parent and root, including a journal reference. Idle models resume their saved sessions; busy models receive it after their current turn. |
| An inline delegate could occupy an operation slot for an hour. | Waits default to 30 seconds and are capped at 60. Condition variables wake them on activity or cancellation. Timeouts leave work running. Multiple targets support waiting for any completion. |
| A parent ending its turn could cause a waiting child to be stopped. | Work belongs to a logical chat family. Ending a model turn or switching the parent's provider preserves children. Explicit stop/close remains recursive. |
| MCP cancellation notifications were ignored. | Transport and nested MCP request IDs share cancellation tokens. Cancellation arriving before worker registration is retained. Closing runs also wakes waits and denies pending approvals. |
| A CLI that stopped reading stdin could block cleanup behind a writer's lock. | Cleanup terminates its owned process tree before taking the stdin lock, unblocking pending writes. |
| Codex cleanup unsubscribed without necessarily stopping the model turn. | A live Codex turn receives `turn/interrupt` before `thread/unsubscribe`. Shared app-server processes and other chats remain alive. |
| Nested cleanup and permission routing assumed one child level. | Stop/close traverses descendants; nested permissions appear in the root chat with their actual source agent ID. |
| A result could disappear when a queued follow-up started immediately. | Turn sequence numbers distinguish completed results from their successors. A waiter can receive its completed result while the next turn is already running. |
| New running states and background liveness marks could remain stale. | Every accepted child turn announces running status; completion removes the correct parent's liveness mark. Inactive child clients become eligible for release after 30 seconds, preserving their saved sessions. |
| Claude and Codex returned semantic tool failures differently. | Both return readable tool errors without misclassifying a failed operation as a missing MCP method. |
| Delegated agents had no direct UI stop/message controls. | The agent panel sends to a specific run and stops that branch, including descendants, through native services. |

## Event delivery

Selective context jobs also publish `context.changed` through the family journal.
During an automatic context checkpoint the agent remains working; waiters and the
root do not receive a premature completion. Rebinding its provider session keeps
Duet MCP descendants alive. See [context management](CONTEXT_MANAGEMENT.md).

`agent_events` returns ordered envelopes with `seq`, `root_id`, `run_id`,
`parent_id`, `agent_id`, provider, session, timestamp and the normalized event.
This includes thinking/text deltas, tool input/output/results, plans, patches,
context/status, notices, goals/questions, nested-agent lifecycle, approvals and
completion events. These are Duet events; this is not a raw wire packet capture.

Use the returned `cursor` as `after` for the next page and follow `has_more`.
Omitting `after` uses the caller's last consumed cursor. A filtered read does not
advance the unfiltered cursor. `latest_cursor` is a high-water mark, not proof
that earlier events have been read. `wait_agent` also returns a page of unread
events, so existing callers receive progress alongside the final answer.

The root receives every descendant's stream through this interface. Model turns
are woken by messages and completion, rather than by each token delta. Streaming
deltas are journaled and forwarded to the UI without generating thousands of
extra model calls. Roots can long-poll `agent_events` for live activity.
Messages/completions already delivered in an event-page response are acknowledged
in the pending mailbox, avoiding a duplicate model turn for the same notification.

The journal uses WAL and a bounded SQLite cache. Reads return at most 200 events
and approximately 256 KiB per page. Individual large events return a sequence
reference; `read_agent_event` recovers their complete UTF-8 JSON in bounded chunks.
Replayed journal content inside tool results is represented by canonical sequence
references, preventing the journal from recursively embedding itself. Normalized
event payloads remain available at their original sequence numbers.

Wait responses contain bounded answer previews and indicate truncation; the full
answer remains in the journal/native transcript. Permission decisions are
journaled without secret answer values. Journal write failures are visible in the
root UI rather than being silently discarded.

## Operations

| Tool | Behavior |
| --- | --- |
| `run_agent` | Same project, reviewer by default; isolated workspace required for executor. Use `background: true` for an immediate run ID; otherwise wait briefly and receive status plus unread events. Capacity-queued runs return immediately. |
| `message_agent` | Nonblocking queued message to `parent`, `root`, or another run ID in the same family. A finished/stopped recipient can resume; a busy one completes its active turn first. |
| `list_agents` | Run IDs, parent relationships, providers, status and mailbox counts. |
| `wait_agent` | One `run_id` or multiple `run_ids`; returns on any completed target or timeout, with unread events. Waiting for yourself or an ancestor is rejected. |
| `agent_events` | Replay or long-poll progress, optionally scoped to a teammate, with explicit or remembered cursor. |
| `read_agent_event` | Retrieve a large canonical event by sequence and byte offset. |
| `stop_agent` | Only ancestors may stop a branch. Cancel permissions/waits, clear mailboxes and interrupt descendants. |

Messages cannot cross chat families. Mailboxes allow 128 ordinary entries and
about 1 MiB of text. A reserved compact activity notification survives completion
bursts even when the ordinary mailbox is full; results stay in the journal.
Admission is limited to 64 running and 256 retained agents per family, within the
global chat limit. Failed admission is explicit.

Claude and Codex can host the full toolset. Antigravity and Gemini remain CLI
workers: they can receive tasks/follow-ups and return their native event stream,
but their current Duet transports do not host this custom MCP toolset. Installing
this version does not turn those transports into interactive MCP clients.

Codex stores dynamic-tool definitions with a session and its current resume API
cannot replace them. New Codex sessions expose the complete new tool catalog.
Existing sessions retain their original catalog; the existing delegation/message/
wait/stop operations receive the corrected native behavior, including event pages
in wait responses. Claude refreshes its tool catalog when its client starts.

## Verification

- Rust regressions: nested root routing/permissions, cancellation before worker
  registration, isolation, recursive stop, completed-result races, cursor filtering,
  liveness cleanup, bounded notification bursts and 10,000-event replay across
  journal restart, including large Unicode payloads.
- Deterministic native CLI scenarios on Windows/Linux: Claude ↔ Codex, nested
  agents and direct-to-root messages, busy/sibling mailboxes, background wake-up,
  all four worker providers, provider switching, cancellation, UI message transport
  and Codex interrupt-before-unsubscribe ordering.
- Real subscription smoke: Claude delegates to Codex and Codex delegates to Claude;
  children message their parents, roots read `agent_events` and return the results.
  Only isolated test sessions are created and archived.
- WebView2 UI: selected-agent messaging and branch stop, alongside existing native
  Markdown/MCP/window/service checks and the 200-agent/10,000-event synthetic load.

Run `npm run test:teams` after building the Rust example drivers. CI includes this
suite in `npm run test:rust-core`. `node scripts/smoke-native-teams.mjs` deliberately
uses signed-in subscriptions and is an opt-in integration check, not a CI default.

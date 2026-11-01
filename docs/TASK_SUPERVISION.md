# Task supervision in Duet 0.3.0

The titlebar bell opens **Tasks and attention**: a unified inbox for approvals, questions and failed turns; a task inventory; workload controls; and Git conflict previews. Approvals reuse validated forms and the native permission broker. Inbox shortcuts: j/k select, a/d allow/deny ordinary tool requests. Plans, typed forms and permission subsets retain their own controls.

## Workload and recovery

Claude, Codex and Antigravity share one Rust turn dispatcher. Default concurrent turns: four in the app, three per Git project, four per team, four per provider. Worktrees share a project identity. One executor holds write ownership of each workspace, including while awaiting approval; read-only agents can run alongside it. Approval waits release compute capacity, and answered requests receive priority to resume.

New idle-chat input queues before launching a CLI when a limit is reached. Existing-turn steering retains its independent transport. Requests are FIFO among those whose constraints fit, allowing another project to proceed. Queue pause affects future starts; current turns and answered approvals can finish. Changing limits never interrupts running work.

Queued input is journaled in `native/queued-input.sqlite3` and retired after provider transport acknowledgement. Following a crash, the Tasks tab offers **Unsent messages**, which restores a draft without running a model. Multiple unsent inputs are combined in order, retaining images. Explicit queue cancellation or chat closure discards the queued input. Bounds: 256 queued chats, 32 inputs / 16 MiB per chat, 64 MiB in-memory input, 512 recovery records. A full queue reports an error and preserves the draft.

Queued delegation returns immediately instead of blocking a parent on a child without capacity. The parent finishes a checkpoint, frees its slot, and continues in the same chat after the child reports back. Dispatch, role and workspace events enter the family journal available to the root.

## Resource metrics

Windows uses native process accounting; Linux uses `/proc`. Metrics cover Duet and descendants without reading command lines. RAM is summed RSS/working set, so shared pages can be counted in several processes. CPU is measured between samples; 100% represents one core. Codex's shared app-server can appear in several task rows but is counted once in the total. Values describe processes, not per-chat allocations.

An optional RAM threshold pauses new admissions and releases eligible idle provider clients. Active work, native background tasks, approvals and in-flight requests are preserved. Saved sessions and Duet MCP children survive idle-client release. This is a scheduling threshold, not an OS memory limit. Provider-native helpers remain governed by their CLI; admission directly controls Duet-managed turns and delegated runs.

## Roles

- **Executor:** writes according to the chosen provider permissions.
- **Reviewer / Researcher:** read-only. Claude receives an explicit read/search tool set and strict MCP configuration. Codex uses a read-only sandbox with external apps/MCP disabled. Antigravity receives deny rules for writes, commands and external MCP. Native write/elevation approvals are rejected. Dynamic browser interactions are restricted to inspection. The permission picker cannot upgrade a role.
- Shared helpers default to Reviewer. The task table transfers executor ownership only when affected agents are idle; the previous shared executor becomes a reviewer. Only their provider clients restart, retaining sessions and children. Roles are stored locally for known sessions.
- Writable delegation uses `run_agent` with `role: "executor", workspace: "isolated"`. A registered worktree is created after admission, starting from the source HEAD. Uncommitted parent changes are not copied. Finishing never applies, merges or removes it automatically. Read-only agents cannot grant writable delegation.

## Conflict preview

The Conflicts tab snapshots current worktrees, including uncommitted and untracked non-ignored changes, through a private Git index and checks possible merges with `git merge-tree`. Normal indexes, branches and working files are preserved. Nothing is pushed or merged.

Unchanged snapshots and merge pairs are cached. Bounds: ten seconds, 32 candidate workspaces, 12 snapshots, 32 pairs, 256 changed files / 32 MiB per workspace. Skipped or unsupported checks produce partial-result warnings. Later edits require a new check. Temporary Git objects remain eligible for normal Git garbage collection.

## Verification

`npm run test:workbench` drives actual Rust transports through isolated CLI fixtures: cross-provider admission, no CLI before admission, cancellation, steering, approval capacity release/resumption, one-slot delegation, provider role restrictions, isolated executors and crash recovery. It consumes no real subscription calls.

Rust tests cover fairness, workspace ownership during approval waits, resource thresholds and real-Git preservation of staged/untracked work. Native Windows UI tests approve requests across chats, change roles, cancel queued input and preview conflicts. Linux tests exercise the panel, resource metrics and real conflict previews inside WebKitGTK.

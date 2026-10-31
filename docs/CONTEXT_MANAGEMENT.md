# Selective context management (0.2.7)

The Rust core stores a durable archive in `native/context.sqlite3` under the app's user-data directory. Each chat has a provider-neutral scope, stable block IDs, an active projection and a revision. Archiving removes selected blocks from future model input, not from the transcript or archive. Read and undo remain available after restart.

## Controls and model tools

Open the layers button next to the context indicator. Choose active or archived blocks, inspect their originals, archive/restore, pin/unpin, or select an available provider and model for compression. The target is an approximate token budget; preservation notes tell the compressor which facts matter. Dry run validates the request without changing context. Job rows show progress, source/result sizes, model, duration and cache use. Cancel applies to queued/preparing/ready jobs; undo reverses an applied edit.

Claude and Codex receive the `desk-context` toolset. Antigravity receives a run-scoped command using the Duet executable's `--context-client` mode, backed by the same native service. It does not require installing global MCP configuration.

| Action | Contract |
| --- | --- |
| `inspect` | Paged block metadata, previews, revision, job status and available compressor models; no full log dump. Default mode is active. |
| `read` | Read an original by `id`, optional byte `offset` and `max_bytes`; UTF-8 boundaries and a next offset are returned. |
| `edit` | `expected_revision`, `operations`, optional `dry_run`. Each operation has `action` and `ids`. Actions: archive, compress, restore, pin, unpin. |
| `job` | Status and compact result metadata by `job_id`. |
| `cancel` | Cancel a pending `job_id`; applied edits use restore instead. |
| `restore` | Undo a recorded change by `job_id`, with revision validation. |

Compression also requires `compressor: {provider, model}`, `target_tokens` and optional `preserve: string[]`. The selected model must exist in that provider's discovered catalog. No silent model fallback or API-key calls occur. Agent requests automatically continue the unfinished task after the safe checkpoint; manual UI requests apply on the next send.

Example after inspecting the current revision and IDs:

```json
{
  "expected_revision": 4,
  "operations": [{
    "action": "compress",
    "ids": ["selected-tool-block-id"],
    "compressor": {"provider": "codex", "model": "an-available-model-id"},
    "target_tokens": 800,
    "preserve": ["Exact failure message, affected paths and unresolved work"]
  }]
}
```

## Applying edits

Jobs move through queued → preparing → ready → staged → applied, or failed. One background worker prepares summaries through authenticated subscription CLIs with tools disabled and an isolated working directory. Summaries keep references to immutable originals; recompression reads those originals. Identical requests can reuse a local cache.

The active provider session is replaced at an idle dispatch boundary with the retained projection and the new message. This is a new internal CLI session, linked to the same application chat. A provider acknowledgement commits the staged change. Failure rolls it back, preserves newly received messages and restores the previous session for retry. Returning to another provider rebuilds context when its revision or message cursor is stale; it cannot bring archived blocks back.

An in-flight model turn is allowed to finish. Native CLI background tasks defer rebasing until safe because they belong to that CLI process. Duet MCP descendants remain alive across a context checkpoint and provider rotation. A checkpoint is reported as working, not as task completion. `context.changed` events enter the family journal, including the root agent's replay stream, and update open UI panels. Explicit Stop retains normal recursive stop semantics.

## Protections and limits

- Direct user instructions, unfinished tool/result pairs and pinned blocks cannot be archived or compressed. Pinned blocks must be explicitly unpinned first. Restoring an edit cannot forge operations to bypass these protections.
- Original images are preserved as attachment files; rebuilt context references them rather than embedding another base64 copy.
- Limits: 8 MiB per archive block, 2 MiB active projection, 512 KiB original source per compression operation, 64 KiB per read, 50 operations per request and 200 IDs per operation. Oversized operations return an error; they do not silently truncate history. A smaller batch can then be selected.
- Recording failures block rebasing rather than silently losing context. Only completed semantic events are archived; streaming deltas and thinking tokens are not duplicated into the context database.
- Capabilities and tool calls are scoped to the calling chat. Antigravity's loopback endpoint accepts only JSON POSTs with an exact host, a live random run token and no browser Origin. A rotated/stopped run loses access.
- Size and token savings are estimates. Compression quality depends on the selected model, and the target token count is a prompt budget rather than a provider tokenizer guarantee.

## Verification

`npm run test:context` drives actual Rust transports with isolated fake Claude/Codex/Antigravity CLIs. It checks model-issued edits, exclusion from subsequent provider input, cross-provider catch-up, undo, selected compressor routing, failure, cancellation and restart. Rust unit tests cover revision checks, scoped access, protected blocks, original provenance, rollback, UTF-8 framing, provider cursors and team checkpoint lifecycle.

`node scripts/native-inspect.mjs --fixtures` exercises Windows UI archive/undo and the real Duet CLI helper, including cross-chat denial. `npm run test:native-linux` covers the native WebKitGTK panel and projection changes on Linux. Fixtures verify transport and lifecycle behavior without consuming a real subscription; they do not measure real-model summary quality.

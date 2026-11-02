# Large CLI replies (0.3.1)

The old transport terminated a CLI connection whenever one JSON line exceeded
32 MiB. Codex resume/fork replies can include the whole saved transcript in one
line. Closing the shared app-server also interrupted its other chats.

Live CLI frames now stay in memory up to 4 MiB, then spill to a private temporary
file which is deleted after parsing or an error. The wire limit is 512 MiB;
retained JSON strings have a separate 128 MiB budget, with the existing object
and nesting limits. Small frames retain the in-memory fast path.

Only live protocol `result.thread.turns` and `params.thread.turns` are discarded
during deserialization. Session IDs, model/status metadata, normal tool output
and arbitrary nested business data are preserved. Saved transcript loading uses
the original parser and remains unchanged. The original history stays on disk.
RPC response values move to their waiter instead of being cloned.

Tests send an actual 40 MiB resume reply through the Rust subprocess transport,
then complete an approval in another chat and send the next turn in the resumed
session. Unit tests cover streamed projection, frame boundaries, temporary-file
cleanup, malformed JSON and preservation of ordinary history/business data.

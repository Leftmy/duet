# Large text pastes

Pasting at least 4,000 characters or 50 lines into the main composer creates a text file attachment. Short text keeps the normal clipboard behavior; image pastes keep the existing image attachment flow.

The Rust `fs:pasteText` command writes exact UTF-8 content, including original line endings, into the app data directory under `attachments/pasted-text/pasted-text-<uuid>.txt`. Files have unique names, an 8 MiB size limit and user-only file permissions on Unix. A reference is published only after the write completes. Files remain available after shutdown so restored history and queued messages retain their references.

The composer displays a small file card with line count and size. Cards can be opened in the file viewer or removed. Pending writes and write failures block sending. A failed write retains the source in the draft for retry; switching chats does not lose a pending attachment. After a successful write the source is dropped from UI state.

Messages carry only a Markdown file reference and a short `Files pasted by the user (read as needed)` label. The same format works with Claude, Codex and Antigravity, during steering and in the queue. File contents are read by the agent's tools when needed, rather than inserted automatically into every prompt. User messages and steering messages render these references as clickable file cards, including after history restoration. File cards do not execute or interpret file contents as instructions.

# History compatibility fixtures

`history-goldens.json` contains synthetic saved-session input and normalized expected events
recorded from the pre-migration reference parsers. It covers Claude tools, task notifications,
resumption, interrupted/dropped agents, selected helper history and both Codex log formats.

The native history tests consume these fixed records directly. No old provider implementation
is imported or shipped. Project directories are placeholders and records contain no user data.

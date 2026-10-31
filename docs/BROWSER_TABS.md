# Native browser tabs

The Windows and Linux native application keeps independent tabs per chat. The tab strip
supports creating, selecting and closing tabs, including middle-click close. Links that
request a new window open a new tab. Keyboard shortcuts in the browser toolbar are
Ctrl/Cmd+T, Ctrl/Cmd+W and Ctrl/Cmd+Tab (Shift reverses the direction).

The moon button unloads the selected page. The options menu can unload inactive tabs,
keep an individual tab awake, and set automatic sleep to off, 1, 5, 10 or 30 minutes.
The default is five minutes; the background maintenance pass runs every 30 seconds.
Closing the browser panel hides its selected page and makes it eligible for idle sleep.

Sleep closes the native child WebView, retaining the URL, title, pin, bounded URL history
and scroll position. Waking creates a fresh WebView and reloads the page. Cookies and
other browser-profile storage survive; JavaScript memory and unsaved form state do not.
Manual sleep stays asleep until selected or explicitly woken, including when menus close.
Restored sessions start with dormant tab metadata; they do not start a renderer per tab.
Metadata lives in `native/browser-tabs.json`, is written periodically and flushed at shutdown.
No form values are included in this metadata.

Automatic sleep skips visible or pinned pages, loading pages, active downloads and tabs
currently used by an agent operation. A bounded page probe also protects changed form
controls, input events, focused frames, playing HTML media and picture-in-picture.
An unresponsive page is skipped. These checks are best effort, not an application-state
snapshot. Manual sleep/close asks before overriding page protection; agent tools cannot
override it. Protection can be conservative for web editors and single-page applications.

With automatic sleep enabled, opening a page attempts to keep eight live pages across
chats by unloading the oldest eligible hidden pages. Protected pages may exceed this
soft limit. A hard limit of 32 live pages prevents unbounded renderers; there are at most
32 tab records per chat, 256 loaded tab records and 64 loaded chat spaces. Disabling
automatic sleep also disables pressure-based automatic discards. Manual sleep remains
available. A failed sleep leaves the native view intact.

The `desk-browser` MCP includes `list_tabs`, `new_tab`, `select_tab`, `close_tab` and
`sleep_tab`. Existing page tools accept optional `tab_id`. IDs are scoped to the owning
chat; specifying an ID does not change selection. Background creation stores only metadata.
Using a sleeping tab wakes it and waits for loading before reading or interacting. Each tab
serializes its own operations; page callbacks do not take that operation lock, and native
evaluations do not hold the shared host registry lock. Every native view gets a new label
on wake, so delayed events from disposed views cannot overwrite a new instance.

Validation: Rust manager tests cover disposal, protection, timers, bounds, persistence,
ownership, stale events and multiple-tab history. The isolated WebView2 integration test
exercises the tab strip, popup link, changed input confirmation, cookie/scroll restoration,
pinning and neighboring-tab activation through the real native manager and MCP tool path.
The Linux WebKitGTK test covers independent tabs, sleep, reload, capture and close.
These tests use temporary profiles and do not operate on an existing application session.
The MCP test hook requires both `DUET_NATIVE_TEST=1` and `DUET_NATIVE_PREVIEW=1`;
normal profiles do not expose it, and external pages cannot invoke application IPC.

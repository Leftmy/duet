// Window mode helpers with no store dependency (safe to import from store.ts).

const match = /^#detached=([^&]+)/.exec(typeof location !== 'undefined' ? location.hash : '');

/** Session id (or thread id) this window was opened for, or null in the main window. */
export const detachedKey: string | null = match ? decodeURIComponent(match[1]) : null;

/** True inside a detached chat window (one chat, no sidebar, no built-in browser). */
export function isDetachedWindow() {
  return detachedKey !== null;
}

/** What the main process hands to a detached window (win:info). */
export interface DetachInfo {
  threadId: string;
  sessionId?: string;
  title: string;
  cwd: string;
  chain?: { sessionId: string; title: string; cwd: string; lastModified: number; segment?: number }[];
  model?: string;
  effort?: string;
  permissionMode?: string;
  projectId?: string;
  draft?: string;
}

/** Normalize host error messages, including errors saved by older versions. */
export const ipcMessage = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

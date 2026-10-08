// Keeps open chats in step with their sessions on disk: another app window, the agent's own CLI or
// desktop app may continue a session this window shows. Polls the session files of the chats every
// window reports and emits desk:session-changed when one grows without this app writing to it.
import fs from 'node:fs';

const POLL_MS = 2000;
/** Writes this long after the app's own run was active are its own (results, titles, flushes). */
const OWN_WRITE_MS = 6000;

export function createSessionWatch({ registry, emit, activity, log = () => {} }) {
  /** window key → [{ threadId, sessionId, provider, cwd }] */
  const lists = new Map();
  /** sessionId → { file, mtime, size, threadIds } */
  const watched = new Map();
  let timer = null;

  async function fileOf(provider, sessionId, cwd) {
    try {
      return (await registry.get(provider).sessionFile?.(sessionId, cwd)) ?? null;
    } catch (e) {
      log('sessionFile failed', provider, sessionId, String(e?.message || e));
      return null;
    }
  }

  const stat = (file) => {
    try {
      const st = fs.statSync(file);
      return { mtime: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  };

  async function sync() {
    const want = new Map();
    for (const list of lists.values())
      for (const c of list) {
        if (!c?.sessionId) continue;
        const cur = want.get(c.sessionId) ?? { ...c, threadIds: new Set() };
        cur.threadIds.add(c.threadId);
        want.set(c.sessionId, cur);
      }
    for (const id of [...watched.keys()]) if (!want.has(id)) watched.delete(id);
    for (const [id, c] of want) {
      const w = watched.get(id);
      if (w) {
        w.threadIds = c.threadIds;
        continue;
      }
      const file = await fileOf(c.provider, id, c.cwd);
      if (!file) continue;
      watched.set(id, { file, ...(stat(file) ?? { mtime: 0, size: 0 }), threadIds: c.threadIds });
    }
  }

  function poll() {
    for (const [sessionId, w] of watched) {
      const st = stat(w.file);
      if (!st || (st.mtime === w.mtime && st.size === w.size)) continue;
      w.mtime = st.mtime;
      w.size = st.size;
      // Our own run writing (or just finished writing) isn't news.
      const own = [...w.threadIds].some((id) => activity(id, sessionId) > Date.now() - OWN_WRITE_MS);
      if (own) continue;
      for (const threadId of w.threadIds) emit('desk:session-changed', { threadId, sessionId });
    }
  }

  return {
    /** The chats one window shows; replaces that window's previous list. */
    async set(key, list) {
      lists.set(String(key), Array.isArray(list) ? list.slice(0, 200) : []);
      await sync();
      if (!timer && watched.size) {
        timer = setInterval(poll, POLL_MS);
        timer.unref?.();
      } else if (timer && !watched.size) {
        clearInterval(timer);
        timer = null;
      }
      return watched.size;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

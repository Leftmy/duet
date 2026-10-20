import type { ProviderId, SessionInfo, Thread } from '../types';

/** Provider sessions are aliases of a chat only when explicitly linked. Titles are not identities. */
export function linkedSessionIds(id: string, links: Record<string, string>): Set<string> {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [a, b] of Object.entries(links)) {
      if ((ids.has(a) || ids.has(b)) && (!ids.has(a) || !ids.has(b))) {
        ids.add(a);
        ids.add(b);
        changed = true;
      }
    }
  }
  return ids;
}

export function threadSessionIds(thread: Thread): string[] {
  return [...new Set([thread.id, thread.sessionId, ...Object.values(thread.sessions ?? {})].filter((id): id is string => Boolean(id)))];
}

export interface ChatRow {
  key: string;
  title: string;
  ts: number;
  cwd: string;
  session?: SessionInfo;
  thread?: Thread;
  provider?: ProviderId;
  older?: ChatRow[];
}

/** One row per logical chat, including during the gap before a new provider emits its session id. */
export function chatRows(sessions: SessionInfo[], threads: Record<string, Thread>, links: Record<string, string>, chatProviders: Record<string, ProviderId> = {}): ChatRow[] {
  const rows: ChatRow[] = [];
  const consumed = new Set<string>();
  const ordered = [...sessions].sort((a, b) => b.lastModified - a.lastModified);
  const rowOf = (s: SessionInfo): ChatRow => ({ key: s.sessionId, title: s.title, ts: s.lastModified, cwd: s.cwd, session: s });
  for (const thread of Object.values(threads)) {
    if (!thread.entries.length && !thread.sessionId) continue;
    const ids = new Set(threadSessionIds(thread).flatMap((id) => [...linkedSessionIds(id, links)]));
    const members = ordered.filter((s) => ids.has(s.sessionId));
    for (const id of ids) consumed.add(id);
    const head = members.find((s) => s.sessionId === thread.sessionId) ?? members[0];
    const last = thread.entries.at(-1);
    rows.push({
      key: head?.sessionId ?? thread.id, title: thread.title, cwd: thread.cwd, thread, session: head,
      ts: Math.max(head?.lastModified ?? 0, last ? (last.kind === 'user' ? last.ts : last.startedAt) : 0),
      older: members.filter((s) => s !== head).map(rowOf),
    });
  }
  for (const session of ordered) {
    if (consumed.has(session.sessionId)) continue;
    const ids = linkedSessionIds(session.sessionId, links);
    const members = ordered.filter((s) => ids.has(s.sessionId));
    for (const id of ids) consumed.add(id);
    rows.push({ ...rowOf(session), provider: chatProviders[session.sessionId] ?? session.provider, older: members.filter((s) => s !== session).map(rowOf) });
  }
  return rows.sort((a, b) => b.ts - a.ts);
}

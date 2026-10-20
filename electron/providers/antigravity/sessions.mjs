import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Duet's journal keeps native conversation IDs private to this adapter. */
export function createSessions(root) {
  const file = (id, ext) => {
    if (!/^agy-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid Antigravity session ID');
    return path.join(root, `${id}.${ext}`);
  };
  const read = (id) => JSON.parse(fs.readFileSync(file(id, 'json'), 'utf8'));
  const save = (meta) => {
    fs.mkdirSync(root, { recursive: true });
    const dest = file(meta.sessionId, 'json');
    const temp = `${dest}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(meta));
    fs.renameSync(temp, dest);
    return meta;
  };
  return {
    read,
    create(cwd, text) {
      const now = Date.now();
      return save({ sessionId: `agy-${randomUUID()}`, provider: 'antigravity', cwd, title: text.split('\n')[0].slice(0, 120) || 'Antigravity', createdAt: now, lastModified: now });
    },
    patch(id, patch) { return save({ ...read(id), ...patch }); },
    append(id, ev) { fs.appendFileSync(file(id, 'jsonl'), JSON.stringify(ev) + '\n'); },
    history(id) {
      read(id);
      try {
        return fs.readFileSync(file(id, 'jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
          // A crash may leave the final append incomplete; earlier events remain readable.
          try { return [JSON.parse(line)]; } catch { return []; }
        });
      } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
    rollback(id, dropTurns = 1) {
      if (dropTurns <= 0) return read(id);
      const events = this.history(id);
      const userIdx = events.flatMap((e, i) => (e.type === 'user' ? [i] : []));
      const keepTurns = Math.max(0, userIdx.length - dropTurns);
      const kept = keepTurns === 0 ? [] : events.slice(0, userIdx[keepTurns]);
      const dest = file(id, 'jsonl');
      const temp = `${dest}.tmp`;
      fs.writeFileSync(temp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
      fs.renameSync(temp, dest);
      return this.patch(id, { nativeId: null, rewound: kept.length > 0, lastModified: Date.now() });
    },
    handoffPrompt(id) {
      const events = this.history(id);
      if (!events.length) return null;
      const blocks = [];
      let answer = '';
      for (const ev of events) {
        if (ev.type === 'user' && ev.text) {
          if (answer.trim()) { blocks.push(`## Assistant\n${answer.trim()}`); answer = ''; }
          blocks.push(`## User\n${ev.text}`);
        } else if (ev.type === 'text' && ev.mode === 'final' && ev.text) {
          answer += (answer ? '\n\n' : '') + ev.text;
        } else if (ev.type === 'turn.end') {
          const text = answer.trim() || ev.text?.trim();
          if (text) blocks.push(`## Assistant\n${text}`);
          answer = '';
        }
      }
      if (!blocks.length) return null;
      return `<context_handoff>\nThis conversation was rewound to an earlier point. Treat only the transcript below as prior context and disregard any later turns.\n\n${blocks.join('\n\n')}\n</context_handoff>`;
    },
    list() {
      if (!fs.existsSync(root)) return [];
      return fs.readdirSync(root).filter((f) => /^agy-[a-f0-9-]{36}\.json$/.test(f)).flatMap((f) => {
        try { const { nativeId, rewound, ...meta } = read(f.slice(0, -5)); return [meta]; } catch { return []; }
      }).sort((a, b) => b.lastModified - a.lastModified);
    },
    remove(id) {
      for (const ext of ['json', 'jsonl']) fs.rmSync(file(id, ext), { force: true });
    },
    file: (id) => file(id, 'jsonl'),
  };
}

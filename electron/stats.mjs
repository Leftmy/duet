// Local usage log: one JSON line per finished Claude turn, plus periodic plan-limit snapshots.
import fs from 'node:fs';
import path from 'node:path';

export function createStats(dir) {
  const turnsFile = path.join(dir, 'stats-turns.jsonl');
  const limitsFile = path.join(dir, 'stats-limits.jsonl');
  const append = (file, rec) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  };
  const readLines = (file, since) => {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((r) => r && r.ts >= since);
    } catch {
      return [];
    }
  };

  let lastLimit = '';
  return {
    /** Called for every SDK `result` message of a main-thread turn. */
    recordTurn(meta, msg) {
      const models = Object.entries(msg.modelUsage ?? {}).map(([model, u]) => ({
        model,
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cacheReadInputTokens ?? 0,
        cacheWrite: u.cacheCreationInputTokens ?? 0,
        cost: u.costUSD ?? 0,
      }));
      append(turnsFile, {
        ts: Date.now(),
        sessionId: msg.session_id,
        cwd: meta.cwd,
        durationMs: msg.duration_ms ?? 0,
        turns: msg.num_turns ?? 0,
        cost: msg.total_cost_usd ?? 0,
        error: Boolean(msg.is_error),
        models,
      });
    },

    recordLimits(usage) {
      const rl = usage?.rate_limits;
      if (!rl) return;
      const rec = { session: rl.five_hour?.utilization ?? null, weekly: rl.seven_day?.utilization ?? null };
      const key = JSON.stringify(rec);
      if (key === lastLimit) return;
      lastLimit = key;
      append(limitsFile, { ts: Date.now(), ...rec });
    },

    summary(days = 30) {
      const since = Date.now() - days * 86400000;
      return { turns: readLines(turnsFile, since), limits: readLines(limitsFile, since) };
    },
  };
}

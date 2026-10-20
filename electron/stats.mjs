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
  const readLines = (file, since = 0) => {
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
      if (!msg.num_turns && !models.length) return;
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
      // Claude SDK result messages report cumulative session totals; convert them to per-turn deltas before slicing by date.
      const prevBySession = new Map();
      const turns = [];
      for (const r of readLines(turnsFile, 0)) {
        if (!r.turns && (!r.models || !r.models.length)) continue;
        if (r.delta) {
          if (r.ts >= since) turns.push(r);
          continue;
        }
        const sid = r.sessionId || '';
        const prev = prevBySession.get(sid);
        const rawCost = r.cost ?? 0;
        const cost = prev ? Math.max(0, rawCost - prev.cost) : rawCost;
        const prevModels = prev?.models ?? new Map();
        const nextModels = new Map(prevModels);
        const models = (r.models ?? []).map((m) => {
          const pm = prevModels.get(m.model);
          const cur = {
            input: m.input ?? 0,
            output: m.output ?? 0,
            cacheRead: m.cacheRead ?? 0,
            cacheWrite: m.cacheWrite ?? 0,
            cost: m.cost ?? 0,
          };
          nextModels.set(m.model, cur);
          return {
            model: m.model,
            input: pm ? Math.max(0, cur.input - pm.input) : cur.input,
            output: pm ? Math.max(0, cur.output - pm.output) : cur.output,
            cacheRead: pm ? Math.max(0, cur.cacheRead - pm.cacheRead) : cur.cacheRead,
            cacheWrite: pm ? Math.max(0, cur.cacheWrite - pm.cacheWrite) : cur.cacheWrite,
            cost: pm ? Math.max(0, cur.cost - pm.cost) : cur.cost,
          };
        });
        prevBySession.set(sid, { cost: rawCost, models: nextModels });
        if (r.ts >= since) turns.push({ ...r, cost, models, delta: true });
      }
      return { turns, limits: readLines(limitsFile, since) };
    },
  };
}

import { db } from './db.js'
import type { TokenUsage } from '../../../shared/types.js'

/**
 * Per-turn token accounting.
 *
 * On a Pro subscription these numbers are quota, not currency — worth showing
 * because rate limits are what actually bite, and because cache reads dominate
 * a long conversation and make raw input counts misleading on their own.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    session     TEXT,
    input       INTEGER NOT NULL DEFAULT 0,
    output      INTEGER NOT NULL DEFAULT 0,
    cache_read  INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    latency_ms  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at DESC);
`)

const insert = db.prepare(
  `INSERT INTO usage (at, session, input, output, cache_read, cache_write, latency_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
)

const totals = db.prepare(
  `SELECT COALESCE(SUM(input),0)       AS input,
          COALESCE(SUM(output),0)      AS output,
          COALESCE(SUM(cache_read),0)  AS cacheRead,
          COALESCE(SUM(cache_write),0) AS cacheWrite,
          COUNT(*)                     AS turns
   FROM usage`
)

const sinceStmt = db.prepare(
  `SELECT COALESCE(SUM(input),0)       AS input,
          COALESCE(SUM(output),0)      AS output,
          COALESCE(SUM(cache_read),0)  AS cacheRead,
          COALESCE(SUM(cache_write),0) AS cacheWrite,
          COUNT(*)                     AS turns
   FROM usage WHERE at >= ?`
)

export function recordUsage(
  usage: TokenUsage,
  opts: { session?: string | null; latencyMs?: number | null } = {}
): void {
  // A cancelled turn reports nothing; storing zero rows would skew averages.
  if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite) return
  try {
    insert.run(
      Date.now(),
      opts.session ?? null,
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      opts.latencyMs ?? null
    )
  } catch {
    /* accounting must never break a turn */
  }
}

export type UsageTotals = TokenUsage & { turns: number }

export function lifetimeUsage(): UsageTotals {
  return totals.get() as unknown as UsageTotals
}

/** Usage inside the current rate-limit window (Claude Pro resets every 5 hours). */
export function usageSince(ms: number): UsageTotals {
  return sinceStmt.get(Date.now() - ms) as unknown as UsageTotals
}

const recent = db.prepare(
  `SELECT at, session, input, output, cache_read AS cacheRead,
          cache_write AS cacheWrite, latency_ms AS latencyMs
   FROM usage ORDER BY at DESC LIMIT ?`
)

export interface UsageRow extends TokenUsage {
  at: number
  session: string | null
  latencyMs: number | null
}

export function recentUsage(limit = 200): UsageRow[] {
  return recent.all(limit) as unknown as UsageRow[]
}

/** CSV, so usage over time can be charted or audited outside JARVIS. */
export function exportUsage(limit = 5000): string {
  const rows = recentUsage(limit)
  const header = 'timestamp,session,input,output,cache_read,cache_write,total,latency_ms'
  if (rows.length === 0) return header + '\n'
  const body = rows
    .map((r) => {
      const total = r.input + r.output + r.cacheRead + r.cacheWrite
      return [
        new Date(r.at).toISOString(),
        r.session ?? '',
        r.input,
        r.output,
        r.cacheRead,
        r.cacheWrite,
        total,
        r.latencyMs ?? ''
      ].join(',')
    })
    .join('\n')
  return `${header}\n${body}\n`
}

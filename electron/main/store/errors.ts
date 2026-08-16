import { db } from './db.js'

export type ErrorSource = 'voice' | 'stt' | 'tts' | 'claude' | 'audio' | 'system' | 'permission'
export type Severity = 'warn' | 'error' | 'fatal'

export interface ErrorRecord {
  id: number
  at: number
  source: ErrorSource
  severity: Severity
  message: string
  context: string | null
  session: string | null
}

/** Errors older than this are pruned so the log cannot grow without bound. */
const RETENTION_DAYS = 14
const MAX_ROWS = 2000

const insert = db.prepare(
  `INSERT INTO errors (at, source, severity, message, context, session)
   VALUES (?, ?, ?, ?, ?, ?)`
)

const selectRecent = db.prepare(
  `SELECT id, at, source, severity, message, context, session
   FROM errors ORDER BY at DESC LIMIT ?`
)

const selectBySource = db.prepare(
  `SELECT id, at, source, severity, message, context, session
   FROM errors WHERE source = ? ORDER BY at DESC LIMIT ?`
)

const countAll = db.prepare('SELECT COUNT(*) AS n FROM errors')

/**
 * Identical errors repeat constantly (a stalled recognizer emits the same line
 * every few seconds). Rather than flooding the table, a repeat inside this
 * window is dropped.
 */
const DEDUPE_MS = 10_000
const lastSeen = new Map<string, number>()

export function recordError(
  source: ErrorSource,
  message: string,
  opts: { severity?: Severity; context?: unknown; session?: string | null } = {}
): void {
  const severity = opts.severity ?? 'error'
  const key = `${source}|${severity}|${message}`
  const now = Date.now()
  const previous = lastSeen.get(key)
  if (previous !== undefined && now - previous < DEDUPE_MS) return
  lastSeen.set(key, now)

  const context =
    opts.context === undefined
      ? null
      : typeof opts.context === 'string'
        ? opts.context
        : JSON.stringify(opts.context)

  try {
    insert.run(now, source, severity, message.slice(0, 4000), context, opts.session ?? null)
  } catch {
    // Logging must never take the app down.
  }
}

export function recentErrors(limit = 200): ErrorRecord[] {
  return selectRecent.all(limit) as unknown as ErrorRecord[]
}

export function errorsFrom(source: ErrorSource, limit = 200): ErrorRecord[] {
  return selectBySource.all(source, limit) as unknown as ErrorRecord[]
}

export function clearErrors(): void {
  db.exec('DELETE FROM errors')
  lastSeen.clear()
}

/** Trims by age, then by row count. Cheap enough to run at startup. */
export function pruneErrors(): number {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  const byAge = db.prepare('DELETE FROM errors WHERE at < ?').run(cutoff)

  let removed = Number(byAge.changes ?? 0)
  const { n } = countAll.get() as unknown as { n: number }
  if (n > MAX_ROWS) {
    const excess = db
      .prepare(
        `DELETE FROM errors WHERE id IN (
           SELECT id FROM errors ORDER BY at DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(MAX_ROWS)
    removed += Number(excess.changes ?? 0)
  }
  return removed
}

/** Plain-text export for sharing a bug report. */
export function exportErrors(limit = 500): string {
  const rows = recentErrors(limit)
  if (rows.length === 0) return 'No errors recorded.\n'
  return rows
    .map((r) => {
      const when = new Date(r.at).toISOString()
      const ctx = r.context ? `\n    ${r.context}` : ''
      return `${when} [${r.severity.toUpperCase()}] ${r.source}: ${r.message}${ctx}`
    })
    .join('\n')
}

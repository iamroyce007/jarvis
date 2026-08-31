import { randomUUID } from 'node:crypto'
import { db } from '../store/db.js'
import { log } from '../log.js'
import { budget } from './budget.js'
import { queryAllowed } from './safety.js'
import { deepSearch } from './sources.js'

/**
 * Watches (§17).
 *
 * "Watch this for changes" is a standing instruction, so it has to survive
 * restarts, and it has to cost almost nothing when nothing is happening — a
 * watch that ran a full research pass every hour would drain the rate-limit
 * window overnight and tell the user nothing.
 *
 * So a check is a query against the unindexed layer, which is cheap, fast and
 * involves no model at all. Only records genuinely not seen before count as a
 * development, and only then is the user interrupted.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS watches (
    id         TEXT PRIMARY KEY,
    subject    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    checked_at INTEGER,
    interval_ms INTEGER NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS watch_seen (
    watch_id TEXT NOT NULL,
    url      TEXT NOT NULL,
    at       INTEGER NOT NULL,
    PRIMARY KEY (watch_id, url)
  );
  CREATE TABLE IF NOT EXISTS watch_findings (
    id       TEXT PRIMARY KEY,
    watch_id TEXT NOT NULL,
    at       INTEGER NOT NULL,
    title    TEXT NOT NULL,
    url      TEXT NOT NULL,
    publisher TEXT,
    registry TEXT,
    seen     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_findings_at ON watch_findings(at DESC);
`)

export interface Watch {
  id: string
  subject: string
  createdAt: number
  checkedAt: number | null
  intervalMs: number
  active: boolean
  /** Developments not yet looked at. */
  unread: number
}

export interface Finding {
  id: string
  watchId: string
  subject: string
  at: number
  title: string
  url: string
  publisher: string | null
  registry: string | null
  seen: boolean
}

/** Four hours. Often enough to be useful, rare enough to be ignorable. */
const DEFAULT_INTERVAL = 4 * 60 * 60 * 1000

export function addWatch(subject: string, intervalMs = DEFAULT_INTERVAL): Watch | null {
  const clean = subject.trim()
  if (!clean || !queryAllowed(clean)) return null

  const existing = db
    .prepare('SELECT id FROM watches WHERE lower(subject) = lower(?) AND active = 1')
    .get(clean) as { id?: string } | undefined
  if (existing?.id) return getWatch(existing.id)

  const id = randomUUID()
  db.prepare(
    'INSERT INTO watches (id, subject, created_at, checked_at, interval_ms, active) VALUES (?,?,?,?,?,1)'
  ).run(id, clean, Date.now(), null, intervalMs)
  log(`watch: now watching "${clean}"`)
  return getWatch(id)
}

export function removeWatch(id: string): boolean {
  const r = db.prepare('UPDATE watches SET active = 0 WHERE id = ?').run(id) as {
    changes?: number | bigint
  }
  return Number(r.changes ?? 0) > 0
}

export function getWatch(id: string): Watch | null {
  const row = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row ? toWatch(row) : null
}

function toWatch(row: Record<string, unknown>): Watch {
  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM watch_findings WHERE watch_id = ? AND seen = 0')
    .get(String(row.id)) as { n: number }
  return {
    id: String(row.id),
    subject: String(row.subject),
    createdAt: Number(row.created_at),
    checkedAt: row.checked_at === null ? null : Number(row.checked_at),
    intervalMs: Number(row.interval_ms),
    active: Number(row.active) === 1,
    unread: Number(unread.n)
  }
}

export function listWatches(): Watch[] {
  const rows = db
    .prepare('SELECT * FROM watches WHERE active = 1 ORDER BY created_at DESC')
    .all() as Record<string, unknown>[]
  return rows.map(toWatch)
}

export function recentFindings(limit = 30): Finding[] {
  const rows = db
    .prepare(
      `SELECT f.*, w.subject FROM watch_findings f
       JOIN watches w ON w.id = f.watch_id
       ORDER BY f.at DESC LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: String(r.id),
    watchId: String(r.watch_id),
    subject: String(r.subject),
    at: Number(r.at),
    title: String(r.title),
    url: String(r.url),
    publisher: r.publisher ? String(r.publisher) : null,
    registry: r.registry ? String(r.registry) : null,
    seen: Number(r.seen) === 1
  }))
}

export function markFindingsSeen(watchId?: string): void {
  if (watchId) db.prepare('UPDATE watch_findings SET seen = 1 WHERE watch_id = ?').run(watchId)
  else db.prepare('UPDATE watch_findings SET seen = 1').run()
}

export interface WatchDevelopment {
  watch: Watch
  findings: Finding[]
}

/**
 * Checks one watch.
 *
 * The first check after a watch is created records what already exists without
 * reporting any of it: everything is new the first time you look, and a watch
 * that immediately announces forty existing articles is noise, not a finding.
 */
export async function checkWatch(id: string): Promise<WatchDevelopment | null> {
  const watch = getWatch(id)
  if (!watch || !watch.active) return null

  const first = watch.checkedAt === null
  const result = await deepSearch(watch.subject, { limit: 15 })
  db.prepare('UPDATE watches SET checked_at = ? WHERE id = ?').run(Date.now(), id)

  const seenStmt = db.prepare('SELECT 1 FROM watch_seen WHERE watch_id = ? AND url = ?')
  const remember = db.prepare(
    'INSERT OR IGNORE INTO watch_seen (watch_id, url, at) VALUES (?,?,?)'
  )
  const record = db.prepare(
    `INSERT INTO watch_findings (id, watch_id, at, title, url, publisher, registry, seen)
     VALUES (?,?,?,?,?,?,?,0)`
  )

  const fresh: Finding[] = []
  for (const rec of result.records) {
    if (seenStmt.get(id, rec.url)) continue
    remember.run(id, rec.url, Date.now())
    if (first) continue // Establish the baseline silently.
    const fid = randomUUID()
    record.run(fid, id, Date.now(), rec.title, rec.url, rec.publisher, rec.registry)
    fresh.push({
      id: fid,
      watchId: id,
      subject: watch.subject,
      at: Date.now(),
      title: rec.title,
      url: rec.url,
      publisher: rec.publisher,
      registry: rec.registry,
      seen: false
    })
  }

  if (first) {
    log(`watch: baseline for "${watch.subject}" — ${result.records.length} records recorded`)
    return null
  }
  if (fresh.length === 0) return null
  log(`watch: ${fresh.length} development(s) for "${watch.subject}"`)
  return { watch: { ...watch, unread: watch.unread + fresh.length }, findings: fresh }
}

let timer: NodeJS.Timeout | null = null

/**
 * Runs due watches.
 *
 * Checks are staggered and stop entirely when the rate-limit window is spent —
 * a background task should never be the reason a question the user actually
 * asked cannot be answered.
 */
async function tick(onDevelopment: (d: WatchDevelopment) => void): Promise<void> {
  if (!budget().allowed) return
  const due = listWatches().filter(
    (w) => w.checkedAt === null || Date.now() - w.checkedAt >= w.intervalMs
  )
  for (const w of due.slice(0, 3)) {
    try {
      const dev = await checkWatch(w.id)
      if (dev) onDevelopment(dev)
    } catch (err) {
      log(`watch check failed for "${w.subject}": ${err instanceof Error ? err.message : err}`)
    }
  }
}

export function startWatching(onDevelopment: (d: WatchDevelopment) => void): void {
  if (timer) return
  // The first sweep is delayed so it never competes with start-up.
  setTimeout(() => void tick(onDevelopment), 90_000)
  timer = setInterval(() => void tick(onDevelopment), 20 * 60 * 1000)
  timer.unref?.()
}

export function stopWatching(): void {
  if (timer) clearInterval(timer)
  timer = null
}

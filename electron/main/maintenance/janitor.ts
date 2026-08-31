import { readdirSync, statSync, unlinkSync, rmSync, existsSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { app } from 'electron'
import { db } from '../store/db.js'
import { log } from '../log.js'
import { LOG_PATH } from '../log.js'

/**
 * Housekeeping.
 *
 * JARVIS leaves debris in four places, and none of it was ever collected:
 * screenshots it takes to look at the screen, scraped page bodies and images
 * in the media cache, its own log, and rows in the database that describe
 * research nobody will ask about again.
 *
 * Screenshots are the sensitive ones. A screen capture can contain anything
 * that was on screen — messages, banking, passwords in a terminal — so those
 * are swept on the shortest schedule and are not kept "just in case".
 */

export interface SweepReport {
  screenshots: number
  screenshotBytes: number
  mediaFiles: number
  mediaBytes: number
  captures: number
  logBytes: number
  explanations: number
  briefings: number
  usageRows: number
  transcriptTurns: number
  errorRows: number
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Screenshots older than this go. Deliberately short: they are sensitive. */
const SCREENSHOT_MAX_AGE = Number(process.env.JARVIS_SCREENSHOT_TTL_MS ?? 30 * 60 * 1000)
/**
 * Cached remote images.
 *
 * Two days rather than seven. These are other publishers' photographs held on
 * this machine, and the reason to keep them at all is that revisiting a story
 * within the same sitting should be instant — a purpose that a couple of days
 * serves as well as a week. Anything older gets refetched, which also means a
 * picture that has since been corrected or withdrawn is not served forever.
 */
const MEDIA_MAX_AGE = Number(process.env.JARVIS_MEDIA_TTL_MS ?? 2 * DAY)

/** Hard ceiling on the cache regardless of age. */
const MEDIA_MAX_BYTES = Number(process.env.JARVIS_MEDIA_MAX_BYTES ?? 250 * 1024 * 1024)
/** Stored research. Beyond this it is stale enough to be worth re-running. */
const STORY_MAX_AGE = 30 * DAY
/** Token accounting. Kept longer because it is tiny and useful over time. */
const USAGE_MAX_AGE = 90 * DAY
/**
 * The spoken transcript.
 *
 * Everything the user has ever said out loud in front of this machine, in
 * plain text and full-text indexed. It had no expiry at all, which makes it
 * the most sensitive thing JARVIS stores and the least justified to keep.
 */
const TRANSCRIPT_MAX_AGE = Number(process.env.JARVIS_TRANSCRIPT_TTL_MS ?? 30 * DAY)
/** Diagnostics. Two thousand rows had accumulated with nothing collecting them. */
const ERROR_MAX_AGE = 7 * DAY
/** The log is truncated rather than deleted, so the current run keeps writing. */
const LOG_MAX_BYTES = 2 * 1024 * 1024

/**
 * Where JARVIS writes screen captures.
 *
 * The system prompt tells Claude to use `/tmp/jarvis-screen.png`, but it does
 * not always comply, so anything matching the shape is swept from both temp
 * directories rather than only the one filename.
 */
const SCREENSHOT_DIRS = ['/tmp', tmpdir(), join(homedir(), 'Desktop')]
const SCREENSHOT_NAME = /^(jarvis[-_].*\.(png|jpg|jpeg)|screen ?shot.*\.(png|jpg|jpeg))$/i

/**
 * Photographs sent from the phone's camera.
 *
 * These are whatever the user pointed a lens at — a document, a screen, a
 * letter — so they are as sensitive as a screen capture and get the same short
 * leash. Nothing was collecting them.
 */
function captureDir(): string {
  try {
    return join(app.getPath('userData'), 'captures')
  } catch {
    return join(homedir(), 'Library', 'Application Support', 'JARVIS', 'captures')
  }
}

function mediaDir(): string {
  try {
    return join(app.getPath('userData'), 'media')
  } catch {
    return join(homedir(), 'Library', 'Application Support', 'JARVIS', 'media')
  }
}

function sweepDir(
  dir: string,
  match: RegExp,
  maxAgeMs: number
): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  if (!existsSync(dir)) return { count, bytes }
  const cutoff = Date.now() - maxAgeMs
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { count, bytes }
  }
  for (const name of entries) {
    if (!match.test(name)) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile() || st.mtimeMs > cutoff) continue
      unlinkSync(full)
      count += 1
      bytes += st.size
    } catch {
      /* someone else's file, or already gone */
    }
  }
  return { count, bytes }
}

/** Evicts oldest-first until a directory is under a byte ceiling. */
function trimToSize(dir: string, maxBytes: number): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  if (!existsSync(dir)) return { count, bytes }
  try {
    const files = readdirSync(dir)
      .map((name) => {
        try {
          const st = statSync(join(dir, name))
          return st.isFile() ? { name, size: st.size, mtime: st.mtimeMs } : null
        } catch {
          return null
        }
      })
      .filter((f): f is { name: string; size: number; mtime: number } => f !== null)

    let total = files.reduce((n, f) => n + f.size, 0)
    if (total <= maxBytes) return { count, bytes }

    files.sort((a, b) => a.mtime - b.mtime)
    for (const f of files) {
      if (total <= maxBytes) break
      try {
        unlinkSync(join(dir, f.name))
        total -= f.size
        count += 1
        bytes += f.size
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* unreadable */
  }
  return { count, bytes }
}

/**
 * Deletes every screenshot immediately, regardless of age.
 *
 * Used on quit and on the user's explicit request — the age-based sweep is for
 * the periodic pass, but "clear the screenshots" should mean now.
 */
export function purgeScreenshots(): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const dir of [...new Set(SCREENSHOT_DIRS), captureDir()]) {
    const r = sweepDir(dir, dir === captureDir() ? /\.jpe?g$/i : SCREENSHOT_NAME, 0)
    count += r.count
    bytes += r.bytes
  }
  if (count > 0) log(`janitor: removed ${count} screenshot(s), ${Math.round(bytes / 1024)}KB`)
  return { count, bytes }
}

function pruneTable(table: string, column: string, maxAgeMs: number): number {
  try {
    const r = db
      .prepare(`DELETE FROM ${table} WHERE ${column} < ?`)
      .run(Date.now() - maxAgeMs) as { changes?: number | bigint }
    return Number(r.changes ?? 0)
  } catch {
    return 0
  }
}

/** One full pass. Safe to call at any time; nothing here blocks a turn. */
export function sweep(opts: { aggressive?: boolean } = {}): SweepReport {
  const report: SweepReport = {
    screenshots: 0,
    screenshotBytes: 0,
    mediaFiles: 0,
    mediaBytes: 0,
    captures: 0,
    logBytes: 0,
    explanations: 0,
    briefings: 0,
    usageRows: 0,
    transcriptTurns: 0,
    errorRows: 0
  }

  // --- screenshots: shortest leash, because of what they can contain -------
  for (const dir of new Set(SCREENSHOT_DIRS)) {
    const r = sweepDir(dir, SCREENSHOT_NAME, opts.aggressive ? 0 : SCREENSHOT_MAX_AGE)
    report.screenshots += r.count
    report.screenshotBytes += r.bytes
  }

  // --- camera captures, on the same short leash as screenshots -------------
  const captures = sweepDir(
    captureDir(),
    /\.jpe?g$/i,
    opts.aggressive ? 0 : SCREENSHOT_MAX_AGE
  )
  report.captures = captures.count
  report.screenshotBytes += captures.bytes

  // --- scraped imagery -----------------------------------------------------
  const media = sweepDir(mediaDir(), /./, opts.aggressive ? 0 : MEDIA_MAX_AGE)
  report.mediaFiles = media.count
  report.mediaBytes = media.bytes

  // Age alone does not bound the cache: a heavy afternoon of research can put
  // hundreds of megabytes on disk well inside the age limit. Oldest first.
  const overflow = trimToSize(mediaDir(), MEDIA_MAX_BYTES)
  report.mediaFiles += overflow.count
  report.mediaBytes += overflow.bytes

  // --- the log -------------------------------------------------------------
  try {
    const st = statSync(LOG_PATH)
    if (opts.aggressive || st.size > LOG_MAX_BYTES) {
      truncateSync(LOG_PATH, 0)
      report.logBytes = st.size
    }
  } catch {
    /* no log yet */
  }
  if (opts.aggressive) {
    const prev = join(homedir(), 'Library', 'Logs', 'JARVIS', 'jarvis.previous.log')
    try {
      if (existsSync(prev)) {
        report.logBytes += statSync(prev).size
        rmSync(prev)
      }
    } catch {
      /* ignore */
    }
  }

  // --- stored research -----------------------------------------------------
  report.explanations = pruneTable('explanations', 'at', opts.aggressive ? 0 : STORY_MAX_AGE)
  report.briefings = pruneTable('briefings', 'at', opts.aggressive ? 0 : STORY_MAX_AGE)
  report.usageRows = pruneTable('usage', 'at', opts.aggressive ? 0 : USAGE_MAX_AGE)
  report.errorRows = pruneTable('errors', 'at', opts.aggressive ? 0 : ERROR_MAX_AGE)

  // The transcript is mirrored into an FTS index, which does not follow a
  // DELETE on the base table on its own.
  report.transcriptTurns = pruneTable('turns', 'at', opts.aggressive ? 0 : TRANSCRIPT_MAX_AGE)
  if (report.transcriptTurns > 0) {
    try {
      db.exec(
        `DELETE FROM turns_fts WHERE rowid NOT IN (SELECT id FROM turns);
         INSERT INTO turns_fts(turns_fts) VALUES('optimize');`
      )
    } catch {
      /* the index rebuilds itself on next write */
    }
  }

  try {
    // WAL had grown to three times the database itself.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    if (opts.aggressive) db.exec('VACUUM')
  } catch {
    /* not fatal */
  }

  log(
    `janitor: ${report.screenshots} screenshots, ${report.captures} captures, ` +
      `${report.mediaFiles} cached images ` +
      `(${Math.round(report.mediaBytes / 1024 / 1024)}MB), ${report.explanations} stories, ` +
      `${report.briefings} briefings, ${report.transcriptTurns} transcript turns, ` +
      `${report.errorRows} error rows, ${report.usageRows} usage rows` +
      (report.logBytes ? `, log truncated (${Math.round(report.logBytes / 1024)}KB)` : '')
  )
  return report
}

let timer: NodeJS.Timeout | null = null

/** Sweeps at launch and every six hours after. */
export function startJanitor(): void {
  if (timer) return
  setTimeout(() => sweep(), 20_000)
  timer = setInterval(() => sweep(), 6 * HOUR)
  timer.unref?.()
}

export function stopJanitor(): void {
  if (timer) clearInterval(timer)
  timer = null
}

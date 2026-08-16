import { db } from './db.js'

/**
 * Durable conversation history.
 *
 * Claude Code keeps its own session transcript, but that is scoped to a single
 * session and disappears when one is replaced. JARVIS keeps its own copy so
 * "what did I ask you earlier?" works across restarts, and so a bad answer can
 * be traced back to exactly what the recognizer heard.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS turns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    speaker    TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    session    TEXT,
    source     TEXT,
    latency_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_turns_at ON turns(at DESC);
  CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session);

  CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts
    USING fts5(text, content='turns', content_rowid='id');

  CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
    INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`)

export interface Turn {
  id: number
  at: number
  speaker: 'user' | 'jarvis'
  text: string
  session: string | null
  source: string | null
  latencyMs: number | null
}

const insert = db.prepare(
  `INSERT INTO turns (at, speaker, text, session, source, latency_ms)
   VALUES (?, ?, ?, ?, ?, ?)`
)

const selectRecent = db.prepare(
  `SELECT id, at, speaker, text, session, source, latency_ms AS latencyMs
   FROM turns ORDER BY at DESC LIMIT ?`
)

const search = db.prepare(
  `SELECT t.id, t.at, t.speaker, t.text, t.session, t.source, t.latency_ms AS latencyMs
   FROM turns_fts f JOIN turns t ON t.id = f.rowid
   WHERE turns_fts MATCH ? ORDER BY t.at DESC LIMIT ?`
)

export function recordTurn(
  speaker: 'user' | 'jarvis',
  text: string,
  opts: { session?: string | null; source?: 'voice' | 'text'; latencyMs?: number | null } = {}
): void {
  const trimmed = text.trim()
  if (!trimmed) return
  try {
    insert.run(
      Date.now(),
      speaker,
      trimmed,
      opts.session ?? null,
      opts.source ?? null,
      opts.latencyMs ?? null
    )
  } catch {
    // History is never worth crashing over.
  }
}

export function recentTurns(limit = 200): Turn[] {
  return (selectRecent.all(limit) as unknown as Turn[]).reverse()
}

/** Full-text search across everything ever said. */
export function searchTurns(query: string, limit = 50): Turn[] {
  const cleaned = query.replace(/["*]/g, ' ').trim()
  if (!cleaned) return []
  try {
    return search.all(`"${cleaned}"`, limit) as unknown as Turn[]
  } catch {
    return []
  }
}

export function clearTurns(): void {
  db.exec('DELETE FROM turns')
}

/** Plain-text transcript for export. */
export function exportTurns(limit = 1000): string {
  const rows = recentTurns(limit)
  if (rows.length === 0) return 'No conversations recorded.\n'
  return rows
    .map((t) => {
      const when = new Date(t.at).toLocaleString()
      return `[${when}] ${t.speaker === 'user' ? 'You' : 'JARVIS'}: ${t.text}`
    })
    .join('\n')
}

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Local SQLite store. Electron 43 bundles Node 24, so `node:sqlite` is built in
 * and JARVIS needs no native module and no rebuild step.
 */

const DIR = join(homedir(), 'Library', 'Application Support', 'JARVIS')
mkdirSync(DIR, { recursive: true })

export const DB_PATH = join(DIR, 'jarvis.db')

export const db = new DatabaseSync(DB_PATH)

// WAL keeps writes from blocking reads while the UI polls.
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS errors (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    source    TEXT    NOT NULL,
    severity  TEXT    NOT NULL,
    message   TEXT    NOT NULL,
    context   TEXT,
    session   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_errors_at ON errors(at DESC);
  CREATE INDEX IF NOT EXISTS idx_errors_source ON errors(source);
`)

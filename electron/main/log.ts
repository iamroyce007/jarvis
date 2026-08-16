import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * File logging. A packaged .app has nowhere to print, so stdout is useless for
 * diagnosing the voice pipeline once JARVIS is launched from Finder.
 *
 * The log is appended across runs — truncating on start destroyed the evidence
 * from whatever crash prompted the restart. It rotates once oversized.
 */
const DIR = join(homedir(), 'Library', 'Logs', 'JARVIS')
export const LOG_PATH = join(DIR, 'jarvis.log')
const PREVIOUS_PATH = join(DIR, 'jarvis.previous.log')
const MAX_BYTES = 5 * 1024 * 1024

try {
  mkdirSync(DIR, { recursive: true })
  try {
    if (statSync(LOG_PATH).size > MAX_BYTES) renameSync(LOG_PATH, PREVIOUS_PATH)
  } catch {
    /* no existing log */
  }
  appendFileSync(LOG_PATH, `\n--- JARVIS started ${new Date().toISOString()} ---\n`)
} catch {
  /* logging must never break startup */
}

export function log(...parts: unknown[]): void {
  const line =
    new Date().toISOString().slice(11, 23) +
    ' ' +
    parts
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ') +
    '\n'
  try {
    appendFileSync(LOG_PATH, line)
  } catch {
    /* ignore */
  }
  console.log(line.trimEnd())
}

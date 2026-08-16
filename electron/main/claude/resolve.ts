import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Locates the `claude` binary.
 *
 * An app launched from Finder or a login item inherits launchd's environment,
 * not a shell's — typically just /usr/bin:/bin:/usr/sbin:/sbin. Claude Code
 * installs to ~/.local/bin, which is not on that path, so a bare `spawn('claude')`
 * fails with ENOENT for every GUI launch while working fine from a terminal.
 */

const CANDIDATES = [
  join(homedir(), '.local', 'bin', 'claude'),
  join(homedir(), '.claude', 'local', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude'
]

/** Directories worth having on PATH for any tool Claude Code itself shells out to. */
export const EXTRA_PATH_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
]

let cached: string | null = null

export function resolveClaudeBinary(): string {
  if (cached) return cached

  const override = process.env.JARVIS_CLAUDE_BIN
  if (override && existsSync(override)) {
    cached = override
    return cached
  }

  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) {
      cached = candidate
      return cached
    }
  }

  // Last resort: ask a login shell, which sources the user's profile.
  try {
    const found = execFileSync('/bin/zsh', ['-lic', 'command -v claude'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .trim()
      .split('\n')
      .pop()
    if (found && existsSync(found)) {
      cached = found
      return cached
    }
  } catch {
    /* shell lookup failed; fall through */
  }

  cached = 'claude'
  return cached
}

/** PATH for spawned processes, with the GUI-launch gaps filled in. */
export function enrichedPath(): string {
  const existing = (process.env.PATH ?? '').split(':').filter(Boolean)
  const merged = [...new Set([...EXTRA_PATH_DIRS, ...existing])]
  return merged.join(':')
}

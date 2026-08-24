import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { resolveClaudeBinary, enrichedPath } from '../claude/resolve.js'
import { db } from '../store/db.js'
import { log } from '../log.js'

const execFileAsync = promisify(execFile)

/**
 * Scenario projection.
 *
 * These are explicitly *plausible paths*, never predictions. The distinction is
 * enforced structurally: every scenario must state the assumptions it rests on,
 * the observable triggers that would advance it, and — most importantly — what
 * would falsify it. A projection you cannot invalidate is a guess dressed up as
 * analysis, so a scenario without a falsifier is rejected at parse time.
 *
 * Likelihood is a coarse band, not a decimal probability, because a precise
 * number would imply a model that does not exist here.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS projections (
    id      TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    at      INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projections_at ON projections(at DESC);
`)

export type Likelihood = 'most likely' | 'plausible' | 'possible' | 'unlikely'

export interface Scenario {
  title: string
  /** What this path looks like if it happens. */
  outline: string
  likelihood: Likelihood
  /** What must hold for this to be on the table at all. */
  assumptions: string[]
  /** Observable signals that this path is being taken. */
  triggers: string[]
  /** Downstream effects if it does happen. */
  consequences: string[]
  /** What would rule this out. Required — a scenario without one is discarded. */
  falsifiers: string[]
}

export interface Projection {
  id: string
  subject: string
  at: number
  /** What is actually known right now, separated from what is projected. */
  currentState: string
  observations: string[]
  scenarios: Scenario[]
  /** The variables that most affect which path is taken. */
  keyVariables: string[]
  failure?: string
}

const PROMPT = `You are an analyst producing scenario projections. You are NOT
predicting the future and must never imply that you are.

Return ONLY minified JSON — no prose, no code fence:

{"currentState":"","observations":[""],
 "scenarios":[{"title":"","outline":"","likelihood":"","assumptions":[""],
               "triggers":[""],"consequences":[""],"falsifiers":[""]}],
 "keyVariables":[""]}

likelihood MUST be one of: most likely, plausible, possible, unlikely

Rules that are not negotiable:
- Separate OBSERVATION from INFERENCE from PROJECTION. "observations" contains
  only things currently true and checkable. Everything in "scenarios" is
  explicitly hypothetical.
- Every scenario MUST include at least one "falsifier": a concrete, observable
  thing that would rule it out. A scenario that cannot be invalidated is not
  analysis and will be discarded.
- Every scenario MUST include its "assumptions". If a path depends on something
  unverified, say so there.
- Give 3 or 4 scenarios spanning genuinely different outcomes, including at
  least one where the current trend does NOT continue.
- Never state a numeric probability. The likelihood band is deliberately coarse.
- "keyVariables" names the few things that most determine which path occurs.
- If you do not have enough information to project responsibly, return one
  scenario titled "Insufficient basis" explaining what is missing.`

function parseJson<T>(raw: string): T | null {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

function coerceLikelihood(v: unknown): Likelihood {
  const ok: Likelihood[] = ['most likely', 'plausible', 'possible', 'unlikely']
  return ok.includes(v as Likelihood) ? (v as Likelihood) : 'possible'
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter((s) => s.trim().length > 0) : []

let inFlight = false

export function isProjecting(): boolean {
  return inFlight
}

export async function project(
  subject: string,
  opts: { cwd?: string; context?: string; onProgress?: (s: string) => void } = {}
): Promise<Projection> {
  const base: Projection = {
    id: randomUUID(),
    subject,
    at: Date.now(),
    currentState: '',
    observations: [],
    scenarios: [],
    keyVariables: []
  }
  if (inFlight) return { ...base, failure: 'Another projection is already running.' }
  inFlight = true
  const progress = opts.onProgress ?? ((): void => {})

  try {
    progress('Establishing current state')
    const payload =
      `${PROMPT}\n\n<SUBJECT>\n${subject}\n</SUBJECT>` +
      (opts.context ? `\n\n<KNOWN>\n${opts.context}\n</KNOWN>` : '')

    progress('Projecting')
    const { stdout } = await execFileAsync(
      resolveClaudeBinary(),
      [
        '-p',
        payload,
        '--model',
        'claude-sonnet-5',
        '--effort',
        'medium',
        '--strict-mcp-config',
        '--permission-mode',
        'bypassPermissions',
        '--disallowedTools',
        'Bash,Edit,Write,NotebookEdit,Task'
      ],
      {
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
        cwd: opts.cwd,
        env: { ...process.env, PATH: enrichedPath(), ANTHROPIC_API_KEY: undefined } as NodeJS.ProcessEnv
      }
    )

    const parsed = parseJson<Record<string, unknown>>(stdout)
    if (!parsed) return { ...base, failure: 'Projection returned no usable structure.' }

    const scenarios: Scenario[] = (Array.isArray(parsed.scenarios) ? parsed.scenarios : [])
      .map((x) => {
        const o = x as Record<string, unknown>
        return {
          title: String(o.title ?? ''),
          outline: String(o.outline ?? ''),
          likelihood: coerceLikelihood(o.likelihood),
          assumptions: strings(o.assumptions),
          triggers: strings(o.triggers),
          consequences: strings(o.consequences),
          falsifiers: strings(o.falsifiers)
        }
      })
      // A scenario with nothing that would rule it out is unfalsifiable and is
      // dropped rather than shown as if it were analysis.
      .filter((s) => s.title && (s.falsifiers.length > 0 || /insufficient/i.test(s.title)))

    const projection: Projection = {
      ...base,
      currentState: String(parsed.currentState ?? ''),
      observations: strings(parsed.observations),
      scenarios,
      keyVariables: strings(parsed.keyVariables)
    }

    db.prepare('INSERT INTO projections (id, subject, at, payload) VALUES (?, ?, ?, ?)').run(
      projection.id,
      subject,
      projection.at,
      JSON.stringify(projection)
    )
    log(`projection "${subject}": ${scenarios.length} scenarios`)
    return projection
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('projection failed:', msg)
    return { ...base, failure: msg.slice(0, 300) }
  } finally {
    inFlight = false
  }
}

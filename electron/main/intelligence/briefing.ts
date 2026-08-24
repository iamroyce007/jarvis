import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { resolveClaudeBinary, enrichedPath } from '../claude/resolve.js'
import { db } from '../store/db.js'
import { log } from '../log.js'
import type { Confidence } from '../store/graph.js'

const execFileAsync = promisify(execFile)

/**
 * Research briefings.
 *
 * A briefing is a structured, sourced answer to "tell me about X" — the thing
 * that turns a spoken question into an intelligence profile rather than a
 * paragraph of prose.
 *
 * Two rules govern everything here, and they are what separate this from a
 * chatbot answering from memory:
 *   1. Every claim carries a confidence level and points at the sources that
 *      support it. A claim with no source is marked `inferred`, never `confirmed`.
 *   2. Sources are real URLs returned by an actual web search. The model is
 *      explicitly forbidden from inventing them, and any source that fails to
 *      resolve is flagged rather than silently shown as if verified.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS briefings (
    id       TEXT PRIMARY KEY,
    subject  TEXT NOT NULL,
    kind     TEXT NOT NULL,
    at       INTEGER NOT NULL,
    payload  TEXT NOT NULL,
    ms       INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_briefings_at ON briefings(at DESC);
`)

export interface BriefingSource {
  id: number
  title: string
  url: string
  domain: string
  publisher?: string
  date?: string
  /** Populated after the link is checked; null means unverified. */
  reachable?: boolean | null
  image?: string | null
}

export interface BriefingClaim {
  statement: string
  confidence: Confidence
  /** Indices into `sources`. Empty means unsupported — shown as inferred. */
  sources: number[]
}

export interface BriefingSection {
  title: string
  body: string
  confidence: Confidence
  sources: number[]
}

export interface BriefingTimelineItem {
  date: string
  label: string
  detail?: string
  confidence: Confidence
  sources: number[]
}

export interface Briefing {
  id: string
  subject: string
  kind: string
  headline: string
  summary: string
  at: number
  ms: number
  sections: BriefingSection[]
  timeline: BriefingTimelineItem[]
  entities: { name: string; kind: string; role?: string }[]
  claims: BriefingClaim[]
  sources: BriefingSource[]
  openQuestions: string[]
  /** Set when the model could not research the subject at all. */
  failure?: string
}

const RESEARCH_PROMPT = `You are an intelligence analyst producing a briefing.

Use web search to research the SUBJECT below. Base the briefing on what you
actually find. Then return ONLY minified JSON — no prose, no code fence:

{"headline":"","summary":"","kind":"person|event|organization|company|technology|place|concept",
 "sections":[{"title":"","body":"","confidence":"","sources":[0]}],
 "timeline":[{"date":"","label":"","detail":"","confidence":"","sources":[0]}],
 "entities":[{"name":"","kind":"","role":""}],
 "claims":[{"statement":"","confidence":"","sources":[0]}],
 "sources":[{"title":"","url":"","domain":"","publisher":"","date":""}],
 "openQuestions":[""]}

confidence MUST be one of: confirmed, corroborated, reported, inferred, disputed, unknown

Non-negotiable rules:
- NEVER invent a source. Every entry in "sources" must be a real URL you
  actually retrieved during this search. If you cannot find sources, return an
  empty sources array and mark everything "unknown".
- "sources" indices in sections/claims/timeline refer to positions in the
  sources array, starting at 0.
- "confirmed" requires multiple independent reliable sources agreeing.
  "corroborated" = two sources. "reported" = a single source. "disputed" =
  sources disagree — say so explicitly in the body. "inferred" = your own
  reasoning, not stated by any source.
- Distinguish established fact from allegation and from claim. For contested or
  legally sensitive matters use neutral language and attribute: "X was reported
  by Y to have...", never "X did...".
- openQuestions should name what remains genuinely unresolved or unverified.
- 4 to 7 sections. Prefer specific, dated, attributable detail over generalities.
- If the subject is ambiguous, brief the most likely reading and say so in the
  summary.`

/** Extracts JSON from a response that may be fenced or prefixed with prose. */
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

function coerceConfidence(v: unknown): Confidence {
  const ok: Confidence[] = ['confirmed', 'corroborated', 'reported', 'inferred', 'disputed', 'unknown']
  return ok.includes(v as Confidence) ? (v as Confidence) : 'unknown'
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Confirms a source URL actually resolves, and picks up its preview image.
 *
 * This is the "verified authenticity" step: a citation the model produced is
 * not treated as real until the link has been fetched. Anything unreachable is
 * surfaced as such in the UI rather than displayed as a working reference.
 */
async function verifySource(src: BriefingSource): Promise<BriefingSource> {
  if (!/^https?:\/\//i.test(src.url)) return { ...src, reachable: false, image: null }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(src.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) JARVIS/1.0 link-preview' }
    })
    clearTimeout(timer)
    if (!res.ok) return { ...src, reachable: false, image: null }

    const html = (await res.text()).slice(0, 200_000)
    // Standard link-preview metadata, the same thing a chat app reads.
    const og =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ??
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    let image = og?.[1] ?? null
    if (image && image.startsWith('//')) image = `https:${image}`
    if (image && image.startsWith('/')) {
      try {
        image = new URL(image, src.url).toString()
      } catch {
        image = null
      }
    }
    return { ...src, reachable: true, image }
  } catch {
    return { ...src, reachable: false, image: null }
  }
}

let inFlight = false

export function isBriefingRunning(): boolean {
  return inFlight
}

/**
 * Researches a subject and returns a structured briefing.
 * `onProgress` reports the stage so the UI can show the work happening.
 */
export async function research(
  subject: string,
  opts: { cwd?: string; onProgress?: (stage: string) => void } = {}
): Promise<Briefing> {
  const started = Date.now()
  const base: Briefing = {
    id: randomUUID(),
    subject,
    kind: 'concept',
    headline: subject,
    summary: '',
    at: started,
    ms: 0,
    sections: [],
    timeline: [],
    entities: [],
    claims: [],
    sources: [],
    openQuestions: []
  }

  if (inFlight) return { ...base, failure: 'Another briefing is already running.' }
  inFlight = true
  const progress = opts.onProgress ?? ((): void => {})

  try {
    progress('Searching')
    const payload = `${RESEARCH_PROMPT}\n\n<SUBJECT>\n${subject}\n</SUBJECT>`

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
        // `-p` has no interactive approval channel, so a tool awaiting approval
        // is auto-rejected and the research dead-ends ("I need permission to use
        // web search"). Safety here comes from the denylist below, not prompts.
        '--permission-mode',
        'bypassPermissions',
        // Research needs the web; everything that touches this machine is off.
        '--disallowedTools',
        'Bash,Edit,Write,NotebookEdit,Task'
      ],
      {
        timeout: 240_000,
        maxBuffer: 8 * 1024 * 1024,
        cwd: opts.cwd,
        env: { ...process.env, PATH: enrichedPath(), ANTHROPIC_API_KEY: undefined } as NodeJS.ProcessEnv
      }
    )

    progress('Structuring')
    const parsed = parseJson<Record<string, unknown>>(stdout)
    if (!parsed) {
      return { ...base, ms: Date.now() - started, failure: 'Research returned no usable structure.' }
    }

    const rawSources = Array.isArray(parsed.sources) ? parsed.sources : []
    const sources: BriefingSource[] = rawSources
      .map((s, i) => {
        const o = s as Record<string, unknown>
        const url = String(o.url ?? '')
        return {
          id: i,
          title: String(o.title ?? url),
          url,
          domain: String(o.domain ?? domainOf(url)),
          publisher: o.publisher ? String(o.publisher) : undefined,
          date: o.date ? String(o.date) : undefined,
          reachable: null,
          image: null
        }
      })
      .filter((s) => s.url.length > 0)

    progress('Verifying sources')
    // Verified in parallel; a slow or dead link must not hold up the briefing.
    const verified = await Promise.all(sources.map(verifySource))

    const idxs = (v: unknown): number[] =>
      Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < verified.length) : []

    const briefing: Briefing = {
      ...base,
      kind: String(parsed.kind ?? 'concept'),
      headline: String(parsed.headline ?? subject),
      summary: String(parsed.summary ?? ''),
      ms: Date.now() - started,
      sources: verified,
      sections: (Array.isArray(parsed.sections) ? parsed.sections : []).map((x) => {
        const o = x as Record<string, unknown>
        return {
          title: String(o.title ?? ''),
          body: String(o.body ?? ''),
          confidence: coerceConfidence(o.confidence),
          sources: idxs(o.sources)
        }
      }),
      timeline: (Array.isArray(parsed.timeline) ? parsed.timeline : []).map((x) => {
        const o = x as Record<string, unknown>
        return {
          date: String(o.date ?? ''),
          label: String(o.label ?? ''),
          detail: o.detail ? String(o.detail) : undefined,
          confidence: coerceConfidence(o.confidence),
          sources: idxs(o.sources)
        }
      }),
      entities: (Array.isArray(parsed.entities) ? parsed.entities : []).map((x) => {
        const o = x as Record<string, unknown>
        return {
          name: String(o.name ?? ''),
          kind: String(o.kind ?? 'other'),
          role: o.role ? String(o.role) : undefined
        }
      }),
      claims: (Array.isArray(parsed.claims) ? parsed.claims : []).map((x) => {
        const o = x as Record<string, unknown>
        return {
          statement: String(o.statement ?? ''),
          confidence: coerceConfidence(o.confidence),
          sources: idxs(o.sources)
        }
      }),
      openQuestions: (Array.isArray(parsed.openQuestions) ? parsed.openQuestions : []).map(String)
    }

    db.prepare(
      'INSERT INTO briefings (id, subject, kind, at, payload, ms) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(briefing.id, subject, briefing.kind, briefing.at, JSON.stringify(briefing), briefing.ms)

    const live = verified.filter((s) => s.reachable).length
    log(
      `briefing "${subject}": ${briefing.sections.length} sections, ` +
        `${verified.length} sources (${live} verified) in ${briefing.ms}ms`
    )
    return briefing
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('briefing failed:', msg)
    return { ...base, ms: Date.now() - started, failure: msg.slice(0, 300) }
  } finally {
    inFlight = false
  }
}

export function recentBriefings(limit = 20): { id: string; subject: string; kind: string; at: number }[] {
  return db
    .prepare('SELECT id, subject, kind, at FROM briefings ORDER BY at DESC LIMIT ?')
    .all(limit) as unknown as { id: string; subject: string; kind: string; at: number }[]
}

export function getBriefing(id: string): Briefing | null {
  const row = db.prepare('SELECT payload FROM briefings WHERE id = ?').get(id) as
    | { payload: string }
    | undefined
  return row ? (JSON.parse(row.payload) as Briefing) : null
}

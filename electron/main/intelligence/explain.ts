import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { resolveClaudeBinary, enrichedPath } from '../claude/resolve.js'
import { readPages, type PageContent, type PageImage } from './browser.js'
import { mediaUrl, originalUrl, prefetch } from '../media/proxy.js'
import { ingestExplanation, findConnections, type Connection } from './correlate.js'
import { fastWorker, webWorker, type StructuredWorker } from './worker.js'
import { db } from '../store/db.js'
import { log } from '../log.js'
import type { Confidence } from '../store/graph.js'

const execFileAsync = promisify(execFile)

/**
 * The explain pipeline — one pass, streamed.
 *
 * The earlier design made three sequential model calls (find pages, research,
 * then resolve imagery per frame) and took well over a minute before anything
 * appeared. This does the opposite: a single call produces the whole story
 * *and* the URLs behind it, the story is emitted the moment it parses, and the
 * imagery is filled in afterwards by a real browser reading those same pages
 * in parallel.
 *
 * The user sees the story assemble rather than waiting for it to be finished.
 */

export type FrameKind =
  | 'hero' | 'portrait' | 'evidence' | 'timeline' | 'conflict'
  | 'quote' | 'stat' | 'place' | 'conclusion' | 'facts' | 'connections'

export interface Fact {
  label: string
  value: string
}

export interface ExplainFrame {
  id: string
  kind: FrameKind
  title: string
  narration: string
  subject?: string
  /** What the subject is, as the research declared it. Absent when unsure. */
  subjectKind?: string
  role?: string
  confidence: Confidence
  /** Indices into `sources`. */
  sources: number[]
  facts?: Fact[]
  sides?: { claim: string; source: number }[]
  value?: string
  unit?: string
  quote?: string
  attribution?: string
  timeline?: { date: string; label: string; detail?: string }[]
  /** What the accumulated graph already knows that touches this subject. */
  connections?: Connection[]
  media?: { image: string; credit: string; pageUrl: string; caption?: string }
}

export interface ExplainSource {
  id: number
  title: string
  url: string
  publisher: string
  date?: string
  reachable?: boolean
}

export interface Explanation {
  id: string
  subject: string
  kind: string
  headline: string
  summary: string
  /** The quick-reference facts panel: dates, roles, numbers. */
  facts: Fact[]
  frames: ExplainFrame[]
  sources: ExplainSource[]
  openQuestions: string[]
  relatedSubjects: string[]
  at: number
  ms: number
  /** How much was actually gathered, for the provenance strip. */
  coverage?: { facts: number; sources: number; reachable: number; images: number; entities: number }
  /** True while this is the unverified sketch rather than researched output. */
  provisional?: boolean
  failure?: string
}

db.exec(`
  CREATE TABLE IF NOT EXISTS explanations (
    id      TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    at      INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_expl_at ON explanations(at DESC);
`)

const PROMPT = `You are an intelligence analyst and visual director.

Search the web for the SUBJECT, then return a STORYBOARD that explains it —
substance first, not decoration. Return ONLY minified JSON, no prose, no fence:

{"headline":"","summary":"","kind":"person|event|organization|company|technology|place|concept",
 "facts":[{"label":"","value":""}],
 "frames":[{"kind":"","title":"","narration":"","subject":"","subjectKind":"","role":"","confidence":"",
            "sources":[0],"facts":[{"label":"","value":""}],
            "sides":[{"claim":"","source":0}],"value":"","unit":"",
            "quote":"","attribution":"",
            "timeline":[{"date":"","label":"","detail":""}]}],
 "sources":[{"title":"","url":"","publisher":"","date":""}],
 "openQuestions":[""],
 "relatedSubjects":[""]}

FRAME KINDS — pick what genuinely explains each point:
  hero        the subject itself. "subject" = exact searchable name for imagery.
  facts       the hard specifics: dates, numbers, roles, affiliations, status.
  portrait    a person who matters. "subject" = their name, "role" = why here.
  place       a location that matters. "subject" = place name.
  stat        one number that reframes things. "value" + "unit".
  quote       a direct quotation that carries weight. "quote" + "attribution".
  timeline    how it unfolded. Fill the frame's own "timeline" array.
  evidence    what sources actually report, cited.
  conflict    sources disagree. Fill "sides", each pointing at its source.
  conclusion  what is established and what is not.

RULES:
- 6 to 9 frames. First is "hero". Second should usually be "facts". Last is
  "conclusion". Include "conflict" whenever sources genuinely disagree.
- "facts" (top level) is the quick-reference panel: 4 to 8 concrete entries like
  {"label":"Born","value":"10 March 1957, Riyadh"}. Specific, checkable, dense.
- narration is what JARVIS says aloud for that frame: one or two spoken
  sentences, conversational, no markdown.
- "subject" must be a real searchable proper name, or omitted.
- "subjectKind" classifies that subject: person, organization, company, event,
  place, product, technology or concept. Omit it if you are not sure — a wrong
  classification is worse than none.
- NEVER invent a source. Every URL must be one you actually retrieved.
- confidence: confirmed (multiple independent sources), corroborated (two),
  reported (one), inferred (your reasoning), disputed, unknown.
- For contested matters attribute rather than assert.
- relatedSubjects: 3 to 5 things worth investigating next.

Be dense with real information. Vague summary is failure.`

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

function conf(v: unknown): Confidence {
  const ok: Confidence[] = ['confirmed', 'corroborated', 'reported', 'inferred', 'disputed', 'unknown']
  return ok.includes(v as Confidence) ? (v as Confidence) : 'unknown'
}

function publisherOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const FRAME_KINDS: FrameKind[] = [
  'hero', 'portrait', 'evidence', 'timeline', 'conflict',
  'quote', 'stat', 'place', 'conclusion', 'facts', 'connections'
]

/** Junk that is never subject photography, checked against URL and alt text. */
const JUNK =
  /(logo|icon|sprite|avatar|placeholder|default|spacer|pixel|favicon|banner|advert|1x1|blank|loading|share|subscribe|newsletter|paywall)/i

/** Words that carry no identifying weight when matching a subject. */
const STOP = new Set([
  'the', 'and', 'for', 'from', 'with', 'his', 'her', 'their', 'was', 'were',
  'inc', 'ltd', 'corp', 'company', 'group', 'city', 'state', 'university'
])

function subjectWords(subject: string): string[] {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
}

/**
 * Picks the best photograph for a subject from everything the browser saw.
 *
 * The hard rule is that at least one distinctive word of the subject must
 * appear in the image's own caption, alt text or filename. Without it a page's
 * unrelated sidebar thumbnails — Britannica happily offers "Migrant Mother"
 * beside a Legasov article — score well on size alone and end up presented as
 * a photograph of the subject. Showing the wrong face is worse than showing
 * none, so an unmatched frame goes without.
 */
function bestImage(
  pages: PageContent[],
  subject: string,
  used: Set<string>
): { image: string; credit: string; pageUrl: string; caption?: string } | null {
  const words = subjectWords(subject)
  if (words.length === 0) return null

  let best: { img: PageImage; page: PageContent; score: number } | null = null

  for (const page of pages) {
    for (const img of page.images) {
      if (used.has(img.url) || JUNK.test(img.url)) continue

      // The filename is evidence too: Wikimedia encodes the subject in it.
      let slug = ''
      try {
        slug = decodeURIComponent(new URL(img.url).pathname).toLowerCase().replace(/[^a-z0-9]+/g, ' ')
      } catch {
        slug = img.url.toLowerCase()
      }
      const caption = `${img.alt} ${img.caption}`.toLowerCase()
      const hay = `${caption} ${slug}`

      const matched = words.filter((w) => hay.includes(w)).length
      // No name, no photograph. This is the safeguard, not an optimisation.
      if (matched === 0) continue

      let score = matched * 30
      // Every word present, in the caption specifically, is near-certainty.
      if (matched === words.length) score += 25
      if (words.every((w) => caption.includes(w))) score += 20

      // Resolution actually available, not the size the page chose to show.
      const w = Math.max(img.width, img.maxWidth)
      if (w >= 1200) score += 20
      else if (w >= 800) score += 14
      else if (w >= 500) score += 7
      else if (w < 300 && !img.upgraded) score -= 12

      const ratio = img.width / Math.max(1, img.height)
      if (ratio > 0.55 && ratio < 2.2) score += 5
      if (img.caption.length > 20) score += 8
      if (/getty|reuters|ap photo|afp|photograph|epa|shutterstock|alamy/i.test(caption)) score += 10

      // The publisher's share card is branded template art far more often than
      // it is a photograph of the subject.
      if (img.url === page.ogImage) score -= 18

      if (!best || score > best.score) best = { img, page, score }
    }
  }

  // A weak best is still a guess. Require real evidence before displaying.
  if (!best || best.score < 30) return null
  used.add(best.img.url)
  return {
    // Proxied: the renderer's CSP refuses remote hosts by design.
    image: mediaUrl(best.img.url, best.page.url),
    credit: publisherOf(best.page.url),
    pageUrl: best.page.url,
    caption: best.img.caption || best.img.alt || undefined
  }
}

let inFlight = false
export function isExplaining(): boolean {
  return inFlight
}

// Warm processes, created on first use and reused thereafter.
let fast: StructuredWorker | null = null
let web: StructuredWorker | null = null

/** Starts both workers so the first real question does not pay start-up. */
export async function warmWorkers(cwd: string): Promise<void> {
  fast ??= fastWorker(cwd)
  web ??= webWorker(cwd)
  await Promise.all([fast.warm(), web.warm()])
}

/**
 * A first pass from the model's own knowledge, with no web search.
 *
 * Research takes ~45s because the search itself is the cost. That is far too
 * long to stare at a spinner, so this returns a skeleton in a few seconds —
 * real structure, real facts, but explicitly unverified — which the researched
 * version then replaces. Every frame it produces is marked `inferred` so the
 * distinction is never lost, even if the user reads it before the real one lands.
 */
const SKETCH_PROMPT = `Answer from your own knowledge. Do NOT search the web.

Return ONLY minified JSON, no prose, no fence:
{"headline":"","summary":"","kind":"person|event|organization|company|technology|place|concept",
 "facts":[{"label":"","value":""}],
 "frames":[{"kind":"hero|facts|timeline|conclusion","title":"","narration":"","subject":"",
            "facts":[{"label":"","value":""}],
            "timeline":[{"date":"","label":"","detail":""}]}]}

Exactly 3 or 4 frames: hero, facts, optionally timeline, then conclusion.
"facts" = 4 to 6 concrete specifics (dates, numbers, roles). Be precise.
"subject" on the hero must be the exact searchable name.
If you are unsure of a specific, omit it rather than guessing.`

/** Fast, unverified first paint. Never persisted. */
async function sketch(subject: string, cwd?: string): Promise<Explanation | null> {
  const started = Date.now()
  try {
    fast ??= fastWorker(cwd ?? process.cwd())
    const out = await fast.run(`${SKETCH_PROMPT}\n\n<SUBJECT>\n${subject}\n</SUBJECT>`, 45_000)
    const parsed = parseJson<Record<string, unknown>>(out)
    if (!parsed) return null

    const facts = (Array.isArray(parsed.facts) ? parsed.facts : []).map((f) => {
      const o = f as Record<string, unknown>
      return { label: String(o.label ?? ''), value: String(o.value ?? '') }
    })

    const frames: ExplainFrame[] = (Array.isArray(parsed.frames) ? parsed.frames : []).map((x) => {
      const o = x as Record<string, unknown>
      return {
        id: randomUUID(),
        kind: (FRAME_KINDS.includes(o.kind as FrameKind) ? o.kind : 'evidence') as FrameKind,
        title: String(o.title ?? ''),
        narration: String(o.narration ?? ''),
        subject: o.subject ? String(o.subject) : undefined,
        // Unverified by construction: nothing here has been checked yet.
        confidence: 'inferred',
        sources: [],
        facts: Array.isArray(o.facts)
          ? (o.facts as Record<string, unknown>[]).map((f) => ({
              label: String(f.label ?? ''),
              value: String(f.value ?? '')
            }))
          : undefined,
        timeline: Array.isArray(o.timeline)
          ? (o.timeline as Record<string, unknown>[]).map((t) => ({
              date: String(t.date ?? ''),
              label: String(t.label ?? ''),
              detail: t.detail ? String(t.detail) : undefined
            }))
          : undefined
      }
    })

    if (frames.length === 0) return null
    log(`sketch "${subject}": ${frames.length} frames in ${Date.now() - started}ms`)
    return {
      id: randomUUID(),
      subject,
      kind: String(parsed.kind ?? 'concept'),
      headline: String(parsed.headline ?? subject),
      summary: String(parsed.summary ?? ''),
      facts,
      frames,
      sources: [],
      openQuestions: [],
      relatedSubjects: [],
      at: started,
      ms: Date.now() - started,
      provisional: true
    }
  } catch {
    return null
  }
}

export interface ExplainHandlers {
  cwd?: string
  /** Stage label for the assembling screen. */
  onProgress?: (stage: string) => void
  /** The story, emitted as soon as it parses — before any imagery exists. */
  onStory?: (e: Explanation) => void
  /** Imagery patched into a frame once the browser has found it. */
  onMedia?: (frameId: string, media: NonNullable<ExplainFrame['media']>) => void
}

/**
 * Researches and assembles an explanation.
 *
 * Resolves once everything is done, but the useful output arrives earlier via
 * `onStory` — callers should render from that and let media stream in.
 */
export async function explain(subject: string, h: ExplainHandlers = {}): Promise<Explanation> {
  const started = Date.now()
  const base: Explanation = {
    id: randomUUID(),
    subject,
    kind: 'concept',
    headline: subject,
    summary: '',
    facts: [],
    frames: [],
    sources: [],
    openQuestions: [],
    relatedSubjects: [],
    at: started,
    ms: 0
  }

  if (inFlight) return { ...base, failure: 'Already assembling something.' }
  inFlight = true
  const progress = h.onProgress ?? ((): void => {})

  try {
    // Research is the long pole, so it starts first and runs while the fast
    // sketch is still being written. Awaiting the sketch before launching it
    // cost three seconds of nothing happening on every single question.
    progress('Searching sources')
    web ??= webWorker(h.cwd ?? process.cwd())
    const research = web.run(`${PROMPT}\n\n<SUBJECT>\n${subject}\n</SUBJECT>`, 180_000)
    // A rejection here is handled at the await below; this keeps Node from
    // treating it as unhandled in the window before then.
    research.catch(() => undefined)

    // Fast unverified skeleton so something real is on screen in seconds.
    progress('Recalling')
    const quick = await sketch(subject, h.cwd)
    if (quick) {
      progress('Searching sources')
      h.onStory?.(quick)
    }

    const stdout = await research

    const parsed = parseJson<Record<string, unknown>>(stdout)
    if (!parsed) {
      return { ...base, ms: Date.now() - started, failure: 'Research returned no usable structure.' }
    }

    const sources: ExplainSource[] = (Array.isArray(parsed.sources) ? parsed.sources : [])
      .map((s, i) => {
        const o = s as Record<string, unknown>
        const url = String(o.url ?? '')
        return {
          id: i,
          title: String(o.title ?? url),
          url,
          publisher: String(o.publisher ?? publisherOf(url)),
          date: o.date ? String(o.date) : undefined
        }
      })
      .filter((s) => /^https?:\/\//i.test(s.url))

    const idxs = (v: unknown): number[] =>
      Array.isArray(v)
        ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < sources.length)
        : []

    const facts = (Array.isArray(parsed.facts) ? parsed.facts : []).map((f) => {
      const o = f as Record<string, unknown>
      return { label: String(o.label ?? ''), value: String(o.value ?? '') }
    })

    const frames: ExplainFrame[] = (Array.isArray(parsed.frames) ? parsed.frames : []).map((x) => {
      const o = x as Record<string, unknown>
      return {
        id: randomUUID(),
        kind: (FRAME_KINDS.includes(o.kind as FrameKind) ? o.kind : 'evidence') as FrameKind,
        title: String(o.title ?? ''),
        narration: String(o.narration ?? ''),
        subject: o.subject ? String(o.subject) : undefined,
        subjectKind: o.subjectKind ? String(o.subjectKind) : undefined,
        role: o.role ? String(o.role) : undefined,
        confidence: conf(o.confidence),
        sources: idxs(o.sources),
        facts: Array.isArray(o.facts)
          ? (o.facts as Record<string, unknown>[]).map((f) => ({
              label: String(f.label ?? ''),
              value: String(f.value ?? '')
            }))
          : undefined,
        sides: Array.isArray(o.sides)
          ? (o.sides as Record<string, unknown>[]).map((s) => ({
              claim: String(s.claim ?? ''),
              source: Number(s.source ?? 0)
            }))
          : undefined,
        value: o.value ? String(o.value) : undefined,
        unit: o.unit ? String(o.unit) : undefined,
        quote: o.quote ? String(o.quote) : undefined,
        attribution: o.attribution ? String(o.attribution) : undefined,
        timeline: Array.isArray(o.timeline)
          ? (o.timeline as Record<string, unknown>[]).map((t) => ({
              date: String(t.date ?? ''),
              label: String(t.label ?? ''),
              detail: t.detail ? String(t.detail) : undefined
            }))
          : undefined
      }
    })

    const story: Explanation = {
      ...base,
      kind: String(parsed.kind ?? 'concept'),
      headline: String(parsed.headline ?? subject),
      summary: String(parsed.summary ?? ''),
      facts,
      frames,
      sources,
      openQuestions: (Array.isArray(parsed.openQuestions) ? parsed.openQuestions : []).map(String),
      relatedSubjects: (Array.isArray(parsed.relatedSubjects) ? parsed.relatedSubjects : []).map(String),
      ms: Date.now() - started
    }

    // The story is useful now. Everything below only enriches it.
    log(
      `explain "${subject}": ${frames.length} frames, ${facts.length} facts, ` +
        `${sources.length} sources in ${story.ms}ms (text ready)`
    )
    h.onStory?.(story)

    // ---- imagery, in parallel, from the pages the research already cited ----
    progress('Opening sources')
    const pages = await readPages(sources.slice(0, 6).map((s) => s.url), 4)
    for (const s of sources) s.reachable = pages.some((p) => p.url === s.url && !p.failure)

    const used = new Set<string>()
    // Hero first so the opening frame gets the strongest photograph available.
    const ordered = [...frames].sort((a, b) => (a.kind === 'hero' ? -1 : b.kind === 'hero' ? 1 : 0))
    const chosen: { url: string; pageUrl: string }[] = []
    for (const f of ordered) {
      if (!f.subject) continue
      const media = bestImage(pages, f.subject, used)
      if (media) {
        f.media = media
        chosen.push({ url: originalUrl(media.image), pageUrl: media.pageUrl })
        h.onMedia?.(f.id, media)
      }
    }
    // Pull the bytes now rather than when the user reaches each frame, so
    // later frames are already on disk by the time the story advances.
    void prefetch(chosen)

    // ---- correlation: what does this touch that we already knew? ----
    // Ingestion happens first so this subject's own entities are in the graph
    // before it is queried; a subject that connects only to itself is not a
    // finding, and `findConnections` excludes the subject for that reason.
    progress('Correlating')
    const ingested = ingestExplanation(story)
    const connections = findConnections(subject, 6)

    if (connections.length > 0) {
      const frame: ExplainFrame = {
        id: randomUUID(),
        kind: 'connections',
        title: 'What this touches',
        narration:
          `${connections.length} thing${connections.length === 1 ? '' : 's'} already on record ` +
          `overlap with ${subject}. Each is shown with the basis it actually rests on.`,
        // The frame asserts overlap, not relationship. Nothing here is stronger
        // than the weakest link it is built from.
        confidence: 'inferred',
        sources: [],
        connections
      }
      // Before the conclusion, so the assessment can account for it.
      const at = frames.findIndex((f) => f.kind === 'conclusion')
      if (at >= 0) frames.splice(at, 0, frame)
      else frames.push(frame)
      log(`correlate: ${connections.length} connections for "${subject}"`)
    }

    story.coverage = {
      facts: facts.length + frames.reduce((n, f) => n + (f.facts?.length ?? 0), 0),
      sources: sources.length,
      reachable: sources.filter((s) => s.reachable).length,
      images: frames.filter((f) => f.media).length,
      entities: ingested.entities
    }
    story.ms = Date.now() - started

    // Emit once more so the connections frame and provenance counts appear.
    h.onStory?.(story)

    db.prepare('INSERT INTO explanations (id, subject, at, payload) VALUES (?, ?, ?, ?)').run(
      story.id,
      subject,
      story.at,
      JSON.stringify(story)
    )
    log(
      `explain "${subject}": complete in ${story.ms}ms, ` +
        `${frames.filter((f) => f.media).length}/${frames.length} frames with imagery, ` +
        `${connections.length} connections`
    )
    return story
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('explain failed:', msg)
    return { ...base, ms: Date.now() - started, failure: msg.slice(0, 300) }
  } finally {
    inFlight = false
  }
}

export function recentExplanations(limit = 20): { id: string; subject: string; at: number }[] {
  return db
    .prepare('SELECT id, subject, at FROM explanations ORDER BY at DESC LIMIT ?')
    .all(limit) as unknown as { id: string; subject: string; at: number }[]
}

export function getExplanation(id: string): Explanation | null {
  const row = db.prepare('SELECT payload FROM explanations WHERE id = ?').get(id) as
    | { payload: string }
    | undefined
  return row ? (JSON.parse(row.payload) as Explanation) : null
}

/** Exposed for the media-selection probe; not used by the app. */
export const __pickForTest = bestImage

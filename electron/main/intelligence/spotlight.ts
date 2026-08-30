import { resolveFromWeb, type WebImage } from './webmedia.js'
import { mediaUrl } from '../media/proxy.js'
import { db } from '../store/db.js'
import { log } from '../log.js'
import type { Confidence } from '../store/graph.js'

/**
 * "Show me."
 *
 * A fundamental command: put the thing being discussed on screen. It resolves
 * what "it"/"him"/"that" refers to from the conversation, finds a real
 * attributable image, and hands the renderer a single spotlight frame.
 *
 * This exists because the conversational path has no way to display anything —
 * left to itself it will happily say "pulled it up on screen" and show nothing.
 * Display has to be a real capability, not a claim.
 */

export interface Spotlight {
  subject: string
  title: string | null
  image: string | null
  description: string | null
  extract: string | null
  credit: string | null
  sourceUrl: string | null
  confidence: Confidence
  /** Additional verified imagery from other publishers, for the media wall. */
  gallery: WebImage[]
  /** Every page consulted, so the user can check where this came from. */
  pages: { url: string; publisher: string; title: string }[]
  /** Set when nothing could be shown, so the UI can say so honestly. */
  failure?: string
}

/** Phrasings that mean "put it on screen", with the subject when named. */
const SHOW_PATTERNS: RegExp[] = [
  /^(?:jarvis[,\s]+)?show\s+(?:me\s+)?(?:a\s+|the\s+)?(?:picture|photo|image|portrait)\s+of\s+(.+)$/i,
  /^(?:jarvis[,\s]+)?show\s+me\s+(.+?)(?:'s)?\s+(?:picture|photo|image|portrait|face)$/i,
  /^(?:jarvis[,\s]+)?(?:show|pull up|bring up|display|put up)\s+(?:me\s+)?(.+)$/i,
  /^(?:jarvis[,\s]+)?what\s+(?:does|did)\s+(.+?)\s+look\s+like$/i
]

/** Pronoun-only forms: "show me his picture", "show me that". */
const ANAPHORIC =
  /^(?:jarvis[,\s]+)?(?:show|pull up|bring up|display|put up)\s*(?:me\s*)?(?:his|her|their|its|the|that|this|it)?\s*(?:picture|photo|image|portrait|face)?[.!?]?$/i

/**
 * Captures that are not a subject in themselves.
 *
 * Pronouns are the interesting case: "show me his picture" parses cleanly but
 * "his" names nobody, so it must resolve against what was just being discussed
 * rather than be searched for literally.
 */
const PRONOUN = /^(he|him|his|she|her|hers|they|them|their|it|its|that|this|the|a|an)$/i
const NOT_A_SUBJECT =
  /^(me|the picture|the photo|the image|a picture|up|on screen|screen|one)$/i

/** Nouns that refer to this machine, never to something to illustrate. */
const MACHINE_NOUN =
  /\b(test|tests|log|logs|error|errors|file|files|folder|code|terminal|build|output|screen|desktop|window|app|settings|diff|commit|branch)\b/i

/**
 * Most recently mentioned entity worth showing.
 *
 * People and events illustrate well; files and concepts do not, so they are
 * skipped rather than producing a meaningless image.
 */
function recentSubject(): string | null {
  const row = db
    .prepare(
      `SELECT name FROM entities
       WHERE kind IN ('person','event','place','organization','company','product','team')
       ORDER BY last_seen DESC LIMIT 1`
    )
    .get() as { name?: string } | undefined
  return row?.name ?? null
}

/** Returns the subject to spotlight, or null when this is not a show request. */
export function showMeSubject(text: string): string | null {
  const t = text.trim().replace(/[.!?]+$/, '')

  for (const re of SHOW_PATTERNS) {
    const m = t.match(re)
    if (!m?.[1]) continue
    const subject = m[1].trim().replace(/^(?:the|a|an)\s+/i, '')

    // Anything about this machine is a command, not something to illustrate.
    if (MACHINE_NOUN.test(subject)) return null
    if (/\b(my|this)\b/i.test(subject)) return null

    // A pronoun means "the thing we were just talking about".
    if (PRONOUN.test(subject) || NOT_A_SUBJECT.test(subject)) return recentSubject()

    if (subject.length >= 2 && subject.length <= 90) return subject
  }

  // Bare "show me" / "show me his picture" with nothing else to go on.
  if (ANAPHORIC.test(t)) return recentSubject()
  return null
}

export async function spotlight(
  subject: string,
  opts: { cwd?: string; onProgress?: (s: string) => void } = {}
): Promise<Spotlight> {
  const web = await resolveFromWeb(subject, opts)

  if (!web.hero) {
    log(`spotlight "${subject}": no usable imagery across ${web.pages.length} pages`)
    return {
      subject,
      title: web.pages[0]?.title ?? null,
      image: null,
      description: web.description,
      extract: web.extract,
      credit: null,
      sourceUrl: web.pages[0]?.url ?? null,
      confidence: 'unknown',
      gallery: [],
      pages: web.pages,
      failure:
        web.failure ??
        `Found ${web.pages.length} page(s) about ${subject} but none published a usable image.`
    }
  }

  log(`spotlight "${subject}": hero from ${web.hero.publisher}, ${web.images.length} images`)
  return {
    subject,
    title: web.hero.title ?? web.pages[0]?.title ?? null,
    image: mediaUrl(web.hero.url, web.hero.pageUrl),
    description: web.description,
    extract: web.extract,
    credit: web.hero.publisher,
    sourceUrl: web.hero.pageUrl,
    // Published by a real, checkable source, but secondary reporting.
    confidence: 'reported',
    gallery: web.images.slice(1).map((i) => ({ ...i, url: mediaUrl(i.url, i.pageUrl) })),
    pages: web.pages
  }
}

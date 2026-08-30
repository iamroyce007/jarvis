import { log } from '../log.js'

/**
 * Adult-content gate.
 *
 * JARVIS puts real photographs on screen and researches whatever it is asked
 * about, which means an ambiguous subject or a badly chosen sidebar image can
 * surface something the user did not ask for. This closes both paths: nothing
 * explicit is researched, and nothing explicit is displayed.
 *
 * The gate is closed by default and only a spoken instruction opens it — never
 * a page, a caption, a filename or a model's output. It also expires, so
 * opening it once does not leave it open for the rest of the day.
 */

/** Subjects and queries that are refused outright while the gate is closed. */
const EXPLICIT_QUERY =
  /\b(porn|pornhub|xvideos|xhamster|xnxx|redtube|youporn|onlyfans|nsfw|hentai|rule ?34|camgirl|cam girls?|escort|nudes?|nudity|naked|topless|nude|erotic|erotica|explicit sex|sex tape|sexual|xxx|hardcore|softcore|fetish|bdsm|bukkake|orgy|masturbat|blowjob|handjob|cum|creampie|milf|dildo|vibrator|strip ?(club|tease)|lingerie model|boobs?|tits?|breasts? pics?|ass pics?|butt pics?|thicc|nsfl|gore|beheading|execution video)\b/i

/** Hosts that never serve anything else. */
const EXPLICIT_HOST =
  /(^|\.)(pornhub|xvideos|xhamster|xnxx|redtube|youporn|spankbang|onlyfans|fansly|rule34|e621|nhentai|hanime|hentaihaven|erome|motherless|xxx|adultfriendfinder|chaturbate|stripchat|bongacams|myfreecams|literotica|fapello|thothub|coomer|kemono)\./i

/** Path and filename signals, for hosts that carry both kinds of material. */
const EXPLICIT_PATH =
  /(\/|[-_])(porn|nsfw|xxx|hentai|nude|nudes|naked|topless|erotic|adult|18\+|r34|rule34|lewd|ecchi|uncensored)([-_/.]|$)/i

/**
 * How long a spoken unlock lasts.
 *
 * Short on purpose. The point of the gate is that it is closed unless the user
 * has just said otherwise; a permission that outlives the conversation it was
 * given in is not really a permission any more.
 */
const UNLOCK_MS = 30 * 60 * 1000

let unlockedUntil = 0

/** Only the spoken-command path may call this. Never page or model output. */
export function unlock(minutes = 30): void {
  unlockedUntil = Date.now() + Math.min(minutes, 120) * 60 * 1000
  log(`safety: adult-content gate opened by voice for ${Math.min(minutes, 120)} minutes`)
}

export function lock(): void {
  unlockedUntil = 0
  log('safety: adult-content gate closed')
}

export function isUnlocked(): boolean {
  return Date.now() < unlockedUntil
}

export function unlockedForMs(): number {
  return Math.max(0, unlockedUntil - Date.now())
}

/**
 * Spoken phrases that open or close the gate.
 *
 * Matched against the *final* transcript only, and anchored, so a partial or a
 * passing mention cannot trip it. Returns null when the utterance is not about
 * the gate at all.
 */
export function gateCommand(text: string): 'open' | 'close' | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '')
  if (
    /^(?:jarvis[,\s]+)?(?:i (?:permit|allow|authori[sz]e) (?:adult|explicit|mature|nsfw)|(?:allow|enable|turn on|unlock) (?:adult|explicit|mature|nsfw|unfiltered)(?: content| mode| search| results)?|turn (?:off|down) (?:the )?(?:safe ?search|content filter|safety filter))$/.test(t)
  ) {
    return 'open'
  }
  if (
    /^(?:jarvis[,\s]+)?(?:(?:block|disable|turn off|lock|re-?lock) (?:adult|explicit|mature|nsfw|unfiltered)(?: content| mode| search| results)?|turn (?:on|back on) (?:the )?(?:safe ?search|content filter|safety filter)|safe ?search on)$/.test(t)
  ) {
    return 'close'
  }
  return null
}

/**
 * Whether a research subject or search query may be run.
 *
 * Refusing the *query* matters more than filtering the results: a query that
 * is never issued cannot put anything in a log, a cache, or a context window.
 */
export function queryAllowed(query: string): boolean {
  if (isUnlocked()) return true
  if (EXPLICIT_QUERY.test(query)) {
    log(`safety: refused query "${query.slice(0, 60)}" — gate closed`)
    return false
  }
  return true
}

/** Whether an image candidate may be fetched or displayed. */
export function imageAllowed(url: string, caption = '', pageUrl = ''): boolean {
  if (isUnlocked()) return true
  for (const candidate of [url, pageUrl]) {
    if (!candidate) continue
    try {
      const u = new URL(candidate)
      if (EXPLICIT_HOST.test(u.hostname)) return false
      if (EXPLICIT_PATH.test(u.pathname)) return false
    } catch {
      if (EXPLICIT_HOST.test(candidate) || EXPLICIT_PATH.test(candidate)) return false
    }
  }
  return !EXPLICIT_QUERY.test(caption)
}

/** Whether a page is worth scraping at all. */
export function pageAllowed(url: string): boolean {
  if (isUnlocked()) return true
  try {
    const u = new URL(url)
    return !EXPLICIT_HOST.test(u.hostname) && !EXPLICIT_PATH.test(u.pathname)
  } catch {
    return true
  }
}

/**
 * Appended to every research prompt while the gate is closed.
 *
 * The model does the searching, so the constraint has to reach it too —
 * filtering only the images it returns would still have run the search.
 */
export const SAFE_SEARCH_CLAUSE =
  '\n\nCONTENT RULE: Safe search is on. Do not search for, cite, quote, or return ' +
  'sexually explicit, pornographic, or gratuitously violent material, and do not ' +
  'return images from sites that host it. If the subject cannot be covered without ' +
  'such material, say so plainly and return nothing rather than working around this.'

/** The clause to append to a research prompt right now. */
export function safetyClause(): string {
  return isUnlocked() ? '' : SAFE_SEARCH_CLAUSE
}

/** What the user is told when a request is refused. */
export const REFUSAL =
  "I've got the content filter on, so I'm not going to pull that up. " +
  'Say "allow adult content" if you want it off.'

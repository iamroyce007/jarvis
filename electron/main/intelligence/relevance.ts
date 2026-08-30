import type { PageContent } from './browser.js'

/**
 * Passage-level extraction.
 *
 * The scraper keeps twelve thousand characters of readable text per page, and
 * six pages of that is roughly eighteen thousand tokens of which almost all is
 * navigation remnants, related-article teasers, cookie prose and the tail of an
 * article that stopped being about the subject four paragraphs ago.
 *
 * Feeding that to a model is both expensive and *worse*: the signal is diluted,
 * and a summary built from it drifts toward whatever the page talked about
 * most, not whatever the user asked about. So the page is split into passages
 * and only the ones that are actually about the subject survive, each carrying
 * the page it came from so any claim built on it stays attributable.
 */

export interface Passage {
  text: string
  /** Page this came from, so a claim built on it can cite it. */
  url: string
  publisher: string
  /** Position in the page: earlier passages are usually more definitional. */
  index: number
  score: number
}

/** Furniture that survives the DOM-level strip and is never worth keeping. */
const BOILERPLATE =
  /(cookie|consent|newsletter|subscribe|sign up|advertisement|share this|read more|related articles?|follow us|all rights reserved|privacy policy|terms of (use|service)|skip to (main )?content|accept all|manage preferences|©\s*\d{4})/i

/** Words too common to distinguish anything. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'as', 'is', 'was', 'were', 'are', 'be', 'been', 'it',
  'its', 'his', 'her', 'their', 'this', 'that', 'these', 'those', 'has', 'had',
  'have', 'not', 'which', 'who', 'what', 'when', 'where', 'how', 'why'
])

function terms(subject: string): string[] {
  return subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
}

/**
 * Splits page text into paragraph-sized passages.
 *
 * Paragraph boundaries, not sentences: a sentence on its own frequently loses
 * the referent ("He resigned in 1988" is useless without the paragraph naming
 * him), and a whole page is too coarse to filter.
 */
function passages(text: string): string[] {
  return text
    .split(/\n{2,}|\n(?=[A-Z])/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 80 && p.length <= 2000)
}

/**
 * Scores one passage against the subject.
 *
 * Deliberately not a bag-of-words count. Term *coverage* matters more than
 * term frequency — a paragraph mentioning both "Valery" and "Legasov" once is
 * far more likely to be about him than one saying "Chernobyl" six times — and
 * facts are what an investigation wants, so dates and numbers earn a little.
 */
function score(passage: string, want: string[]): number {
  const lower = passage.toLowerCase()
  if (BOILERPLATE.test(lower)) return 0

  const covered = want.filter((w) => lower.includes(w))
  if (covered.length === 0) return 0

  let s = (covered.length / want.length) * 100

  // A passage naming every distinguishing term is a different class of match.
  if (covered.length === want.length) s += 30

  // The full phrase, intact, is the strongest signal available.
  if (want.length > 1 && lower.includes(want.join(' '))) s += 40

  // Concrete detail: dates, years, quantities.
  if (/\b(19|20)\d{2}\b/.test(passage)) s += 8
  if (/\b\d+([.,]\d+)?\s*(%|percent|million|billion|thousand|km|kg|people|deaths?)\b/i.test(passage)) s += 6

  // Prose, not a link list. A passage with almost no sentence structure is
  // usually navigation that survived the strip.
  const sentences = (passage.match(/[.!?]\s/g) ?? []).length
  if (sentences === 0 && passage.length < 200) s -= 25

  // Very long paragraphs dilute; very short ones under-inform.
  if (passage.length > 1200) s -= 10

  return s
}

export interface Extraction {
  passages: Passage[]
  /** Characters kept out of characters considered — the compression achieved. */
  kept: number
  considered: number
  /** Pages that contributed at least one passage. */
  contributing: string[]
}

/**
 * Pulls only the relevant passages from a set of scraped pages.
 *
 * `maxChars` is a budget, not a target: if a subject genuinely has little
 * written about it, this returns little, rather than padding to fill the
 * budget with the least-bad remaining text.
 */
export function extractRelevant(
  pages: PageContent[],
  subject: string,
  opts: { maxChars?: number; minScore?: number; perPage?: number } = {}
): Extraction {
  const maxChars = opts.maxChars ?? 6_000
  const minScore = opts.minScore ?? 45
  const perPage = opts.perPage ?? 4
  const want = terms(subject)

  let considered = 0
  const all: Passage[] = []

  for (const page of pages) {
    if (page.failure || !page.text) continue
    const publisher = (() => {
      try {
        return new URL(page.url).hostname.replace(/^www\./, '')
      } catch {
        return page.url
      }
    })()

    const found: Passage[] = []
    const chunks = passages(page.text)
    for (let i = 0; i < chunks.length; i++) {
      considered += chunks[i].length
      // A subject with no distinguishing terms cannot be scored; keep the
      // opening passages, which are the ones most likely to be definitional.
      const s = want.length === 0 ? (i < 2 ? 60 : 0) : score(chunks[i], want)
      if (s < minScore) continue
      found.push({ text: chunks[i], url: page.url, publisher, index: i, score: s })
    }

    // Cap per page so one verbose source cannot crowd out every other.
    found.sort((a, b) => b.score - a.score)
    all.push(...found.slice(0, perPage))
  }

  // Interleave by score across pages, so the result draws on several sources
  // rather than exhausting the best one first.
  all.sort((a, b) => b.score - a.score)

  const out: Passage[] = []
  const seen = new Set<string>()
  let kept = 0
  for (const p of all) {
    if (kept + p.text.length > maxChars) continue
    // Syndicated copy appears verbatim on several sites.
    const fingerprint = p.text.slice(0, 120).toLowerCase()
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push(p)
    kept += p.text.length
  }

  return {
    passages: out,
    kept,
    considered,
    contributing: [...new Set(out.map((p) => p.publisher))]
  }
}

/**
 * Renders an extraction for a prompt, with sources attached.
 *
 * Attribution travels with the text rather than in a separate list, so a model
 * summarising it can cite the specific page a claim came from instead of
 * gesturing at the set.
 */
export function asContext(extraction: Extraction): string {
  if (extraction.passages.length === 0) return ''
  return extraction.passages
    .map((p) => `[${p.publisher}] ${p.text}`)
    .join('\n\n')
}

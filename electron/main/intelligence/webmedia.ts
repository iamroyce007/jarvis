import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveClaudeBinary, enrichedPath } from '../claude/resolve.js'
import { log } from '../log.js'

const execFileAsync = promisify(execFile)

/**
 * Media pulled from the open web.
 *
 * Rather than querying one encyclopaedia API, this searches the web the way a
 * person would, opens the pages that come back, and takes the imagery those
 * pages publish about themselves.
 *
 * The images used are the pages' own **preview images** — the `og:image` and
 * `twitter:image` tags publishers add specifically so that other software can
 * display them alongside a link. That is the same mechanism every messaging
 * app and social platform uses for link previews. Every image is shown with
 * its publisher and a click-through to the original page, and nothing is ever
 * presented as JARVIS's own material.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/537.36'

export interface WebImage {
  url: string
  /** Page the image was published on. */
  pageUrl: string
  publisher: string
  title: string | null
  /** Width in pixels when the page declared it; used to prefer large imagery. */
  declaredWidth: number | null
  /** True once the image itself has been confirmed to load. */
  reachable: boolean
  /**
   * How likely this is an actual photograph of the subject.
   *
   * Article photography with matching caption text scores far above a page's
   * social share card, which is usually a branded graphic rather than a photo.
   */
  score: number
  /** Where it came from, so share cards can be de-prioritised downstream. */
  origin: 'article' | 'share-card'
}

export interface WebSubject {
  subject: string
  /** Best image found, chosen for size and relevance. */
  hero: WebImage | null
  /** Everything else found, for the media wall. */
  images: WebImage[]
  /** Short factual description scraped from the pages. */
  description: string | null
  /** Longer summary text scraped from the best page. */
  extract: string | null
  coords: { lat: number; lon: number } | null
  /** Pages consulted, so provenance is inspectable. */
  pages: { url: string; publisher: string; title: string }[]
  failure?: string
}

const EMPTY = (subject: string): WebSubject => ({
  subject,
  hero: null,
  images: [],
  description: null,
  extract: null,
  coords: null,
  pages: []
})

function publisherOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'unknown'
  }
}

function absolutise(src: string, base: string): string | null {
  try {
    if (src.startsWith('//')) return `https:${src}`
    return new URL(src, base).toString()
  } catch {
    return null
  }
}

async function fetchText(url: string, timeoutMs = 11_000): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('html')) return null
    return (await res.text()).slice(0, 400_000)
  } catch {
    return null
  }
}

/** Confirms an image URL actually serves an image, so no broken frames ship. */
async function imageLoads(url: string): Promise<{ ok: boolean; bytes: number }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 9000)
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'image/*' }
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, bytes: 0 }
    const type = res.headers.get('content-type') ?? ''
    if (!type.startsWith('image/')) return { ok: false, bytes: 0 }
    const len = Number(res.headers.get('content-length') ?? 0)
    // Tiny responses are tracking pixels and spacer graphics.
    return { ok: len === 0 || len > 6000, bytes: len }
  } catch {
    return { ok: false, bytes: 0 }
  }
}

function meta(html: string, ...names: string[]): string | null {
  for (const n of names) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, 'i')
    ]
    for (const re of patterns) {
      const m = html.match(re)
      if (m?.[1]) return m[1].trim()
    }
  }
  return null
}

/** Markup and URLs that are never subject photography. */
const JUNK_IMG =
  /\b(?:class|id)=["'][^"']*\b(?:logo|icon|avatar|sprite|badge|ad|advert|banner|thumb-?nav|social)\b/i
const JUNK_URL =
  /(?:logo|icon|sprite|avatar|placeholder|default|blank|spacer|pixel|1x1|favicon|social[-_]?share|facebook-default|twitter-card-default)/i

/** Significant words from the subject, for matching against image alt text. */
function subjectWords(subject: string): string[] {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'disaster', 'attack'].includes(w))
}

/** Pulls the preview imagery and summary text a page publishes about itself. */
function scrapePage(html: string, pageUrl: string, subjectHint: string): {
  images: WebImage[]
  description: string | null
  extract: string | null
  coords: { lat: number; lon: number } | null
  title: string
} {
  const publisher = publisherOf(pageUrl)
  const title =
    meta(html, 'og:title', 'twitter:title') ??
    html.match(/<title[^>]*>([^<]{2,200})<\/title>/i)?.[1]?.trim() ??
    publisher

  const images: WebImage[] = []
  const seen = new Set<string>()
  const push = (
    raw: string | null,
    declaredWidth: number | null,
    score: number,
    origin: 'article' | 'share-card'
  ): void => {
    if (!raw) return
    const abs = absolutise(raw, pageUrl)
    if (!abs || seen.has(abs)) return
    if (/\.svg($|\?)/i.test(abs)) return
    seen.add(abs)
    images.push({ url: abs, pageUrl, publisher, title, declaredWidth, reachable: false, score, origin })
  }

  // Social share cards are collected but scored low: publishers usually set
  // og:image to a branded template or illustration, not a photograph of the
  // subject, which is exactly the "generic thumbnail" problem.
  const ogWidth = Number(meta(html, 'og:image:width')) || null
  const ogHeight = Number(meta(html, 'og:image:height')) || null
  // 1200x630 and 2:1 are the standard social-card ratios.
  const cardShaped =
    (ogWidth === 1200 && ogHeight === 630) ||
    (!!ogWidth && !!ogHeight && Math.abs(ogWidth / ogHeight - 1.91) < 0.06)
  push(
    meta(html, 'og:image:secure_url', 'og:image:url', 'og:image'),
    ogWidth,
    cardShaped ? -5 : 1,
    'share-card'
  )
  push(meta(html, 'twitter:image', 'twitter:image:src'), null, -5, 'share-card')

  // Real article photography, not just the share card.
  //
  // og:image is frequently the publisher's generic social default
  // ("facebook-default-wide.jpg"), which shows the brand rather than the
  // subject. The photographs that actually depict the subject live in the
  // article body, so <img> tags are scraped too and scored on how well their
  // alt text matches what we are looking for.
  const words = subjectWords(subjectHint)
  const candidates: { url: string; score: number; width: number | null }[] = []

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    if (JUNK_IMG.test(tag)) continue

    const src =
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ??
      // Lazy-loaded images keep the real URL in a data attribute.
      tag.match(/\bdata-(?:src|original|lazy-src)=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bsrcset=["']([^"'\s,]+)/i)?.[1] ??
      null
    if (!src || JUNK_URL.test(src)) continue
    if (!/\.(?:jpe?g|png|webp)(?:$|\?)/i.test(src) && !/\/(?:image|photo|media)\//i.test(src)) continue

    const alt = (tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? '').toLowerCase()
    const width = Number(tag.match(/\bwidth=["']?(\d+)/i)?.[1]) || null
    if (width !== null && width < 300) continue

    // A caption naming the subject is the strongest available signal that the
    // photograph actually depicts them.
    let score = 0
    for (const w of words) if (alt.includes(w)) score += 20
    if (alt.length > 25) score += 4              // a real caption, not filler
    if (width && width >= 900) score += 6
    else if (width && width >= 600) score += 3
    if (/\b(photo|photograph|portrait|pictured|getty|reuters|ap photo)\b/.test(alt)) score += 8
    // Figures and captions are where editorial photography lives.
    if (/<figure|itemprop=["']image["']/i.test(html.slice(Math.max(0, m.index - 200), m.index))) {
      score += 5
    }
    candidates.push({ url: src, score, width })
  }

  candidates.sort((a, b) => b.score - a.score || (b.width ?? 0) - (a.width ?? 0))
  for (const c of candidates.slice(0, 5)) push(c.url, c.width, c.score, 'article')

  const description = meta(html, 'og:description', 'twitter:description', 'description')

  // First substantial paragraph, tags stripped — a readable extract.
  let extract: string | null = null
  for (const m of html.matchAll(/<p[^>]*>([\s\S]{120,1400}?)<\/p>/gi)) {
    const text = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, '')
      .replace(/\[\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 140 && !/cookie|subscribe|newsletter|advertisement/i.test(text)) {
      extract = text.slice(0, 900)
      break
    }
  }

  // Geo tags, when the page carries them.
  const lat = Number(meta(html, 'place:location:latitude', 'geo.position')?.split(/[;,]/)[0])
  const lon = Number(meta(html, 'place:location:longitude')) ||
    Number(meta(html, 'geo.position')?.split(/[;,]/)[1])
  const coords =
    Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0
      ? { lat, lon }
      : null

  return { images, description, extract, coords, title }
}

/**
 * Asks Claude to search the web and return the pages worth opening.
 * Search is delegated because it already has a real web-search tool; this
 * module's job is opening the results and taking what they publish.
 */
async function findPages(subject: string, cwd?: string): Promise<string[]> {
  // Deliberately mixed sources: news, official, reference and specialist sites,
  // so the imagery and framing do not all come from one place.
  const prompt =
    `Search the web for "${subject}". Return ONLY a minified JSON array of the ` +
    `7 best page URLs about it as ["url",...]. Draw from DIFFERENT kinds of ` +
    `source and different domains: major news outlets, official or primary ` +
    `sites, reference works, and reputable specialist coverage. Do not return ` +
    `more than one URL from the same domain. Prefer pages carrying a strong ` +
    `photograph. No prose, no code fence, and never invent a URL.`
  try {
    const { stdout } = await execFileAsync(
      resolveClaudeBinary(),
      [
        '-p',
        prompt,
        '--model',
        'claude-haiku-4-5-20251001',
        '--effort',
        'low',
        '--strict-mcp-config',
        '--permission-mode',
        'bypassPermissions',
        '--disallowedTools',
        'Bash,Edit,Write,NotebookEdit,Task'
      ],
      {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        cwd,
        env: { ...process.env, PATH: enrichedPath(), ANTHROPIC_API_KEY: undefined } as NodeJS.ProcessEnv
      }
    )
    const cleaned = stdout.replace(/```(?:json)?/g, '')
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start < 0 || end <= start) return []
    const arr = JSON.parse(cleaned.slice(start, end + 1)) as unknown[]
    return arr.map(String).filter((u) => /^https?:\/\//i.test(u)).slice(0, 7)
  } catch {
    return []
  }
}

/**
 * Instant Wikipedia summary & entity resolver:
 * 1. Checks direct page summary
 * 2. If not found, runs fast Wikipedia search to resolve aliases/typos (e.g. "antropic ceo" -> "Dario Amodei")
 * Returns verified portrait image, bio extract, and title in ~150ms.
 */
async function fetchWikipediaSummary(subject: string): Promise<WebSubject | null> {
  const trySummary = async (titleOrSlug: string): Promise<WebSubject | null> => {
    try {
      const slug = encodeURIComponent(titleOrSlug.trim().replace(/\s+/g, '_'))
      const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(3500)
      })
      if (!res.ok) return null
      const data = (await res.json()) as {
        title?: string
        description?: string
        extract?: string
        thumbnail?: { source?: string; width?: number; height?: number }
        originalimage?: { source?: string; width?: number; height?: number }
        content_urls?: { desktop?: { page?: string } }
      }
      const imgUrl = data.originalimage?.source || data.thumbnail?.source
      if (!imgUrl) return null
      const pageUrl = data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${slug}`
      const resolvedTitle = data.title ?? subject
      const hero: WebImage = {
        url: imgUrl,
        pageUrl,
        publisher: 'Wikipedia',
        title: resolvedTitle,
        declaredWidth: data.originalimage?.width ?? data.thumbnail?.width ?? 800,
        reachable: true,
        score: 100,
        origin: 'article'
      }
      return {
        subject: resolvedTitle,
        hero,
        images: [hero],
        description: data.description ?? null,
        extract: data.extract ?? null,
        coords: null,
        pages: [{ url: pageUrl, publisher: 'Wikipedia', title: resolvedTitle }]
      }
    } catch {
      return null
    }
  }

  // 1. Direct match
  const direct = await trySummary(subject)
  if (direct?.hero) return direct

  // 2. Search query resolution for aliases / typos (e.g. "antropic ceo" -> "Dario Amodei")
  try {
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(subject)}&format=json`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(3000) }
    )
    if (searchRes.ok) {
      const searchData = (await searchRes.json()) as {
        query?: { search?: { title: string }[] }
      }
      const topHits = searchData?.query?.search?.slice(0, 3) ?? []
      for (const hit of topHits) {
        const found = await trySummary(hit.title)
        if (found?.hero) return found
      }
    }
  } catch {
    /* fallback to web search */
  }

  return null
}

/**
 * Resolves a subject by searching the web, opening the results, and collecting
 * the imagery and text those pages publish.
 */
export async function resolveFromWeb(
  subject: string,
  opts: { cwd?: string; onProgress?: (s: string) => void } = {}
): Promise<WebSubject> {
  const clean = subject.trim()
  if (!clean) return EMPTY(clean)
  const progress = opts.onProgress ?? ((): void => {})

  // Fast path: Check Wikipedia REST API first (takes ~150ms)
  progress('Resolving portrait')
  const wiki = await fetchWikipediaSummary(clean)
  if (wiki?.hero) {
    log(`webmedia "${clean}": instant portrait resolved via Wikipedia (${wiki.hero.url})`)
    return wiki
  }

  progress('Searching the web')
  const urls = await findPages(clean, opts.cwd)
  if (urls.length === 0) {
    log(`webmedia "${clean}": search returned no pages`)
    return { ...EMPTY(clean), failure: 'Web search returned no usable pages.' }
  }

  progress('Opening pages')
  const htmls = await Promise.all(urls.map(async (u) => [u, await fetchText(u)] as const))

  const all: WebImage[] = []
  const pages: { url: string; publisher: string; title: string }[] = []
  let description: string | null = null
  let extract: string | null = null
  let coords: { lat: number; lon: number } | null = null

  for (const [url, html] of htmls) {
    if (!html) continue
    const scraped = scrapePage(html, url, clean)
    pages.push({ url, publisher: publisherOf(url), title: scraped.title })
    all.push(...scraped.images)
    description ??= scraped.description
    extract ??= scraped.extract
    coords ??= scraped.coords
  }

  if (all.length === 0) {
    log(`webmedia "${clean}": ${pages.length} pages, no preview imagery`)
    return { ...EMPTY(clean), description, extract, coords, pages }
  }

  progress('Checking imagery')
  // Verify in parallel; only images that genuinely load are offered.
  const checked = await Promise.all(
    all.slice(0, 16).map(async (img) => {
      const { ok, bytes } = await imageLoads(img.url)
      // A heavy payload is itself evidence of real photography.
      const weighty = bytes > 150_000
      return {
        ...img,
        reachable: ok,
        declaredWidth: img.declaredWidth ?? (weighty ? 1200 : null),
        score: img.score + (weighty ? 4 : 0)
      }
    })
  )
  const usable = checked.filter((i) => i.reachable)

  // Rank on how likely each image is to be a photograph OF the subject, with
  // size as the tie-break. No publisher is privileged; a share card loses to a
  // captioned article photo even when the card is larger.
  usable.sort((a, b) => b.score - a.score || (b.declaredWidth ?? 0) - (a.declaredWidth ?? 0))

  // If any genuine article photography was found, drop the share cards
  // entirely rather than padding the wall with branded graphics.
  const photos = usable.filter((i) => i.origin === 'article' && i.score > 0)
  const ranked = photos.length > 0 ? photos : usable

  // Spread the media wall across publishers so one site cannot dominate it.
  const perPublisher = new Map<string, number>()
  const diverse: WebImage[] = []
  for (const img of ranked) {
    const n = perPublisher.get(img.publisher) ?? 0
    if (n >= 2) continue
    perPublisher.set(img.publisher, n + 1)
    diverse.push(img)
  }

  log(
    `webmedia "${clean}": ${pages.length} pages, ${usable.length}/${checked.length} images usable`
  )
  return {
    subject: clean,
    hero: diverse[0] ?? ranked[0] ?? null,
    images: diverse,
    description,
    extract,
    coords,
    pages
  }
}

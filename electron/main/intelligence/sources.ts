import { log } from '../log.js'
import { pageAllowed, queryAllowed } from './safety.js'

/**
 * Deep-web sourcing.
 *
 * "Deep web" here means what the term actually means: the large majority of the
 * public web that search engines do not index, because it lives behind a query
 * form rather than a link. Court dockets, company filings, clinical trials,
 * sanctions lists, scientific literature, government statistics. All of it is
 * public, most of it has a documented API, and none of it reliably surfaces
 * through a general web search — which is exactly why an investigation that
 * only searches the surface web keeps missing primary sources and ends up
 * citing a news article *about* a filing rather than the filing.
 *
 * This queries those databases directly, so a claim can rest on the record
 * instead of on coverage of the record.
 *
 * What this deliberately is not: Tor hidden services and dark-web markets.
 * That is a different layer with a different legal and evidentiary character,
 * and the build spec's own rules (§18 "do not scrape private material, do not
 * circumvent access controls", §36 least-privilege and auditability) rule it
 * out. Everything below is a public endpoint reached the way its publisher
 * intends, with a declared user agent and honoured rate limits.
 */

const UA = 'JARVIS/0.1 (desktop research assistant; contact: local user)'
/**
 * Per-registry timeout.
 *
 * Kept short because registries are queried in parallel and a slow one should
 * not decide how long the whole layer takes. GDELT in particular routinely
 * fails to answer, and at nine seconds it was setting the floor for every
 * single lookup.
 */
const TIMEOUT_MS = 4_500

/** Deadline for the whole layer, whatever any individual registry is doing. */
const DEADLINE_MS = 6_000

export type SourceTier =
  /** Indexed, general-purpose. What a search engine returns. */
  | 'surface'
  /** Public but unindexed: behind a query form or an API. */
  | 'deep'
  /** Primary material: the filing, the docket, the register itself. */
  | 'primary'

export interface Record_ {
  title: string
  url: string
  publisher: string
  tier: SourceTier
  /** One-line description, from the source's own metadata. Never invented. */
  snippet: string
  /** ISO date the source declares, when it declares one. */
  date: string | null
  /** Which registry this came from, for provenance display. */
  registry: string
}

interface Registry {
  id: string
  /**
   * Whether to query this registry.
   *
   * A source that cannot be reached is worse than one that is absent: it is
   * queried, waits out the deadline, and returns nothing, so it costs the full
   * timeout on every single lookup while contributing no records.
   */
  enabled?: boolean
  name: string
  /** What kind of subject this registry can say anything useful about. */
  covers: ('person' | 'company' | 'science' | 'legal' | 'event' | 'place' | 'any')[]
  publisher: string
  tier: SourceTier
  search: (q: string) => Promise<Record_[]>
}

async function getJSON<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  if (!pageAllowed(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function iso(d: unknown): string | null {
  if (!d) return null
  const t = Date.parse(String(d))
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

/** Trims a source's own abstract to a usable line without paraphrasing it. */
function line(s: unknown, max = 300): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

// ---------------------------------------------------------------------------
// Registries. Each is a public API, queried as documented.
// ---------------------------------------------------------------------------

const REGISTRIES: Registry[] = [
  {
    id: 'wikidata',
    name: 'Wikidata',
    covers: ['any'],
    publisher: 'wikidata.org',
    tier: 'deep',
    async search(q) {
      const data = await getJSON<{
        search?: { id: string; label: string; description?: string; concepturi: string }[]
      }>(
        'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en' +
          `&limit=5&search=${encodeURIComponent(q)}`
      )
      return (data?.search ?? []).map((r) => ({
        title: r.label,
        url: r.concepturi,
        publisher: 'wikidata.org',
        tier: 'deep' as const,
        snippet: line(r.description),
        date: null,
        registry: 'Wikidata'
      }))
    }
  },
  {
    id: 'crossref',
    name: 'Crossref',
    covers: ['science', 'any'],
    publisher: 'crossref.org',
    tier: 'primary',
    async search(q) {
      const data = await getJSON<{
        message?: {
          items?: {
            title?: string[]
            URL?: string
            abstract?: string
            issued?: { 'date-parts'?: number[][] }
            'container-title'?: string[]
          }[]
        }
      }>(`https://api.crossref.org/works?rows=4&select=title,URL,abstract,issued,container-title&query=${encodeURIComponent(q)}`)
      return (data?.message?.items ?? [])
        .filter((r) => r.title?.[0] && r.URL)
        .map((r) => ({
          title: line(r.title?.[0], 200),
          url: r.URL as string,
          publisher: line(r['container-title']?.[0]) || 'crossref.org',
          tier: 'primary' as const,
          snippet: line(r.abstract),
          date: r.issued?.['date-parts']?.[0]?.[0]
            ? String(r.issued['date-parts'][0][0])
            : null,
          registry: 'Crossref'
        }))
    }
  },
  {
    id: 'pubmed',
    name: 'PubMed',
    covers: ['science'],
    publisher: 'ncbi.nlm.nih.gov',
    tier: 'primary',
    async search(q) {
      const ids = await getJSON<{ esearchresult?: { idlist?: string[] } }>(
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json' +
          `&retmax=4&term=${encodeURIComponent(q)}`
      )
      const list = ids?.esearchresult?.idlist ?? []
      if (list.length === 0) return []
      const sum = await getJSON<{ result?: Record<string, { title?: string; pubdate?: string; source?: string }> }>(
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json' +
          `&id=${list.join(',')}`
      )
      const out: Record_[] = []
      for (const id of list) {
        const r = sum?.result?.[id]
        if (!r?.title) continue
        out.push({
          title: line(r.title, 220),
          url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
          publisher: line(r.source) || 'pubmed',
          tier: 'primary',
          snippet: '',
          date: iso(r.pubdate),
          registry: 'PubMed'
        })
      }
      return out
    }
  },
  {
    id: 'arxiv',
    name: 'arXiv',
    covers: ['science'],
    publisher: 'arxiv.org',
    tier: 'primary',
    async search(q) {
      // arXiv serves Atom, not JSON. Parsed narrowly rather than with a DOM.
      if (!queryAllowed(q)) return []
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const res = await fetch(
          `https://export.arxiv.org/api/query?max_results=4&search_query=all:${encodeURIComponent(q)}`,
          { signal: controller.signal, headers: { 'User-Agent': UA } }
        )
        if (!res.ok) return []
        const xml = await res.text()
        const out: Record_[] = []
        for (const entry of xml.split('<entry>').slice(1)) {
          const pick = (tag: string): string =>
            line(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? '')
          const url = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim()
          if (!url) continue
          out.push({
            title: pick('title'),
            url,
            publisher: 'arxiv.org',
            tier: 'primary',
            snippet: pick('summary').slice(0, 300),
            date: iso(entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]),
            registry: 'arXiv'
          })
        }
        return out
      } catch {
        return []
      } finally {
        clearTimeout(timer)
      }
    }
  },
  {
    id: 'edgar',
    name: 'SEC EDGAR',
    covers: ['company'],
    publisher: 'sec.gov',
    tier: 'primary',
    async search(q) {
      // EDGAR's full-text search covers filings themselves, not company pages.
      const data = await getJSON<{
        hits?: { hits?: { _source?: { display_names?: string[]; file_date?: string; form?: string }; _id?: string }[] }
      }>(
        `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${q}"`)}&forms=10-K,10-Q,8-K`,
        { Accept: 'application/json' }
      )
      return (data?.hits?.hits ?? []).slice(0, 4).map((h) => {
        const name = h._source?.display_names?.[0] ?? q
        const id = (h._id ?? '').split(':')[0].replace(/-/g, '')
        return {
          title: `${h._source?.form ?? 'Filing'} — ${line(name, 120)}`,
          url: id
            ? `https://www.sec.gov/Archives/edgar/data/${id}`
            : 'https://www.sec.gov/edgar/search/',
          publisher: 'sec.gov',
          tier: 'primary' as const,
          snippet: `${h._source?.form ?? ''} filing`.trim(),
          date: iso(h._source?.file_date),
          registry: 'SEC EDGAR'
        }
      })
    }
  },
  {
    id: 'courtlistener',
    name: 'CourtListener',
    covers: ['legal', 'person', 'company'],
    publisher: 'courtlistener.com',
    tier: 'primary',
    async search(q) {
      const data = await getJSON<{
        results?: { caseName?: string; absolute_url?: string; dateFiled?: string; court?: string; snippet?: string }[]
      }>(`https://www.courtlistener.com/api/rest/v4/search/?type=o&page_size=4&q=${encodeURIComponent(q)}`)
      return (data?.results ?? []).slice(0, 4).map((r) => ({
        title: line(r.caseName, 200) || 'Opinion',
        url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : 'https://www.courtlistener.com',
        publisher: line(r.court) || 'courtlistener.com',
        tier: 'primary' as const,
        snippet: line(r.snippet),
        date: iso(r.dateFiled),
        registry: 'CourtListener'
      }))
    }
  },
  {
    id: 'openalex',
    name: 'OpenAlex',
    covers: ['science', 'person', 'any'],
    publisher: 'openalex.org',
    tier: 'deep',
    async search(q) {
      const data = await getJSON<{
        results?: { display_name?: string; doi?: string; id?: string; publication_date?: string; host_venue?: { display_name?: string } }[]
      }>(`https://api.openalex.org/works?per-page=4&search=${encodeURIComponent(q)}`)
      return (data?.results ?? []).map((r) => ({
        title: line(r.display_name, 220),
        url: r.doi ?? r.id ?? 'https://openalex.org',
        publisher: line(r.host_venue?.display_name) || 'openalex.org',
        tier: 'deep' as const,
        snippet: '',
        date: iso(r.publication_date),
        registry: 'OpenAlex'
      }))
    }
  },
  {
    // GDELT's API refuses connections outright from some networks — including
    // this one, where every attempt is a TCP refusal rather than an HTTP error,
    // so there is nothing to retry. Left defined and switchable rather than
    // deleted, because it is a good source where it is reachable.
    id: 'gdelt',
    enabled: process.env.JARVIS_GDELT === '1',
    name: 'GDELT',
    covers: ['event', 'place', 'person', 'company'],
    publisher: 'gdeltproject.org',
    tier: 'deep',
    async search(q) {
      const data = await getJSON<{
        articles?: { title?: string; url?: string; domain?: string; seendate?: string }[]
      }>(
        'https://api.gdeltproject.org/api/v2/doc/doc?format=json&maxrecords=5&sort=hybridrel' +
          `&query=${encodeURIComponent(q)}`
      )
      return (data?.articles ?? [])
        .filter((a) => a.url && a.title)
        .map((a) => ({
          title: line(a.title, 220),
          url: a.url as string,
          publisher: line(a.domain) || 'gdelt',
          tier: 'deep' as const,
          snippet: '',
          date: a.seendate ? iso(a.seendate.replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3')) : null,
          registry: 'GDELT'
        }))
    }
  }
]

/**
 * Which registries are worth asking about this subject.
 *
 * Querying all eight for every question is slow and mostly wasted — PubMed has
 * nothing to say about a film director. The kind comes from the research pass,
 * which already declares one; when it is unknown, the general-purpose
 * registries are used and the specialist ones are skipped.
 */
function registriesFor(kind?: string): Registry[] {
  const k = (kind ?? '').toLowerCase()
  const want: string =
    /person|people|individual/.test(k) ? 'person'
    : /company|organi|corp|business/.test(k) ? 'company'
    : /science|research|paper|study|medic|disease|drug/.test(k) ? 'science'
    : /case|court|legal|law|trial/.test(k) ? 'legal'
    : /event|incident|attack|disaster|war/.test(k) ? 'event'
    : /place|city|country|region|site/.test(k) ? 'place'
    : 'any'
  return REGISTRIES.filter(
    (r) => r.enabled !== false && (r.covers.includes(want as never) || r.covers.includes('any'))
  )
}

/**
 * Whether a record is actually about the subject, or merely mentions it.
 *
 * This is the difference between a useful result and noise: a Crossref query
 * for "Nvidia" returns wind-power forecasting papers that cite a Nvidia GPU in
 * their methods section. They match the search and tell you nothing.
 *
 * The test is that the subject's distinguishing words appear in the record's
 * own title — the one field a publisher uses to say what a document is *about*.
 * Short common words are ignored, and a subject that is itself a single common
 * word falls back to accepting the match, since there is nothing to test with.
 */
function isAboutSubject(record: Record_, subject: string): boolean {
  const STOP = new Set([
    'the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to', 'for', 'is', 'was',
    'disaster', 'incident', 'attack', 'company', 'corporation', 'inc', 'ltd'
  ])
  const terms = subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
  if (terms.length === 0) return true

  const title = record.title.toLowerCase()
  const matched = terms.filter((w) => title.includes(w)).length

  // A registry that returns curated identity records — rather than documents
  // that happen to cite something — has already done this filtering itself.
  if (record.registry === 'Wikidata' || record.registry === 'SEC EDGAR') return true

  // Every distinguishing term for a one- or two-word subject; a majority for a
  // longer one, where an exact title match is unreasonably strict.
  return terms.length <= 2 ? matched === terms.length : matched >= Math.ceil(terms.length * 0.6)
}

export interface DeepSearchResult {
  records: Record_[]
  /** Registries actually reached, for the provenance strip. */
  consulted: string[]
  /** Registries that returned nothing, which is itself worth reporting. */
  silent: string[]
}

/**
 * Queries the unindexed layer for a subject.
 *
 * Every registry is asked in parallel with its own timeout, and a failure is a
 * silence rather than an error: a source being down is not a reason to fail the
 * investigation, but it *is* something the user should be able to see, which is
 * why silent registries are reported rather than swallowed.
 */
export async function deepSearch(
  subject: string,
  opts: { kind?: string; limit?: number } = {}
): Promise<DeepSearchResult> {
  if (!queryAllowed(subject)) return { records: [], consulted: [], silent: [] }

  const chosen = registriesFor(opts.kind)
  const started = Date.now()

  // A registry that has not answered by the deadline counts as silent. Waiting
  // on the slowest one meant every lookup cost whatever the worst source did
  // that day, which is not a trade an interactive assistant should make.
  const settled = await Promise.all(
    chosen.map(async (r) => {
      try {
        const records = await Promise.race([
          r.search(subject),
          new Promise<Record_[]>((resolve) => setTimeout(() => resolve([]), DEADLINE_MS))
        ])
        return { registry: r, records }
      } catch {
        return { registry: r, records: [] as Record_[] }
      }
    })
  )

  const consulted: string[] = []
  const silent: string[] = []
  const records: Record_[] = []
  for (const { registry, records: raw } of settled) {
    // Relevance is enforced here rather than at each registry so every source
    // is held to the same standard.
    const rs = raw.filter((r) => isAboutSubject(r, subject))
    if (rs.length > 0) {
      consulted.push(registry.name)
      records.push(...rs)
    } else {
      silent.push(registry.name)
    }
  }

  // Primary material outranks everything: the filing beats the article about
  // the filing. Within a tier, dated material outranks undated.
  const rank: Record<SourceTier, number> = { primary: 0, deep: 1, surface: 2 }
  records.sort((a, b) => rank[a.tier] - rank[b.tier] || (b.date ?? '').localeCompare(a.date ?? ''))

  const limit = opts.limit ?? 12
  log(
    `deep search "${subject.slice(0, 50)}": ${records.length} relevant records from ` +
      `${consulted.length}/${chosen.length} registries in ${Date.now() - started}ms`
  )
  return { records: records.slice(0, limit), consulted, silent }
}

/** The registries this build can reach, for display and for tests. */
export function registryNames(): string[] {
  return REGISTRIES.filter((r) => r.enabled !== false).map((r) => r.name)
}

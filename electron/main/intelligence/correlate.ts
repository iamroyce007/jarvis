import { db } from '../store/db.js'
import {
  upsertEntity, upsertRelation, addEvidence, addTimelineEntry,
  type EntityKind, type Confidence, type RelationKind
} from '../store/graph.js'
import { log } from '../log.js'
import type { Explanation, ExplainFrame } from './explain.js'

/**
 * Correlation.
 *
 * The graph has always been written by conversation extraction and read by
 * nothing. Every researched explanation was thrown away the moment it left the
 * screen, so the second question about a related subject started from nothing
 * and JARVIS could never say "you asked about this before, and these overlap".
 *
 * This closes that loop in both directions: explanations are written into the
 * graph as entities, relations, evidence and timeline, and the graph is asked
 * what a new subject already touches.
 *
 * The distinctions in §9 are enforced here rather than left to prose. A shared
 * organisation is not an association; an association is not a relationship.
 * The basis of every connection is recorded and carried to the surface, and
 * nothing is ever upgraded because it looks suggestive.
 */

export type Basis =
  /** Both entities are joined by a relation drawn from a cited source. */
  | 'documented'
  /** Both connect to the same third entity, each by its own documented edge. */
  | 'shared-entity'
  /** Both appear in the same source document, with no stated relationship. */
  | 'co-occurrence'
  /** Only their descriptions resemble each other. The weakest signal there is. */
  | 'similarity-only'

/** The plain-language meaning of each basis, shown verbatim to the user. */
export const BASIS_MEANING: Record<Basis, string> = {
  documented: 'A source states this relationship directly.',
  'shared-entity': 'Both are separately documented as connected to the same third party.',
  'co-occurrence': 'Both appear in the same source. No relationship is stated.',
  'similarity-only': 'Their descriptions resemble each other. This is not evidence of a link.'
}

/** What a basis is permitted to be called. Never stronger than its evidence. */
const BASIS_STRENGTH: Record<Basis, Confidence> = {
  documented: 'reported',
  'shared-entity': 'inferred',
  'co-occurrence': 'inferred',
  'similarity-only': 'unknown'
}

export interface Connection {
  /** The other end of the connection. */
  name: string
  kind: EntityKind
  basis: Basis
  /** Entities the path runs through, in order, excluding the endpoints. */
  via: string[]
  /** Human-readable statement of what is actually known. */
  statement: string
  /** Sources supporting each hop. */
  sources: string[]
  confidence: Confidence
  /** Always true. Correlation is a lead, never a finding. */
  requiresReview: true
}

// ---------------------------------------------------------------- ingestion

/** Maps an explanation's declared kind onto the graph's vocabulary. */
function entityKind(kind: string): EntityKind {
  const map: Record<string, EntityKind> = {
    person: 'person', event: 'event', organization: 'organization',
    company: 'company', technology: 'technology', place: 'place',
    concept: 'concept', product: 'product'
  }
  return map[kind] ?? 'concept'
}

/**
 * What a frame's subject is.
 *
 * The research is asked to classify its own subjects and to omit the field
 * when unsure, because inferring it from the frame kind gets it wrong in a way
 * that is hard to notice: a `portrait` frame about a power station was stored
 * as a *person*. A mislabelled entity then propagates into every connection
 * drawn through it, so an unknown kind is recorded as `other` rather than
 * guessed.
 */
function frameSubjectKind(f: ExplainFrame): EntityKind {
  const declared = (f.subjectKind ?? '').toLowerCase()
  const known: EntityKind[] = [
    'person', 'organization', 'company', 'event', 'place',
    'product', 'technology', 'concept'
  ]
  if (known.includes(declared as EntityKind)) return declared as EntityKind
  if (f.kind === 'place') return 'place'
  return 'other'
}

/** Parses the loose date strings a timeline carries into a real timestamp. */
function parseDate(s: string): number | null {
  const t = Date.parse(s)
  if (!Number.isNaN(t)) return t
  const year = /\b(1[89]\d{2}|20\d{2})\b/.exec(s)
  return year ? Date.parse(`${year[1]}-01-01`) : null
}

/**
 * Writes a researched explanation into the graph.
 *
 * Only what the explanation actually asserted is recorded, at the confidence
 * the explanation gave it. A provisional sketch is refused outright: it is the
 * model's recollection, not research, and letting it into the graph would
 * quietly launder guesses into stored facts.
 */
export function ingestExplanation(story: Explanation): { entities: number; relations: number } {
  if (story.provisional || story.failure) return { entities: 0, relations: 0 }

  const subject = upsertEntity({
    kind: entityKind(story.kind),
    name: story.subject,
    summary: story.summary || story.headline,
    confidence: 'reported',
    attributes: { facts: story.facts, lastExplained: story.at }
  })

  let entities = 1
  let relations = 0

  const sourceUrl = (i: number): string => story.sources[i]?.url ?? 'research'

  // Top-level facts are claims about the subject, each traceable to research.
  for (const f of story.facts) {
    if (!f.label || !f.value) continue
    addEvidence({
      subjectId: subject.id,
      subjectType: 'entity',
      claim: `${f.label}: ${f.value}`,
      source: story.sources[0]?.url ?? 'research',
      sourceKind: 'web',
      confidence: 'reported'
    })
  }

  for (const frame of story.frames) {
    // Each frame's own cited sources become evidence for its narration.
    for (const i of frame.sources) {
      addEvidence({
        subjectId: subject.id,
        subjectType: 'entity',
        claim: frame.title || frame.narration.slice(0, 160),
        source: sourceUrl(i),
        sourceKind: 'web',
        excerpt: frame.narration.slice(0, 400),
        confidence: frame.confidence
      })
    }

    // A frame that names somebody or somewhere introduces a real entity.
    if (frame.subject && frame.subject.toLowerCase() !== story.subject.toLowerCase()) {
      const other = upsertEntity({
        kind: frameSubjectKind(frame),
        name: frame.subject,
        summary: frame.role ?? frame.title,
        confidence: frame.confidence
      })
      entities++

      // The relation is only as strong as the frame that stated it, and it is
      // labelled with what the frame actually said rather than a guess at the
      // nature of the link.
      const kind: RelationKind =
        frame.kind === 'place' ? 'LOCATED_IN'
        : frame.kind === 'portrait' ? 'RELATED_TO'
        : 'MENTIONED_IN'
      upsertRelation({
        sourceId: subject.id,
        targetId: other.id,
        kind,
        label: frame.role ?? frame.title,
        confidence: frame.confidence
      })
      relations++

      for (const i of frame.sources) {
        addEvidence({
          subjectId: other.id,
          subjectType: 'entity',
          claim: `Appears in research on ${story.subject}: ${frame.title}`,
          source: sourceUrl(i),
          sourceKind: 'web',
          confidence: frame.confidence
        })
      }
    }

    for (const t of frame.timeline ?? []) {
      if (!t.label) continue
      addTimelineEntry({
        entityId: subject.id,
        occurredAt: parseDate(t.date) ?? undefined,
        label: t.label,
        detail: t.detail ? `${t.date} — ${t.detail}` : t.date,
        kind: 'researched',
        confidence: frame.confidence
      })
    }
  }

  log(`correlate: ingested "${story.subject}" — ${entities} entities, ${relations} relations`)
  return { entities, relations }
}

// ------------------------------------------------------------- discovery

interface Row { id: string; name: string; kind: string }

function entityByName(name: string): Row | null {
  const r = db
    .prepare('SELECT id, name, kind FROM entities WHERE name = ? COLLATE NOCASE LIMIT 1')
    .get(name) as unknown as Row | undefined
  return r ?? null
}

/** Neighbours one hop out, in either direction, with the label and confidence. */
function neighbours(id: string): (Row & { label: string | null; confidence: Confidence })[] {
  return db
    .prepare(
      `SELECT e.id, e.name, e.kind, r.label, r.confidence
         FROM relations r JOIN entities e ON e.id = r.target_id
        WHERE r.source_id = ?
        UNION
       SELECT e.id, e.name, e.kind, r.label, r.confidence
         FROM relations r JOIN entities e ON e.id = r.source_id
        WHERE r.target_id = ?`
    )
    .all(id, id) as unknown as (Row & { label: string | null; confidence: Confidence })[]
}

/** Source URLs cited for an entity, newest first. */
function sourcesFor(id: string, limit = 3): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT source FROM evidence
          WHERE subject_id = ? AND source LIKE 'http%'
          ORDER BY at DESC LIMIT ?`
      )
      .all(id, limit) as unknown as { source: string }[]
  ).map((r) => r.source)
}

/**
 * What the graph already knows that touches this subject.
 *
 * Returns leads for an investigator to check, ordered by how much evidence
 * actually stands behind them — never by how interesting they look.
 */
export function findConnections(subject: string, limit = 6): Connection[] {
  const self = entityByName(subject)
  if (!self) return []

  const out: Connection[] = []
  const seen = new Set<string>([self.id])

  // One hop: a source stated this relationship.
  const direct = neighbours(self.id)
  for (const n of direct) {
    if (seen.has(n.id)) continue
    seen.add(n.id)
    const srcs = sourcesFor(n.id)
    out.push({
      name: n.name,
      kind: n.kind as EntityKind,
      basis: 'documented',
      via: [],
      statement: n.label
        ? `${subject} — ${n.label} — ${n.name}.`
        : `${subject} and ${n.name} are connected in the cited reporting.`,
      sources: srcs,
      // A single reporting source is "reported"; the relation's own recorded
      // confidence caps it, so nothing is promoted by being re-found here.
      confidence: n.confidence === 'confirmed' ? 'corroborated' : BASIS_STRENGTH.documented,
      requiresReview: true
    })
  }

  // Two hops: both ends independently documented against the same third party.
  // This is §11 — the shortest evidence-supported narrative, stated as a lead.
  const firstHop = new Map(direct.map((d) => [d.id, d]))
  for (const mid of direct) {
    for (const far of neighbours(mid.id)) {
      if (seen.has(far.id) || firstHop.has(far.id)) continue
      seen.add(far.id)
      out.push({
        name: far.name,
        kind: far.kind as EntityKind,
        basis: 'shared-entity',
        via: [mid.name],
        statement:
          `No source documents a direct link between ${subject} and ${far.name}. ` +
          `Both appear in records concerning ${mid.name}. This is an investigative lead, ` +
          `not evidence of a relationship.`,
        sources: [...sourcesFor(mid.id, 2), ...sourcesFor(far.id, 1)],
        confidence: BASIS_STRENGTH['shared-entity'],
        requiresReview: true
      })
      if (out.length > limit * 3) break
    }
  }

  // Same source document, no stated relationship: the weakest thing worth
  // surfacing at all, and labelled as such.
  const coCited = db
    .prepare(
      `SELECT e.id, e.name, e.kind, COUNT(DISTINCT ev.source) AS shared
         FROM evidence ev
         JOIN entities e ON e.id = ev.subject_id
        WHERE ev.source IN (SELECT DISTINCT source FROM evidence WHERE subject_id = ? AND source LIKE 'http%')
          AND ev.subject_id != ?
        GROUP BY e.id
        HAVING shared >= 2
        ORDER BY shared DESC LIMIT ?`
    )
    .all(self.id, self.id, limit) as unknown as (Row & { shared: number })[]

  for (const c of coCited) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push({
      name: c.name,
      kind: c.kind as EntityKind,
      basis: 'co-occurrence',
      via: [],
      statement:
        `${subject} and ${c.name} appear in ${c.shared} of the same sources. ` +
        `No source states a relationship between them.`,
      sources: sourcesFor(c.id, 2),
      confidence: BASIS_STRENGTH['co-occurrence'],
      requiresReview: true
    })
  }

  const rank: Record<Basis, number> = {
    documented: 0, 'shared-entity': 1, 'co-occurrence': 2, 'similarity-only': 3
  }
  return out.sort((a, b) => rank[a.basis] - rank[b.basis]).slice(0, limit)
}

/**
 * How two named things connect, if they do.
 *
 * Answers §11 directly, including the case that matters most: saying that no
 * reliable connection was found, rather than manufacturing one.
 */
export function connectionPath(a: string, b: string): Connection | { none: string } {
  const from = entityByName(a)
  const to = entityByName(b)
  if (!from) return { none: `Nothing is recorded about ${a}.` }
  if (!to) return { none: `Nothing is recorded about ${b}.` }

  // Breadth-first to three hops. Beyond that a "connection" is meaningless —
  // in a graph of public figures almost everything reaches everything.
  const prev = new Map<string, { id: string; name: string; label: string | null }>()
  const seen = new Set([from.id])
  let layer = [{ id: from.id, name: from.name }]

  for (let depth = 0; depth < 3; depth++) {
    const next: { id: string; name: string }[] = []
    for (const node of layer) {
      for (const n of neighbours(node.id)) {
        if (seen.has(n.id)) continue
        seen.add(n.id)
        prev.set(n.id, { id: node.id, name: node.name, label: n.label })
        if (n.id === to.id) {
          const via: string[] = []
          let cur = n.id
          while (prev.has(cur)) {
            const p = prev.get(cur) as { id: string; name: string }
            if (p.id !== from.id) via.unshift(p.name)
            cur = p.id
          }
          const basis: Basis = via.length === 0 ? 'documented' : 'shared-entity'
          return {
            name: to.name,
            kind: to.kind as EntityKind,
            basis,
            via,
            statement:
              via.length === 0
                ? `${a} and ${b} are directly connected in the cited reporting.`
                : `${a} and ${b} have no directly documented relationship in the available ` +
                  `sources. Both appear in records concerning ${via.join(', then ')}. ` +
                  `This is a possible investigative lead, not evidence of wrongdoing.`,
            sources: [...sourcesFor(from.id, 2), ...sourcesFor(to.id, 2)],
            confidence: BASIS_STRENGTH[basis],
            requiresReview: true
          }
        }
        next.push({ id: n.id, name: n.name })
      }
    }
    if (next.length === 0) break
    layer = next
  }

  return {
    none:
      `No reliable connection found between ${a} and ${b} within three steps of the ` +
      `evidence on hand. Absence here means nothing has been recorded, not that no ` +
      `relationship exists.`
  }
}

/** Recurring entities across everything researched — §12 and §22. */
export function recurringEntities(minSubjects = 2, limit = 12): {
  name: string
  kind: string
  appearances: number
  sources: number
}[] {
  return db
    .prepare(
      `SELECT e.name, e.kind,
              (SELECT COUNT(*) FROM relations r WHERE r.source_id = e.id OR r.target_id = e.id) AS appearances,
              (SELECT COUNT(DISTINCT ev.source) FROM evidence ev WHERE ev.subject_id = e.id) AS sources
         FROM entities e
        WHERE appearances >= ?
        ORDER BY appearances DESC, sources DESC
        LIMIT ?`
    )
    .all(minSubjects, limit) as unknown as { name: string; kind: string; appearances: number; sources: number }[]
}

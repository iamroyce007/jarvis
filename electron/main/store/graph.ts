import { db } from './db.js'
import { randomUUID } from 'node:crypto'

/**
 * The World Graph: entities, the relationships between them, and the evidence
 * for both.
 *
 * Every claim carries provenance and a confidence level, because the whole
 * point is to let the user ask "why do you believe this?" and get a real
 * answer. Nothing is stored as bare fact — an assertion without a source is
 * recorded as `inferred` at best, never as `confirmed`.
 */

export type EntityKind =
  | 'person' | 'organization' | 'company' | 'event' | 'place' | 'product'
  | 'technology' | 'document' | 'file' | 'repository' | 'service' | 'device'
  | 'project' | 'task' | 'concept' | 'financial' | 'team' | 'other'

/** How much weight a claim carries. Never upgrade without new evidence. */
export type Confidence = 'confirmed' | 'corroborated' | 'reported' | 'inferred' | 'disputed' | 'unknown'

export type RelationKind =
  | 'WORKS_FOR' | 'OWNS' | 'FOUNDED' | 'INVESTED_IN' | 'COMPETES_WITH'
  | 'LOCATED_IN' | 'PARTICIPATED_IN' | 'RELATED_TO' | 'CAUSED' | 'DEPENDS_ON'
  | 'CONNECTS_TO' | 'MENTIONED_IN' | 'OCCURRED_BEFORE' | 'OCCURRED_AFTER'
  | 'AFFECTS' | 'PRODUCES' | 'USES' | 'CREATED' | 'MODIFIED' | 'REPORTED_BY'
  | 'PART_OF' | 'MEMBER_OF'

db.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    summary     TEXT,
    confidence  TEXT NOT NULL DEFAULT 'inferred',
    attributes  TEXT,            -- JSON blob of kind-specific fields
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    mentions    INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_identity ON entities(kind, name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_entities_seen ON entities(last_seen DESC);

  CREATE TABLE IF NOT EXISTS relations (
    id          TEXT PRIMARY KEY,
    source_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    label       TEXT,
    confidence  TEXT NOT NULL DEFAULT 'inferred',
    at          INTEGER NOT NULL,
    weight      INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_edge ON relations(source_id, target_id, kind);
  CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
  CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);

  -- Evidence is deliberately separate: one claim can rest on many sources, and
  -- a source can support many claims.
  CREATE TABLE IF NOT EXISTS evidence (
    id          TEXT PRIMARY KEY,
    subject_id  TEXT NOT NULL,   -- entity id or relation id
    subject_type TEXT NOT NULL,  -- 'entity' | 'relation'
    claim       TEXT NOT NULL,
    source      TEXT NOT NULL,   -- URL, file path, 'conversation', 'screen', tool name
    source_kind TEXT NOT NULL,   -- 'web' | 'file' | 'conversation' | 'screen' | 'tool' | 'user'
    excerpt     TEXT,
    confidence  TEXT NOT NULL DEFAULT 'reported',
    at          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_evidence_subject ON evidence(subject_id);

  -- Timeline events, so any entity can be walked backwards through time.
  CREATE TABLE IF NOT EXISTS timeline (
    id          TEXT PRIMARY KEY,
    entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    at          INTEGER NOT NULL,
    occurred_at INTEGER,          -- when it happened, vs when we learned it
    label       TEXT NOT NULL,
    detail      TEXT,
    kind        TEXT NOT NULL DEFAULT 'observed',
    confidence  TEXT NOT NULL DEFAULT 'reported'
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_entity ON timeline(entity_id, at DESC);
`)

export interface Entity {
  id: string
  kind: EntityKind
  name: string
  summary: string | null
  confidence: Confidence
  attributes: Record<string, unknown>
  firstSeen: number
  lastSeen: number
  mentions: number
}

export interface Relation {
  id: string
  sourceId: string
  targetId: string
  kind: RelationKind
  label: string | null
  confidence: Confidence
  at: number
  weight: number
}

export interface Evidence {
  id: string
  subjectId: string
  subjectType: 'entity' | 'relation'
  claim: string
  source: string
  sourceKind: 'web' | 'file' | 'conversation' | 'screen' | 'tool' | 'user'
  excerpt: string | null
  confidence: Confidence
  at: number
}

export interface TimelineEntry {
  id: string
  entityId: string
  at: number
  occurredAt: number | null
  label: string
  detail: string | null
  kind: string
  confidence: Confidence
}

const findEntity = db.prepare(
  `SELECT * FROM entities WHERE kind = ? AND name = ? COLLATE NOCASE`
)
const insertEntity = db.prepare(
  `INSERT INTO entities (id, kind, name, summary, confidence, attributes, first_seen, last_seen, mentions)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
)
const touchEntity = db.prepare(
  `UPDATE entities SET last_seen = ?, mentions = mentions + 1,
     summary = COALESCE(NULLIF(?, ''), summary)
   WHERE id = ?`
)

function rowToEntity(r: Record<string, unknown>): Entity {
  return {
    id: String(r.id),
    kind: r.kind as EntityKind,
    name: String(r.name),
    summary: (r.summary as string) ?? null,
    confidence: r.confidence as Confidence,
    attributes: r.attributes ? (JSON.parse(String(r.attributes)) as Record<string, unknown>) : {},
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen),
    mentions: Number(r.mentions)
  }
}

/**
 * Inserts an entity, or merges into the existing one of the same kind+name.
 * Merging rather than duplicating is what lets the graph accumulate meaning
 * across separate conversations.
 */
export function upsertEntity(input: {
  kind: EntityKind
  name: string
  summary?: string
  confidence?: Confidence
  attributes?: Record<string, unknown>
}): Entity {
  const name = input.name.trim()
  if (!name) throw new Error('entity name required')
  const now = Date.now()

  const existing = findEntity.get(input.kind, name) as Record<string, unknown> | undefined
  if (existing) {
    touchEntity.run(now, input.summary ?? '', String(existing.id))
    if (input.attributes && Object.keys(input.attributes).length > 0) {
      const merged = {
        ...(existing.attributes ? JSON.parse(String(existing.attributes)) : {}),
        ...input.attributes
      }
      db.prepare('UPDATE entities SET attributes = ? WHERE id = ?').run(
        JSON.stringify(merged),
        String(existing.id)
      )
    }
    return rowToEntity(findEntity.get(input.kind, name) as Record<string, unknown>)
  }

  const id = randomUUID()
  insertEntity.run(
    id,
    input.kind,
    name,
    input.summary ?? null,
    input.confidence ?? 'inferred',
    input.attributes ? JSON.stringify(input.attributes) : null,
    now,
    now
  )
  return rowToEntity(findEntity.get(input.kind, name) as Record<string, unknown>)
}

const insertRelation = db.prepare(
  `INSERT INTO relations (id, source_id, target_id, kind, label, confidence, at, weight)
   VALUES (?, ?, ?, ?, ?, ?, ?, 1)
   ON CONFLICT(source_id, target_id, kind)
   DO UPDATE SET weight = weight + 1, at = excluded.at,
                 label = COALESCE(excluded.label, relations.label)`
)

export function upsertRelation(input: {
  sourceId: string
  targetId: string
  kind: RelationKind
  label?: string
  confidence?: Confidence
}): void {
  if (input.sourceId === input.targetId) return
  insertRelation.run(
    randomUUID(),
    input.sourceId,
    input.targetId,
    input.kind,
    input.label ?? null,
    input.confidence ?? 'inferred',
    Date.now()
  )
}

export function addEvidence(input: {
  subjectId: string
  subjectType: 'entity' | 'relation'
  claim: string
  source: string
  sourceKind: Evidence['sourceKind']
  excerpt?: string
  confidence?: Confidence
}): void {
  db.prepare(
    `INSERT INTO evidence (id, subject_id, subject_type, claim, source, source_kind, excerpt, confidence, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    input.subjectId,
    input.subjectType,
    input.claim,
    input.source,
    input.sourceKind,
    input.excerpt ?? null,
    input.confidence ?? 'reported',
    Date.now()
  )
}

export function addTimelineEntry(input: {
  entityId: string
  label: string
  detail?: string
  occurredAt?: number
  kind?: string
  confidence?: Confidence
}): void {
  db.prepare(
    `INSERT INTO timeline (id, entity_id, at, occurred_at, label, detail, kind, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    input.entityId,
    Date.now(),
    input.occurredAt ?? null,
    input.label,
    input.detail ?? null,
    input.kind ?? 'observed',
    input.confidence ?? 'reported'
  )
}

/** The graph as the UI needs it: recent, most-connected entities and their edges. */
export function graphSnapshot(limit = 120): { entities: Entity[]; relations: Relation[] } {
  const rows = db
    .prepare(
      `SELECT e.* FROM entities e
       LEFT JOIN relations r ON r.source_id = e.id OR r.target_id = e.id
       GROUP BY e.id
       ORDER BY COUNT(r.id) DESC, e.last_seen DESC
       LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[]

  const entities = rows.map(rowToEntity)
  if (entities.length === 0) return { entities: [], relations: [] }

  const ids = entities.map((e) => e.id)
  const placeholders = ids.map(() => '?').join(',')
  const relRows = db
    .prepare(
      `SELECT * FROM relations
       WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})`
    )
    .all(...ids, ...ids) as Record<string, unknown>[]

  return {
    entities,
    relations: relRows.map((r) => ({
      id: String(r.id),
      sourceId: String(r.source_id),
      targetId: String(r.target_id),
      kind: r.kind as RelationKind,
      label: (r.label as string) ?? null,
      confidence: r.confidence as Confidence,
      at: Number(r.at),
      weight: Number(r.weight)
    }))
  }
}

/** Everything known about one entity, for the profile panel. */
export function entityProfile(id: string): {
  entity: Entity | null
  relations: (Relation & { other: Entity; direction: 'out' | 'in' })[]
  evidence: Evidence[]
  timeline: TimelineEntry[]
} {
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) return { entity: null, relations: [], evidence: [], timeline: [] }

  const edges = db
    .prepare(
      `SELECT r.*, 'out' AS direction, e.* FROM relations r
         JOIN entities e ON e.id = r.target_id WHERE r.source_id = ?
       UNION ALL
       SELECT r.*, 'in' AS direction, e.* FROM relations r
         JOIN entities e ON e.id = r.source_id WHERE r.target_id = ?`
    )
    .all(id, id) as Record<string, unknown>[]

  const relations = edges.map((r) => ({
    id: String(r.id),
    sourceId: String(r.source_id),
    targetId: String(r.target_id),
    kind: r.kind as RelationKind,
    label: (r.label as string) ?? null,
    confidence: r.confidence as Confidence,
    at: Number(r.at),
    weight: Number(r.weight),
    direction: r.direction as 'out' | 'in',
    other: rowToEntity(r)
  }))

  const evidence = (
    db.prepare('SELECT * FROM evidence WHERE subject_id = ? ORDER BY at DESC LIMIT 50').all(id) as
      Record<string, unknown>[]
  ).map((e) => ({
    id: String(e.id),
    subjectId: String(e.subject_id),
    subjectType: e.subject_type as 'entity' | 'relation',
    claim: String(e.claim),
    source: String(e.source),
    sourceKind: e.source_kind as Evidence['sourceKind'],
    excerpt: (e.excerpt as string) ?? null,
    confidence: e.confidence as Confidence,
    at: Number(e.at)
  }))

  const timeline = (
    db.prepare('SELECT * FROM timeline WHERE entity_id = ? ORDER BY COALESCE(occurred_at, at) DESC LIMIT 100')
      .all(id) as Record<string, unknown>[]
  ).map((t) => ({
    id: String(t.id),
    entityId: String(t.entity_id),
    at: Number(t.at),
    occurredAt: t.occurred_at ? Number(t.occurred_at) : null,
    label: String(t.label),
    detail: (t.detail as string) ?? null,
    kind: String(t.kind),
    confidence: t.confidence as Confidence
  }))

  return { entity: rowToEntity(row), relations, evidence, timeline }
}

export function searchEntities(q: string, limit = 20): Entity[] {
  const like = `%${q.trim()}%`
  return (
    db
      .prepare('SELECT * FROM entities WHERE name LIKE ? ORDER BY mentions DESC LIMIT ?')
      .all(like, limit) as Record<string, unknown>[]
  ).map(rowToEntity)
}

/** Powers "what changed?" — everything the graph learned in a window. */
export function changesSince(sinceMs: number): {
  newEntities: Entity[]
  newRelations: (Relation & { sourceName: string; targetName: string })[]
} {
  const cutoff = Date.now() - sinceMs
  const newEntities = (
    db.prepare('SELECT * FROM entities WHERE first_seen >= ? ORDER BY first_seen DESC').all(cutoff) as
      Record<string, unknown>[]
  ).map(rowToEntity)

  const newRelations = (
    db
      .prepare(
        `SELECT r.*, s.name AS source_name, t.name AS target_name
         FROM relations r
         JOIN entities s ON s.id = r.source_id
         JOIN entities t ON t.id = r.target_id
         WHERE r.at >= ? ORDER BY r.at DESC`
      )
      .all(cutoff) as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    sourceId: String(r.source_id),
    targetId: String(r.target_id),
    kind: r.kind as RelationKind,
    label: (r.label as string) ?? null,
    confidence: r.confidence as Confidence,
    at: Number(r.at),
    weight: Number(r.weight),
    sourceName: String(r.source_name),
    targetName: String(r.target_name)
  }))

  return { newEntities, newRelations }
}

export function graphStats(): { entities: number; relations: number; evidence: number } {
  const n = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n)
  return {
    entities: n('SELECT COUNT(*) AS n FROM entities'),
    relations: n('SELECT COUNT(*) AS n FROM relations'),
    evidence: n('SELECT COUNT(*) AS n FROM evidence')
  }
}

export function clearGraph(): void {
  db.exec('DELETE FROM evidence; DELETE FROM timeline; DELETE FROM relations; DELETE FROM entities;')
}

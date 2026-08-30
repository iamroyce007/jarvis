export type JarvisState =
  | 'IDLE'
  | 'LISTENING'
  | 'UNDERSTANDING'
  | 'THINKING'
  | 'PLANNING'
  | 'RESEARCHING'
  | 'EXECUTING'
  | 'WAITING_FOR_CONFIRMATION'
  | 'SPEAKING'
  | 'SUCCESS'
  | 'WARNING'
  | 'INTERRUPTED'
  | 'ERROR'
  | 'EMERGENCY_HALT'

export type Speaker = 'user' | 'jarvis'

export interface TranscriptEntry {
  id: string
  speaker: Speaker
  text: string
  at: number
  partial?: boolean
}

/** High-level action steps surfaced in the activity panel. Never chain-of-thought. */
export interface ActivityStep {
  id: string
  label: string
  detail?: string
  status: 'running' | 'done' | 'failed'
  at: number
}

export interface SessionInfo {
  connected: boolean
  sessionId: string | null
  model: string | null
  cwd: string
  authMethod: string | null
  subscription: string | null
  lastLatencyMs: number | null
  turns: number
  /** Tokens for the most recent turn, and the running total for this session. */
  lastUsage?: TokenUsage
  totalUsage?: TokenUsage
  /** Lifetime totals across every session, from the local database. */
  lifetimeUsage?: TokenUsage & { turns: number }
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ErrorRecord {
  id: number
  at: number
  source: string
  severity: string
  message: string
  context: string | null
  session: string | null
}

export type PermissionLevel = 'SAFE' | 'CONFIRM' | 'DANGEROUS'

export interface PendingConfirmation {
  id: string
  summary: string
  detail: string
  level: PermissionLevel
}

export type MemoryCategory =
  | 'USER_PREFERENCES'
  | 'PROJECTS'
  | 'TASKS'
  | 'IMPORTANT_CONTEXT'
  | 'CONVERSATION_SUMMARIES'

export interface MemoryRecord {
  id: number
  category: MemoryCategory
  key: string
  value: string
  createdAt: number
  updatedAt: number
}

export type TaskStatus = 'QUEUED' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export interface BackgroundTask {
  id: string
  description: string
  status: TaskStatus
  progress: string | null
  result: string | null
  createdAt: number
  completedAt: number | null
}

/** Ambient machine context injected into Claude alongside the user's words. */
export interface EnvContext {
  activeApp: string | null
  activeWindow: string | null
  cwd: string
  activeProject: string | null
  selectedText: string | null
  screenText: string | null
}

export interface VoiceConfig {
  wakeWord: string
  voice: string
  rate: number
  volume: number
  conversationTimeoutMs: number
  sttEnabled: boolean
  ttsEnabled: boolean
}

// ---------------------------------------------------------------------------
// World Graph (mirrors electron/main/store/graph.ts for the renderer)
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'person' | 'organization' | 'company' | 'event' | 'place' | 'product'
  | 'technology' | 'document' | 'file' | 'repository' | 'service' | 'device'
  | 'project' | 'task' | 'concept' | 'financial' | 'team' | 'other'

export type Confidence =
  | 'confirmed' | 'corroborated' | 'reported' | 'inferred' | 'disputed' | 'unknown'

export interface GraphEntity {
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

export interface GraphRelation {
  id: string
  sourceId: string
  targetId: string
  kind: string
  label: string | null
  confidence: Confidence
  at: number
  weight: number
}

export interface GraphEvidence {
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

export interface GraphTimelineEntry {
  id: string
  entityId: string
  at: number
  occurredAt: number | null
  label: string
  detail: string | null
  kind: string
  confidence: Confidence
}

export interface EntityProfile {
  entity: GraphEntity | null
  relations: (GraphRelation & { other: GraphEntity; direction: 'out' | 'in' })[]
  evidence: GraphEvidence[]
  timeline: GraphTimelineEntry[]
}

export interface GraphSnapshot {
  entities: GraphEntity[]
  relations: GraphRelation[]
}

export interface GraphStats {
  entities: number
  relations: number
  evidence: number
}

export interface ToolSpec {
  name: string
  category: string
  purpose: string
  risk: 'safe' | 'caution' | 'dangerous'
  available: boolean
  requiresPermission?: string
}

export interface HaltResult {
  speech: boolean
  turn: boolean
  what: string
}

export interface Capabilities {
  screenRecording: boolean
  accessibility: boolean
  automation: boolean
}

// --------------------------------------------------------------- briefings

export interface BriefingSource {
  id: number
  title: string
  url: string
  domain: string
  publisher?: string
  date?: string
  reachable?: boolean | null
  image?: string | null
}

export interface BriefingSection {
  title: string
  body: string
  confidence: Confidence
  sources: number[]
}

export interface BriefingClaim {
  statement: string
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

export type FrameKind =
  | 'hero' | 'portrait' | 'evidence' | 'timeline' | 'conflict'
  | 'quote' | 'stat' | 'place' | 'conclusion' | 'connections'

export interface FrameMedia {
  image: string | null
  credit: string | null
  sourceUrl: string | null
  description: string | null
}

export interface BriefingFrame {
  kind: FrameKind
  title: string
  narration: string
  subject?: string
  role?: string
  confidence: Confidence
  sources: number[]
  sides?: { claim: string; source: number }[]
  value?: string
  unit?: string
  quote?: string
  attribution?: string
  media?: FrameMedia
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
  frames: BriefingFrame[]
  hero?: FrameMedia
  failure?: string
}

export interface WebImage {
  url: string
  pageUrl: string
  publisher: string
  title: string | null
  declaredWidth: number | null
  reachable: boolean
  score: number
  origin: 'article' | 'share-card'
}

export interface Spotlight {
  subject: string
  title: string | null
  image: string | null
  description: string | null
  extract: string | null
  credit: string | null
  sourceUrl: string | null
  confidence: Confidence
  gallery: WebImage[]
  pages: { url: string; publisher: string; title: string }[]
  failure?: string
}

// ------------------------------------------------------------- projections

export type Likelihood = 'most likely' | 'plausible' | 'possible' | 'unlikely'

export interface Scenario {
  title: string
  outline: string
  likelihood: Likelihood
  assumptions: string[]
  triggers: string[]
  consequences: string[]
  falsifiers: string[]
}

export interface Projection {
  id: string
  subject: string
  at: number
  currentState: string
  observations: string[]
  scenarios: Scenario[]
  keyVariables: string[]
  failure?: string
}

export interface GraphChanges {
  newEntities: GraphEntity[]
  newRelations: (GraphRelation & { sourceName: string; targetName: string })[]
}

export interface IntentInfo {
  view: string
  subject: string | null
  inherited: boolean
}

// ------------------------------------------------------- fast explain path

export interface Fact {
  label: string
  value: string
}

/**
 * How a connection is actually supported. The distinction is the point: a
 * shared organisation is not an association, and an association is not a
 * relationship. Nothing displayed may claim more than its basis allows.
 */
export type Basis = 'documented' | 'shared-entity' | 'co-occurrence' | 'similarity-only'

export interface Connection {
  name: string
  kind: EntityKind
  basis: Basis
  /** Entities the path runs through, excluding the endpoints. */
  via: string[]
  statement: string
  sources: string[]
  confidence: Confidence
  /** Always true. Correlation is a lead for a person to check, never a finding. */
  requiresReview: true
}

export interface Coverage {
  facts: number
  sources: number
  reachable: number
  images: number
  entities: number
}

export interface ExplainSource {
  id: number
  title: string
  url: string
  publisher: string
  date?: string
  reachable?: boolean
}

export interface ExplainFrame {
  id: string
  kind: FrameKind | 'facts'
  title: string
  narration: string
  subject?: string
  role?: string
  confidence: Confidence
  sources: number[]
  facts?: Fact[]
  sides?: { claim: string; source: number }[]
  value?: string
  unit?: string
  quote?: string
  attribution?: string
  timeline?: { date: string; label: string; detail?: string }[]
  connections?: Connection[]
  media?: { image: string; credit: string; pageUrl: string; caption?: string }
}

export interface Explanation {
  id: string
  subject: string
  kind: string
  headline: string
  summary: string
  facts: Fact[]
  frames: ExplainFrame[]
  sources: ExplainSource[]
  openQuestions: string[]
  relatedSubjects: string[]
  at: number
  ms: number
  coverage?: Coverage
  provisional?: boolean
  failure?: string
}

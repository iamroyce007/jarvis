export type JarvisState =
  | 'IDLE'
  | 'LISTENING'
  | 'THINKING'
  | 'EXECUTING'
  | 'WAITING_FOR_CONFIRMATION'
  | 'SPEAKING'
  | 'INTERRUPTED'
  | 'ERROR'

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

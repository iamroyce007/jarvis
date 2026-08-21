import type {
  SessionInfo,
  JarvisState,
  TranscriptEntry,
  ActivityStep,
  ErrorRecord
} from '../shared/types'

interface HistoryTurn {
  id: number
  at: number
  speaker: 'user' | 'jarvis'
  text: string
  session: string | null
  source: string | null
  latencyMs: number | null
}

declare global {
  interface Window {
    jarvis: {
      getSession(): Promise<SessionInfo>
      getState(): Promise<JarvisState>
      ask(text: string): Promise<void>
      interrupt(): Promise<void>
      setConversation(on: boolean): Promise<void>
      setListening(on: boolean): Promise<void>
      setMuted(on: boolean): Promise<void>
      requestVoiceAuth(): Promise<void>
      openVoiceSettings(pane: 'SpeechRecognition' | 'Microphone' | 'Dictation'): Promise<void>
      newSession(): Promise<SessionInfo>
      setPersonality(p: string): Promise<SessionInfo>
      exportUsage(): Promise<string>
      getHistory(limit?: number): Promise<HistoryTurn[]>
      searchHistory(q: string, limit?: number): Promise<HistoryTurn[]>
      clearHistory(): Promise<void>
      exportHistory(): Promise<string>
      getErrors(limit?: number): Promise<ErrorRecord[]>
      clearErrors(): Promise<void>
      exportErrors(): Promise<string>
      onListening(cb: (on: boolean) => void): () => void
      onState(cb: (s: JarvisState) => void): () => void
      onTranscript(cb: (t: TranscriptEntry) => void): () => void
      onActivity(cb: (a: ActivityStep) => void): () => void
      onLevel(cb: (l: number) => void): () => void
      onSession(cb: (s: SessionInfo) => void): () => void
      onError(cb: (m: string) => void): () => void
      onVoiceError(cb: (m: string) => void): () => void
      onVoiceAuth(cb: (a: { ok: boolean; status: string }) => void): () => void
    }
  }
}

export {}

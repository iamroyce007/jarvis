import type {
  SessionInfo,
  JarvisState,
  TranscriptEntry,
  ActivityStep,
  ErrorRecord,
  GraphSnapshot,
  EntityProfile,
  GraphEntity,
  GraphStats,
  ToolSpec,
  HaltResult,
  Capabilities,
  Briefing,
  Spotlight,
  Projection,
  GraphChanges,
  IntentInfo,
  Explanation
} from '../shared/types'

type ExplainFrameMedia = { image: string; credit: string; pageUrl: string; caption?: string }

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

      // The phone bridge. Off unless the user opens the pairing panel.
      mobileState(): Promise<unknown>
      mobileStart(): Promise<unknown>
      mobileStop(): Promise<unknown>
      mobilePair(): Promise<unknown>
      mobileRevoke(id: string): Promise<boolean>

      // Watches (§17). Present on both surfaces; the phone reaches them over
      // the same bridge the desktop uses.
      watchAdd(subject: string): Promise<unknown>
      watchRemove(id: string): Promise<boolean>
      watchList(): Promise<{ id: string; subject: string; unread: number }[]>
      watchFindings(limit?: number): Promise<unknown[]>
      watchSeen(id?: string): Promise<void>
      onWatchDevelopment(cb: (d: unknown) => void): () => void
      setPersonality(p: string): Promise<SessionInfo>
      onIntent(cb: (i: IntentInfo) => void): () => void
      onProjection(cb: (p: Projection) => void): () => void
      onChanges(cb: (c: GraphChanges) => void): () => void
      onFocusView(cb: (v: { view: string; subject: string }) => void): () => void
      onPresent(cb: (v: boolean) => void): () => void
      project(subject: string): Promise<Projection>
      explain(subject: string): Promise<Explanation>
      recentExplanations(limit?: number): Promise<{ id: string; subject: string; at: number }[]>
      getExplanation(id: string): Promise<Explanation | null>
      onStory(cb: (s: Explanation) => void): () => void
      onStoryMedia(cb: (m: { frameId: string; media: NonNullable<ExplainFrameMedia> }) => void): () => void
      spotlight(subject: string): Promise<Spotlight>
      onSpotlight(cb: (s: Spotlight) => void): () => void
      research(subject: string): Promise<Briefing>
      recentBriefings(limit?: number): Promise<{ id: string; subject: string; kind: string; at: number }[]>
      getBriefing(id: string): Promise<Briefing | null>
      onBriefProgress(cb: (p: { subject: string; stage: string }) => void): () => void
      onBriefDone(cb: (b: Briefing) => void): () => void
      graphSnapshot(limit?: number): Promise<GraphSnapshot>
      graphProfile(id: string): Promise<EntityProfile>
      graphSearch(q: string): Promise<GraphEntity[]>
      graphChanges(sinceMs?: number): Promise<{
        newEntities: GraphEntity[]
        newRelations: (import('../shared/types').GraphRelation & {
          sourceName: string
          targetName: string
        })[]
      }>
      graphStats(): Promise<GraphStats>
      clearGraph(): Promise<void>
      onGraphUpdated(cb: (s: GraphStats & { added: unknown }) => void): () => void
      toolRegistry(): Promise<ToolSpec[]>
      halt(): Promise<HaltResult>
      onHalted(cb: (r: HaltResult) => void): () => void
      getCapabilities(): Promise<Capabilities>
      onCapabilities(cb: (c: Capabilities) => void): () => void
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

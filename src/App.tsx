import { useEffect, useRef, useState, useCallback } from 'react'
import { JarvisCore } from './components/JarvisCore'
import { WorldGraph, type Lens } from './components/WorldGraph'
import { EntityPanel } from './components/EntityPanel'
import { BriefingView } from './components/BriefingView'
import type {
  JarvisState,
  TranscriptEntry,
  ActivityStep,
  SessionInfo,
  GraphSnapshot,
  ToolSpec,
  HaltResult,
  Capabilities,
  Briefing
} from '../shared/types'

/**
 * JARVIS — intelligence operating environment.
 *
 * Three zones: the conversation on the left, the World Graph and core in the
 * centre, system state on the right. The graph is the primary surface, not a
 * decoration — everything JARVIS learns lands there and can be interrogated.
 */

const STATE_CAPTION: Partial<Record<JarvisState, string>> = {
  IDLE: 'Say “Jarvis” or type below.',
  LISTENING: 'Listening',
  UNDERSTANDING: 'Understanding the request',
  THINKING: 'Reasoning',
  PLANNING: 'Planning',
  RESEARCHING: 'Researching',
  EXECUTING: 'Executing',
  WAITING_FOR_CONFIRMATION: 'Waiting for your approval',
  SPEAKING: 'Responding',
  SUCCESS: 'Done',
  WARNING: 'Check this',
  INTERRUPTED: 'Interrupted',
  ERROR: 'Something failed',
  EMERGENCY_HALT: 'SYSTEM HALTED'
}

const LENSES: Lens[] = [
  'RELATIONSHIPS', 'PEOPLE', 'EVENTS', 'TECHNOLOGY', 'DEPENDENCIES', 'SOURCES'
]

export default function App() {
  const [state, setState] = useState<JarvisState>('IDLE')
  const [level, setLevel] = useState(0)
  const [turns, setTurns] = useState<TranscriptEntry[]>([])
  const [steps, setSteps] = useState<ActivityStep[]>([])
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const [draft, setDraft] = useState('')
  const [issues, setIssues] = useState<{ id: string; at: number; text: string }[]>([])

  const [graph, setGraph] = useState<GraphSnapshot>({ entities: [], relations: [] })
  const [focusId, setFocusId] = useState<string | null>(null)
  const [lens, setLens] = useState<Lens>('RELATIONSHIPS')
  const [tools, setTools] = useState<ToolSpec[]>([])
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [halted, setHalted] = useState<HaltResult | null>(null)
  const [view, setView] = useState<'graph' | 'tools' | 'brief'>('graph')
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [briefStage, setBriefStage] = useState<{ subject: string; stage: string } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const hasScrolledToLatest = useRef(false)

  const note = useCallback((text: string) => {
    setIssues((prev) => [...prev, { id: crypto.randomUUID(), at: Date.now(), text }].slice(-200))
  }, [])

  const refreshGraph = useCallback(() => {
    void window.jarvis.graphSnapshot(120).then(setGraph)
  }, [])

  // Restore everything that survives a restart.
  useEffect(() => {
    const api = window.jarvis
    void api.getSession().then(setSession)
    void api.getState().then(setState)
    void api.toolRegistry().then(setTools)
    void api.getCapabilities().then(setCaps)
    void api.getHistory(100).then((rows) =>
      setTurns(rows.map((r) => ({ id: `db-${r.id}`, speaker: r.speaker, text: r.text, at: r.at })))
    )
    void api.getErrors(200).then((rows) =>
      setIssues(
        rows.slice().reverse().map((r) => ({
          id: `db-${r.id}`,
          at: r.at,
          text: `${r.source}: ${r.message}`
        }))
      )
    )
    refreshGraph()

    const offs = [
      api.onListening(setListening),
      api.onState(setState),
      api.onLevel(setLevel),
      api.onSession(setSession),
      api.onCapabilities((c) => {
        setCaps(c)
        void api.toolRegistry().then(setTools)
      }),
      api.onGraphUpdated(() => refreshGraph()),
      api.onBriefProgress((p) => {
        setBriefStage(p)
        setView('brief')
      }),
      api.onBriefDone((b) => {
        setBriefing(b)
        setBriefStage(null)
        setView('brief')
        refreshGraph()
      }),
      api.onHalted((r) => {
        setHalted(r)
        window.setTimeout(() => setHalted(null), 6000)
      }),
      api.onError((m) => {
        setError(m)
        note(m)
      }),
      api.onVoiceError((m) => {
        setVoiceNotice(m)
        note(m)
      }),
      api.onVoiceAuth(({ ok, status }) => {
        setVoiceNotice(
          ok
            ? null
            : status === 'denied'
              ? 'Speech recognition is denied. Enable it in System Settings › Privacy & Security › Speech Recognition.'
              : `Speech recognition unavailable (${status}). Typed input still works.`
        )
      }),
      api.onActivity((a) =>
        setSteps((prev) => {
          const settled = prev.map((s) =>
            s.status === 'running' ? { ...s, status: 'done' as const } : s
          )
          return [...settled, a].slice(-24)
        })
      ),
      api.onTranscript((t) =>
        setTurns((prev) => {
          const last = prev[prev.length - 1]
          if (last?.partial && last.speaker === t.speaker) return [...prev.slice(0, -1), t]
          return [...prev, t]
        })
      )
    ]
    return () => offs.forEach((off) => off())
  }, [note, refreshGraph])

  // Follow the conversation, but never yank the user mid-scroll. The first
  // paint is the exception: restored history must open at the newest message.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || turns.length === 0) return
    if (!hasScrolledToLatest.current) {
      hasScrolledToLatest.current = true
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
      return
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [turns])

  useEffect(() => {
    if (state === 'IDLE' || state === 'SPEAKING') {
      setSteps((prev) => prev.map((s) => (s.status === 'running' ? { ...s, status: 'done' } : s)))
    }
  }, [state])

  const halt = useCallback(() => {
    void window.jarvis.halt().then(setHalted)
  }, [])

  // Escape is the emergency stop from anywhere in the interface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') halt()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [halt])

  const submit = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setTurns((p) => [...p, { id: crypto.randomUUID(), speaker: 'user', text, at: Date.now() }])
    await window.jarvis.ask(text)
  }, [draft])

  const toggleMic = useCallback(async () => {
    const next = !listening
    setListening(next)
    await window.jarvis.setListening(next)
    await window.jarvis.setConversation(next)
  }, [listening])

  const connected = session?.connected ?? false
  const compact = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

  const u = session?.totalUsage
  const cacheRatio = (() => {
    if (!u) return '—'
    const billed = u.input + u.cacheWrite + u.cacheRead
    return billed ? `${Math.round((u.cacheRead / billed) * 100)}%` : '—'
  })()

  return (
    <div className="app" data-state={state}>
      <header className="rail">
        <div className="brand">
          <span className="brand-mark" />
          JARVIS
        </div>

        <div className="rail-state">
          <span className="state-dot" />
          <span className="state-name">{state.replace(/_/g, ' ')}</span>
          <span className="state-caption">{STATE_CAPTION[state]}</span>
        </div>

        <div className="rail-right">
          <span className="link-status" title={session?.authMethod ?? ''}>
            {connected ? 'ONLINE' : 'CONNECTING'}
          </span>
          <button className="halt" onClick={halt} title="Emergency stop (Esc)">
            STOP
          </button>
        </div>
      </header>

      {halted ? (
        <div className="halt-banner" role="status">
          <strong>SYSTEM HALTED</strong>
          <span>Interrupted: {halted.what}</span>
        </div>
      ) : null}

      <div className="workspace">
        {/* ---------------------------------------------------- conversation */}
        <section className="holo col-conv">
          <div className="holo-head">
            <span>CONVERSATION</span>
            {turns.length ? (
              <span style={{ display: 'flex', gap: 10 }}>
                <span className="act" onClick={() => void window.jarvis.exportHistory()}>
                  export
                </span>
                <span
                  className="act"
                  onClick={() => {
                    void window.jarvis.clearHistory()
                    setTurns([])
                  }}
                >
                  clear
                </span>
              </span>
            ) : null}
          </div>

          <div className="holo-body stream" ref={scrollRef}>
            {turns.length === 0 ? (
              <div className="empty">Nothing yet. Speak, or type below.</div>
            ) : (
              turns.map((t) => (
                <div key={t.id} className={`turn ${t.speaker}`}>
                  <div className="turn-who">{t.speaker === 'user' ? 'YOU' : 'JARVIS'}</div>
                  <div className={`turn-text ${t.partial ? 'partial' : ''}`}>{t.text}</div>
                </div>
              ))
            )}
          </div>

          {voiceNotice ? (
            <div className="banner warn">
              {voiceNotice}
              <span className="act" onClick={() => void window.jarvis.openVoiceSettings('Dictation')}>
                Settings
              </span>
              <span className="act" onClick={() => void window.jarvis.requestVoiceAuth()}>
                Retry
              </span>
            </div>
          ) : null}
          {error ? (
            <div className="banner err">
              {error}
              <span className="act" onClick={() => setError(null)}>
                dismiss
              </span>
            </div>
          ) : null}

          <div className="composer">
            <button
              className={`mic ${listening ? 'live' : ''}`}
              onClick={() => void toggleMic()}
              aria-label={listening ? 'Stop listening' : 'Start listening'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
              </svg>
            </button>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submit()
                }
              }}
              placeholder="Ask JARVIS…"
              aria-label="Message JARVIS"
            />
          </div>
        </section>

        {/* ----------------------------------------------------- centre stage */}
        <section className="stage">
          <div className="stage-top">
            <div className="core-holder">
              <JarvisCore state={state} level={level} size={190} />
            </div>
          </div>

          <div className="holo stage-graph">
            <div className="holo-head">
              <div className="lenses">
                {view === 'graph' ? (
                  LENSES.map((l) => (
                    <button
                      key={l}
                      className={`lens ${lens === l ? 'on' : ''}`}
                      onClick={() => setLens(l)}
                    >
                      {l}
                    </button>
                  ))
                ) : view === 'tools' ? (
                  <span>CAPABILITIES</span>
                ) : (
                  <span>INTELLIGENCE BRIEFING</span>
                )}
              </div>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {briefing || briefStage ? (
                  <span className="act" onClick={() => setView('brief')}>
                    briefing
                  </span>
                ) : null}
                <span className="act" onClick={() => setView('graph')}>
                  graph
                </span>
                <span className="act" onClick={() => setView('tools')}>
                  tools
                </span>
                {view === 'graph' ? (
                  <span className="muted">
                    {graph.entities.length}n · {graph.relations.length}e
                  </span>
                ) : null}
              </span>
            </div>

            <div className="graph-area">
              {view === 'brief' ? (
                briefing ? (
                  <BriefingView
                    briefing={briefing}
                    stage={briefStage?.stage ?? null}
                    onClose={() => setView('graph')}
                  />
                ) : (
                  <div className="brief-loading">
                    <div className="brief-loading-subject">{briefStage?.subject}</div>
                    <div className="brief-loading-stage">{briefStage?.stage ?? 'Researching'}…</div>
                    <div className="brief-loading-note">
                      Searching sources, verifying links, building the profile.
                    </div>
                  </div>
                )
              ) : view === 'graph' ? (
                <WorldGraph
                  entities={graph.entities}
                  relations={graph.relations}
                  focusId={focusId}
                  onFocus={setFocusId}
                  lens={lens}
                />
              ) : (
                <div className="tools-grid">
                  {tools.map((t) => (
                    <div key={t.name} className={`tool ${t.available ? '' : 'off'}`}>
                      <div className="tool-top">
                        <span className="tool-name">{t.name}</span>
                        <span className={`dot risk-${t.risk}`} title={`risk: ${t.risk}`} />
                      </div>
                      <div className="tool-purpose">{t.purpose}</div>
                      <div className="tool-meta">
                        <span>{t.category}</span>
                        <span>{t.available ? 'ready' : t.requiresPermission ?? 'unavailable'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- systems */}
        <aside className="col-sys">
          {focusId ? (
            <EntityPanel entityId={focusId} onFocus={setFocusId} onClose={() => setFocusId(null)} />
          ) : (
            <>
              <section className="holo">
                <div className="holo-head">ACTIVITY</div>
                <div className="holo-body" style={{ maxHeight: 190 }}>
                  {steps.length === 0 ? (
                    <div className="empty">Idle.</div>
                  ) : (
                    steps.map((s) => (
                      <div key={s.id} className={`step ${s.status}`}>
                        <span className="mark">
                          {s.status === 'running' ? '◈' : s.status === 'failed' ? '✕' : '✓'}
                        </span>
                        <div>
                          <div className="step-label">{s.label}</div>
                          {s.detail ? <div className="step-detail">{s.detail}</div> : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="holo">
                <div className="holo-head">
                  <span>SESSION</span>
                  <span className="act" onClick={() => void window.jarvis.exportUsage()}>
                    tokens
                  </span>
                </div>
                <div className="holo-body">
                  <Row k="Model" v={session?.model ?? '—'} />
                  <Row k="Plan" v={session?.subscription ?? '—'} />
                  <Row k="Turns" v={String(session?.turns ?? 0)} />
                  <Row
                    k="Latency"
                    v={session?.lastLatencyMs ? `${(session.lastLatencyMs / 1000).toFixed(1)}s` : '—'}
                  />
                  <Row
                    k="Tokens"
                    v={u ? `${compact(u.input + u.cacheRead)} · ${compact(u.output)}` : '—'}
                  />
                  <Row k="Cache" v={cacheRatio} />
                </div>
              </section>

              <section className="holo">
                <div className="holo-head">PERMISSIONS</div>
                <div className="holo-body">
                  <Row k="Screen" v={caps?.screenRecording ? 'granted' : 'off'} />
                  <Row k="Control" v={caps?.accessibility ? 'granted' : 'off'} />
                  <Row k="Apps" v={caps?.automation ? 'granted' : 'off'} />
                </div>
              </section>

              <section className="holo" style={{ flex: 1, minHeight: 90 }}>
                <div className="holo-head">
                  <span>ISSUES{issues.length ? ` · ${issues.length}` : ''}</span>
                  {issues.length ? (
                    <span
                      className="act"
                      onClick={() => {
                        void window.jarvis.clearErrors()
                        setIssues([])
                      }}
                    >
                      clear
                    </span>
                  ) : null}
                </div>
                <div className="holo-body">
                  {issues.length === 0 ? (
                    <div className="empty">No errors.</div>
                  ) : (
                    issues
                      .slice()
                      .reverse()
                      .slice(0, 40)
                      .map((i) => (
                        <div key={i.id} className="issue">
                          <span className="issue-time">
                            {new Date(i.at).toLocaleTimeString()}
                          </span>
                          {i.text}
                        </div>
                      ))
                  )}
                </div>
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row">
      <span className="row-k">{k}</span>
      <span className="row-v">{v}</span>
    </div>
  )
}

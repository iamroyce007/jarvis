import { useEffect, useRef, useState, useCallback } from 'react'
import { Core } from './components/Core'
import type { JarvisState, TranscriptEntry, ActivityStep, SessionInfo } from '../shared/types'

const PROMPTS: Partial<Record<JarvisState, string>> = {
  IDLE: 'Say “Jarvis” to begin.',
  LISTENING: 'Listening…',
  THINKING: '',
  EXECUTING: '',
  SPEAKING: '',
  ERROR: ''
}

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

  const note = useCallback((text: string) => {
    setIssues((prev) => [...prev, { id: crypto.randomUUID(), at: Date.now(), text }].slice(-200))
  }, [])

  // Conversation history survives restarts, so the panel opens where you left off.
  useEffect(() => {
    void window.jarvis.getHistory(100).then((rows) =>
      setTurns(
        rows.map((r) => ({
          id: `db-${r.id}`,
          speaker: r.speaker,
          text: r.text,
          at: r.at
        }))
      )
    )
  }, [])

  // Errors persist in SQLite, so past sessions are still visible after a restart.
  useEffect(() => {
    void window.jarvis.getErrors(200).then((rows) =>
      setIssues(
        rows
          .slice()
          .reverse()
          .map((r) => ({ id: `db-${r.id}`, at: r.at, text: `${r.source}: ${r.message}` }))
      )
    )
  }, [])

  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const api = window.jarvis
    void api.getSession().then(setSession)
    void api.getState().then(setState)

    const offs = [
      api.onListening(setListening),
      api.onState(setState),
      api.onLevel(setLevel),
      api.onSession(setSession),
      api.onError((m) => {
        setError(m)
        note(m)
      }),
      api.onVoiceError((m) => {
        setVoiceNotice(m)
        note(m)
      }),
      api.onVoiceAuth(({ ok, status }) => {
        if (!ok) {
          setVoiceNotice(
            status === 'denied'
              ? 'Speech recognition is denied. Enable it in System Settings › Privacy & Security › Speech Recognition, then restart JARVIS.'
              : `Speech recognition unavailable (${status}). Typed input still works.`
          )
        } else {
          setVoiceNotice(null)
        }
      }),
      api.onActivity((a) =>
        setSteps((prev) => {
          // A new step implies the previous one finished.
          const settled = prev.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s))
          return [...settled, a].slice(-24)
        })
      ),
      api.onTranscript((t) =>
        setTurns((prev) => {
          // Partials replace the trailing partial rather than stacking up.
          const last = prev[prev.length - 1]
          if (t.partial) {
            if (last?.partial && last.speaker === t.speaker) return [...prev.slice(0, -1), t]
            return [...prev, t]
          }
          if (last?.partial && last.speaker === t.speaker) return [...prev.slice(0, -1), t]
          return [...prev, t]
        })
      )
    ]
    return () => offs.forEach((off) => off())
  }, [note])

  // Follow the conversation only while the user is already at the bottom;
  // yanking them back down mid-scroll makes the panel impossible to read.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 120) el.scrollTop = el.scrollHeight
  }, [turns])

  // Steps settle once JARVIS returns to rest.
  useEffect(() => {
    if (state === 'IDLE' || state === 'SPEAKING') {
      setSteps((prev) => prev.map((s) => (s.status === 'running' ? { ...s, status: 'done' } : s)))
    }
  }, [state])

  const toggleMic = useCallback(async () => {
    const next = !listening
    setListening(next)
    await window.jarvis.setListening(next)
    await window.jarvis.setConversation(next)
  }, [listening])

  const submit = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setTurns((p) => [...p, { id: crypto.randomUUID(), speaker: 'user', text, at: Date.now() }])
    await window.jarvis.ask(text)
  }, [draft])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void window.jarvis.interrupt()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const connected = session?.connected ?? false
  const busy = state === 'THINKING' || state === 'EXECUTING'

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">JARVIS</span>
        <div className="right">
          <span className="status">
            <span className={`dot ${state === 'ERROR' ? 'err' : connected ? 'on' : ''}`} />
            {connected ? 'ONLINE' : 'CONNECTING'}
          </span>
        </div>
      </header>

      <div className="workspace">
        <div className="col col-left">
          <section className="panel" style={{ flex: '0 0 auto' }}>
            <div className="panel-head">SESSION</div>
            <div className="panel-body">
              <Row k="Model" v={session?.model ?? '—'} />
              <Row k="Auth" v={session?.authMethod ?? '—'} />
              <Row k="Plan" v={session?.subscription ?? '—'} />
              <Row k="Turns" v={String(session?.turns ?? 0)} />
              <Row
                k="Latency"
                v={session?.lastLatencyMs ? `${(session.lastLatencyMs / 1000).toFixed(1)}s` : '—'}
              />
              <Row k="Session" v={session?.sessionId?.slice(0, 8) ?? '—'} />
            </div>
          </section>

          <section className="panel" style={{ flex: 1 }}>
            <div className="panel-head">
              <span>ISSUES{issues.length ? ` · ${issues.length}` : ''}</span>
              {issues.length > 0 ? (
                <span style={{ display: 'flex', gap: 10 }}>
                  <span
                    style={{ cursor: 'pointer' }}
                    title="Save a text report to your Desktop"
                    onClick={() => void window.jarvis.exportErrors()}
                  >
                    export
                  </span>
                  <span
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      void window.jarvis.clearErrors()
                      setIssues([])
                    }}
                  >
                    clear
                  </span>
                </span>
              ) : null}
            </div>
            <div className="panel-body">
              {issues.length === 0 ? (
                <div className="empty">No errors.</div>
              ) : (
                <div className="steps">
                  {issues
                    .slice()
                    .reverse()
                    .map((i) => (
                      <div key={i.id} className="step failed">
                        <div className="mark">✕</div>
                        <div>
                          <div className="detail" style={{ marginTop: 0 }}>
                            {new Date(i.at).toLocaleTimeString()} — {i.text}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="col">
          <section className="panel" style={{ flex: 1 }}>
            <div className="stage">
              <div className="core-wrap">
                <Core state={state} level={level} />
              </div>
              <div className={`state-label ${state !== 'IDLE' ? 'active' : ''}`}>{state}</div>
              {PROMPTS[state] ? <div className="prompt">{PROMPTS[state]}</div> : null}
            </div>

            {error ? (
              <div className="banner err">
                {error}
                <span
                  style={{ cursor: 'pointer', marginLeft: 8, opacity: 0.6 }}
                  onClick={() => setError(null)}
                >
                  dismiss
                </span>
              </div>
            ) : null}
            {voiceNotice ? (
              <div className="banner warn">
                {voiceNotice}
                <span
                  style={{ cursor: 'pointer', marginLeft: 8, textDecoration: 'underline' }}
                  onClick={() => void window.jarvis.openVoiceSettings('Dictation')}
                >
                  Open Settings
                </span>
                <span
                  style={{ cursor: 'pointer', marginLeft: 10, textDecoration: 'underline' }}
                  onClick={() => void window.jarvis.requestVoiceAuth()}
                >
                  Retry
                </span>
              </div>
            ) : null}

            <div className="inputbar">
              <button
                className={`mic ${listening ? 'live' : ''}`}
                onClick={() => void toggleMic()}
                title={listening ? 'Stop listening' : 'Start listening'}
                aria-label={listening ? 'Stop listening' : 'Start listening'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
                </svg>
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
                }}
                placeholder={busy ? 'Working… press Esc to interrupt' : 'Ask JARVIS anything'}
                aria-label="Message JARVIS"
              />
            </div>
          </section>
        </div>

        <div className="col">
          <section className="panel" style={{ flex: 1.3 }}>
            <div className="panel-head">
              <span>CONVERSATION</span>
              {turns.length > 0 ? (
                <span style={{ display: 'flex', gap: 10 }}>
                  <span
                    style={{ cursor: 'pointer' }}
                    title="Save the full transcript to your Desktop"
                    onClick={() => void window.jarvis.exportHistory()}
                  >
                    export
                  </span>
                  <span
                    style={{ cursor: 'pointer' }}
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
            <div className="panel-body" ref={scrollRef}>
              {turns.length === 0 ? (
                <div className="empty">Nothing yet.</div>
              ) : (
                <div className="transcript">
                  {turns.map((t) => (
                    <div key={t.id} className={`turn ${t.speaker} ${t.partial ? 'partial' : ''}`}>
                      <div className="who">{t.speaker === 'user' ? 'YOU' : 'JARVIS'}</div>
                      <div className="what">{t.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="panel" style={{ flex: 1 }}>
            <div className="panel-head">ACTIVITY</div>
            <div className="panel-body">
              {steps.length === 0 ? (
                <div className="empty">Idle.</div>
              ) : (
                <div className="steps">
                  {steps.map((s) => (
                    <div key={s.id} className={`step ${s.status}`}>
                      <div className="mark">
                        {s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : '◉'}
                      </div>
                      <div>
                        <div className="label">{s.label}</div>
                        {s.detail ? <div className="detail">{s.detail}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v" title={v}>
        {v}
      </span>
    </div>
  )
}

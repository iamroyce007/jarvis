import { useEffect, useRef, useState, useCallback } from 'react'
import { JarvisCore } from './components/JarvisCore'
import { Storyboard } from './components/Storyboard'
import { ScenarioView } from './components/ScenarioView'
import { SpotlightView } from './components/SpotlightView'
import { StoryView } from './components/StoryView'
import { PresentationMode } from './components/PresentationMode'
import type {
  JarvisState,
  TranscriptEntry,
  ActivityStep,
  SessionInfo,
  Briefing,
  Spotlight,
  Projection,
  GraphChanges,
  IntentInfo,
  Explanation
} from '../shared/types'

/**
 * JARVIS.
 *
 * There is no dashboard. At rest the environment is empty except for the core
 * and whatever was last said. When a question implies something to show, that
 * thing takes the whole stage and everything else recedes — which is the only
 * structural rule here: one primary object at a time.
 *
 * Diagnostics (tokens, permissions, errors, the entity graph) are deliberately
 * not on screen. They live behind ⌘I, because they are for debugging JARVIS,
 * not for using it.
 */

const STATE_CAPTION: Partial<Record<JarvisState, string>> = {
  IDLE: '',
  LISTENING: 'Listening',
  UNDERSTANDING: 'Understanding',
  THINKING: 'Thinking',
  PLANNING: 'Planning',
  RESEARCHING: 'Researching',
  EXECUTING: 'Working',
  WAITING_FOR_CONFIRMATION: 'Waiting for you',
  SPEAKING: '',
  SUCCESS: 'Done',
  WARNING: 'Check this',
  INTERRUPTED: 'Stopped',
  ERROR: 'Something failed',
  EMERGENCY_HALT: 'Halted'
}

type Stage =
  | { kind: 'rest' }
  | { kind: 'assembling'; subject: string; stage: string }
  | { kind: 'spotlight'; data: Spotlight }
  | { kind: 'briefing'; data: Briefing }
  | { kind: 'story'; data: Explanation }
  | { kind: 'scenario'; data: Projection }
  | { kind: 'changes'; data: GraphChanges }

export default function App() {
  const [state, setState] = useState<JarvisState>('IDLE')
  const [level, setLevel] = useState(0)
  const [turns, setTurns] = useState<TranscriptEntry[]>([])
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [intent, setIntent] = useState<IntentInfo | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'rest' })
  const [steps, setSteps] = useState<ActivityStep[]>([])
  const [diagnostics, setDiagnostics] = useState(false)
  const [presenting, setPresenting] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)

  useEffect(() => {
    const api = window.jarvis
    void api.getSession().then(setSession)
    void api.getState().then(setState)
    void api.getHistory(40).then((rows) =>
      setTurns(rows.map((r) => ({ id: `db-${r.id}`, speaker: r.speaker, text: r.text, at: r.at })))
    )

    const offs = [
      api.onState(setState),
      api.onLevel(setLevel),
      api.onSession(setSession),
      api.onIntent(setIntent),
      api.onVoiceError(setNotice),
      api.onError(setNotice),

      // Anything with something to show takes the stage.
      api.onBriefProgress((p) => setStage({ kind: 'assembling', subject: p.subject, stage: p.stage })),
      api.onSpotlight((data) => setStage({ kind: 'spotlight', data })),

      // The story arrives as text first; imagery is patched in per frame as
      // the browser finds it, so the page fills in rather than blocking.
      api.onStory((data) => setStage({ kind: 'story', data })),
      api.onStoryMedia(({ frameId, media }) =>
        setStage((prev) =>
          prev.kind === 'story'
            ? {
                kind: 'story',
                data: {
                  ...prev.data,
                  frames: prev.data.frames.map((f) => (f.id === frameId ? { ...f, media } : f))
                }
              }
            : prev
        )
      ),
      api.onBriefDone((data) => setStage({ kind: 'briefing', data })),
      api.onProjection((data) => setStage({ kind: 'scenario', data })),
      api.onChanges((data) => setStage({ kind: 'changes', data })),

      api.onActivity((a) =>
        setSteps((prev) => {
          const settled = prev.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s))
          return [...settled, a].slice(-6)
        })
      ),
      api.onTranscript((t) =>
        setTurns((prev) => {
          const last = prev[prev.length - 1]
          if (last?.partial && last.speaker === t.speaker) return [...prev.slice(0, -1), t]
          return [...prev, t].slice(-60)
        })
      )
    ]
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (!pinned.current) {
      pinned.current = true
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
      return
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 130) el.scrollTop = el.scrollHeight
  }, [turns])

  const halt = useCallback(() => {
    void window.jarvis.halt()
    setStage({ kind: 'rest' })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') halt()
      // Diagnostics are opt-in, never ambient.
      if (e.key === 'i' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setDiagnostics((d) => !d)
      }
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

  const busy = state === 'THINKING' || state === 'EXECUTING' || state === 'RESEARCHING'
  const showing = stage.kind !== 'rest'

  return (
    <div className={`app ${showing ? 'showing' : ''}`} data-state={state}>
      {/* A single hairline of chrome. Nothing competes with the stage. */}
      <header className="bar">
        <span className="mark" />
        <span className="bar-state">{STATE_CAPTION[state]}</span>
        {intent && intent.view !== 'none' && showing ? (
          <span className="bar-intent">{intent.view}</span>
        ) : null}
        <div className="bar-right">
          {showing ? (
            <button className="bar-btn" onClick={() => setStage({ kind: 'rest' })}>Clear</button>
          ) : null}
          <button className="bar-btn stop" onClick={halt}>Stop</button>
        </div>
      </header>

      <main className="stage-area">
        {stage.kind === 'rest' ? (
          <div className="rest">
            <JarvisCore state={state} level={level} size={280} />
            {turns.length === 0 ? (
              <div className="rest-hint">Ask me something.</div>
            ) : null}
          </div>
        ) : stage.kind === 'assembling' ? (
          <div className="assembling">
            <JarvisCore state="RESEARCHING" level={level} size={150} />
            <div className="assembling-subject">{stage.subject}</div>
            <div className="assembling-stage">{stage.stage}…</div>
            {steps.length ? (
              <div className="assembling-steps">
                {steps.slice(-3).map((s) => (
                  <div key={s.id} className="assembling-step">{s.label}</div>
                ))}
              </div>
            ) : null}
          </div>
        ) : stage.kind === 'spotlight' ? (
          <SpotlightView
            spotlight={stage.data}
            onClose={() => setStage({ kind: 'rest' })}
            onBrief={(s) => void window.jarvis.research(s)}
          />
        ) : stage.kind === 'story' ? (
          <>
            {presenting ? (
              <PresentationMode
                story={stage.data}
                onClose={() => setPresenting(false)}
                onInvestigate={(s) => void window.jarvis.explain(s)}
              />
            ) : (
              <StoryView
                story={stage.data}
                onClose={() => setStage({ kind: 'rest' })}
                onInvestigate={(s) => void window.jarvis.explain(s)}
                onPresent={() => setPresenting(true)}
              />
            )}
          </>
        ) : stage.kind === 'briefing' ? (
          <Storyboard
            briefing={stage.data}
            stage={null}
            onClose={() => setStage({ kind: 'rest' })}
            onInvestigate={(s) => void window.jarvis.ask(`Tell me about ${s}`)}
          />
        ) : stage.kind === 'scenario' ? (
          <ScenarioView projection={stage.data} onClose={() => setStage({ kind: 'rest' })} />
        ) : (
          <ChangesView changes={stage.data} onClose={() => setStage({ kind: 'rest' })} />
        )}
      </main>

      {/* The conversation is a quiet strip, not a chat window. */}
      <footer className="talk">
        <div className="talk-stream" ref={scrollRef}>
          {turns.slice(-8).map((t) => (
            <span key={t.id} className={`said ${t.speaker} ${t.partial ? 'partial' : ''}`}>
              {t.text}
            </span>
          ))}
        </div>

        {/* Voice state indicator */}
        {(state === 'LISTENING' || state === 'UNDERSTANDING' || state === 'THINKING' || state === 'EXECUTING') ? (
          <div className="voice-state">
            <span className="voice-state-dot" />
            <span className="voice-state-label">{STATE_CAPTION[state]}</span>
          </div>
        ) : null}

        {notice ? (
          <div className="talk-notice" onClick={() => setNotice(null)}>{notice}</div>
        ) : null}

        <div className="talk-input">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder={busy ? '' : 'Ask JARVIS'}
            aria-label="Message JARVIS"
          />
        </div>
      </footer>

      {diagnostics ? <Diagnostics session={session} onClose={() => setDiagnostics(false)} /> : null}
    </div>
  )
}

function ChangesView({ changes, onClose }: { changes: GraphChanges; onClose: () => void }) {
  const nothing = changes.newEntities.length === 0 && changes.newRelations.length === 0
  return (
    <div className="ch">
      <div className="ch-top">
        <div>
          <div className="ch-eyebrow">What changed</div>
          <h2 className="ch-title">Last 24 hours</h2>
        </div>
        <button className="sb-btn ghost" onClick={onClose}>Close</button>
      </div>
      {nothing ? (
        <div className="empty">Nothing new since yesterday.</div>
      ) : (
        <>
          {changes.newEntities.length ? (
            <section>
              <div className="ch-label">New — {changes.newEntities.length}</div>
              {changes.newEntities.map((e) => (
                <div key={e.id} className="ch-row">
                  <span className="ch-kind">{e.kind}</span>
                  <span className="ch-name">{e.name}</span>
                  <span className={`conf conf-${e.confidence}`}>{e.confidence}</span>
                </div>
              ))}
            </section>
          ) : null}
          {changes.newRelations.length ? (
            <section>
              <div className="ch-label">New connections — {changes.newRelations.length}</div>
              {changes.newRelations.map((r) => (
                <div key={r.id} className="ch-row">
                  <span className="ch-name">{r.sourceName}</span>
                  <span className="ch-rel">{r.kind.replace(/_/g, ' ')}</span>
                  <span className="ch-name">{r.targetName}</span>
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}

/** Everything that is about JARVIS rather than about the answer. ⌘I. */
function Diagnostics({
  session,
  onClose
}: {
  session: SessionInfo | null
  onClose: () => void
}) {
  const [errors, setErrors] = useState<{ id: number; at: number; source: string; message: string }[]>([])
  useEffect(() => {
    void window.jarvis.getErrors(30).then(setErrors)
  }, [])

  const u = session?.totalUsage
  const compact = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

  return (
    <div className="diag" onClick={onClose}>
      <div className="diag-panel" onClick={(e) => e.stopPropagation()}>
        <div className="diag-head">
          Diagnostics
          <span className="diag-hint">⌘I to close</span>
        </div>
        <div className="diag-rows">
          <D k="Connection" v={session?.connected ? 'online' : 'offline'} />
          <D k="Model" v={session?.model ?? '—'} />
          <D k="Plan" v={session?.subscription ?? '—'} />
          <D k="Turns" v={String(session?.turns ?? 0)} />
          <D k="Latency" v={session?.lastLatencyMs ? `${(session.lastLatencyMs / 1000).toFixed(1)}s` : '—'} />
          <D k="Tokens" v={u ? `${compact(u.input + u.cacheRead)} in · ${compact(u.output)} out` : '—'} />
        </div>
        <div className="diag-head">Recent errors</div>
        <div className="diag-errors">
          {errors.length === 0 ? (
            <div className="empty">None.</div>
          ) : (
            errors.slice(0, 12).map((e) => (
              <div key={e.id} className="diag-error">
                <span>{new Date(e.at).toLocaleTimeString()}</span> {e.source}: {e.message}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function D({ k, v }: { k: string; v: string }) {
  return (
    <div className="diag-row">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  )
}

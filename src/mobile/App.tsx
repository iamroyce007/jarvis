import { useCallback, useEffect, useRef, useState } from 'react'
import type { Explanation, JarvisState } from '../../shared/types'
import { pair, isPaired, onConnection, type Connection } from './transport'
import { PhoneVoice, speak, shutUp, speechSupported } from './voice'
import MobileStoryboard from './Storyboard'

/**
 * JARVIS, on the phone.
 *
 * The Mac is the brain: it researches, scrapes, runs the models and owns the
 * database. This is a window onto it — presentation, voice, and touch. Every
 * event the desktop emits arrives here on the same channel at the same moment,
 * so the two screens are never showing different truths and there is nothing
 * to synchronise.
 */

type Stage =
  | { kind: 'home' }
  | { kind: 'story'; data: Explanation }

interface Recent {
  id: string
  subject: string
  at: number
  image?: string
}

export default function App(): JSX.Element {
  const [paired, setPaired] = useState(isPaired())
  const [conn, setConn] = useState<Connection>({ status: 'unpaired', deviceName: null })
  const [stage, setStage] = useState<Stage>({ kind: 'home' })
  const [state, setState] = useState<JarvisState>('IDLE')
  const [partial, setPartial] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [recent, setRecent] = useState<Recent[]>([])
  const [halted, setHalted] = useState(false)
  const [listening, setListening] = useState(false)
  const [text, setText] = useState('')

  const voice = useRef<PhoneVoice | null>(null)

  useEffect(() => onConnection(setConn), [])

  // ---- the shared event stream ------------------------------------------
  useEffect(() => {
    if (!paired) return
    const api = window.jarvis
    void api.getState?.().then(setState).catch(() => undefined)
    void loadRecent()

    const off = [
      api.onState?.(setState),
      api.onStory?.((s: unknown) => {
        const story = s as Explanation
        setProgress(null)
        setStage({ kind: 'story', data: story })
      }),
      api.onStoryMedia?.(({ frameId, media }: { frameId: string; media: unknown }) => {
        // Imagery streams in after the story, so frames fill as it arrives.
        setStage((cur) => {
          if (cur.kind !== 'story') return cur
          return {
            kind: 'story',
            data: {
              ...cur.data,
              frames: cur.data.frames.map((f) =>
                f.id === frameId ? { ...f, media: media as typeof f.media } : f
              )
            }
          }
        })
      }),
      api.onBriefProgress?.((p: unknown) => setProgress((p as { stage: string }).stage)),
      api.onTranscript?.((t: unknown) => {
        const e = t as { speaker: string; text: string; partial?: boolean }
        // JARVIS speaking: say it here too, because the user is holding this,
        // not sitting at the Mac.
        if (e.speaker === 'jarvis' && !e.partial) speak(e.text)
      }),
      api.onHalted?.(() => {
        shutUp()
        voice.current?.abort()
        setHalted(true)
        setTimeout(() => setHalted(false), 2200)
      }),
      api.onError?.((m: unknown) => setNotice(String(m))),
      api.onVoiceError?.((m: unknown) => setNotice(String(m)))
    ]
    return () => off.forEach((f) => typeof f === 'function' && f())
  }, [paired])

  async function loadRecent(): Promise<void> {
    try {
      const rows = (await window.jarvis.recentExplanations?.(12)) as
        | { id: string; subject: string; at: number }[]
        | undefined
      setRecent(rows ?? [])
    } catch {
      /* the desktop may still be starting */
    }
  }

  // ---- asking -----------------------------------------------------------
  const ask = useCallback(async (utterance: string) => {
    const clean = utterance.trim()
    if (!clean) return
    setText('')
    setPartial('')
    setProgress('Thinking')
    try {
      await window.jarvis.ask(clean)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not reach the workstation')
      setProgress(null)
    }
  }, [])

  // ---- voice ------------------------------------------------------------
  const toggleVoice = useCallback(() => {
    if (!voice.current) {
      const v = new PhoneVoice()
      v.on = {
        onPartial: setPartial,
        onFinal: (t) => {
          setPartial('')
          void ask(t)
        },
        onStart: () => setListening(true),
        onEnd: () => setListening(false),
        onError: (m) => {
          setListening(false)
          setNotice(m)
        }
      }
      voice.current = v
    }
    if (listening) voice.current.stop()
    else {
      // Barge-in: talking over JARVIS always wins, here as on the desktop.
      shutUp()
      voice.current.start()
    }
  }, [listening, ask])

  // ---- §23 emergency stop ------------------------------------------------
  const stop = useCallback(async () => {
    shutUp()
    voice.current?.abort()
    setListening(false)
    setHalted(true)
    try {
      await window.jarvis.halt()
    } catch {
      /* the local half has already stopped */
    }
    setTimeout(() => setHalted(false), 2200)
  }, [])

  if (!paired) return <Pairing onPaired={() => setPaired(true)} />

  const busy = state === 'THINKING' || state === 'EXECUTING' || progress !== null

  return (
    <div className="m-root">
      <div className="m-ambient" />

      <div className="m-rail">
        <div className="m-mark">
          J<b>A</b>RVIS
        </div>
        <div className="m-rail-right">
          <div className="m-link">
            <span className={`m-dot ${conn.status}`} />
            {conn.status === 'live' ? 'Workstation' : conn.status}
          </div>
          <button
            className={`m-stop ${busy ? 'armed' : ''}`}
            onClick={() => void stop()}
            aria-label="Stop everything"
          >
            STOP
          </button>
        </div>
      </div>

      <div className="m-stage">
        {stage.kind === 'story' ? (
          <MobileStoryboard
            story={stage.data}
            onAsk={ask}
            onClose={() => {
              setStage({ kind: 'home' })
              void loadRecent()
            }}
            onNarrate={speak}
          />
        ) : (
          <div className="m-home">
            <Core state={state} busy={busy} listening={listening} />
            <div className="m-prompt">
              {partial || progress || 'What shall we investigate?'}
            </div>
            <form
              className="m-ask"
              onSubmit={(e) => {
                e.preventDefault()
                void ask(text)
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Ask JARVIS…"
                enterKeyHint="send"
                autoComplete="off"
                autoCorrect="off"
              />
              <button
                type="button"
                className={`m-mic ${listening ? 'on' : ''}`}
                onClick={toggleVoice}
                aria-label={listening ? 'Stop listening' : 'Speak to JARVIS'}
              >
                <MicIcon />
              </button>
            </form>
            {notice && <div className="m-error">{notice}</div>}
            {!speechSupported() && (
              <div className="m-empty" style={{ textAlign: 'center' }}>
                This browser has no speech recognition. Add JARVIS to your Home Screen
                and open it from there.
              </div>
            )}
          </div>
        )}
      </div>

      {stage.kind === 'home' && (
        <div className={`m-drawer ${drawer ? 'open' : ''}`}>
          <div className="m-grip" onClick={() => setDrawer((d) => !d)}>
            <span>{drawer ? 'Close' : 'Recent intelligence'}</span>
          </div>
          <div className="m-drawer-body">
            <div className="m-section">Recent intelligence</div>
            {recent.length === 0 ? (
              <div className="m-empty">
                Nothing yet. Ask about a person, a company or an event and the
                investigation appears here — and on the workstation at the same time.
              </div>
            ) : (
              recent.map((r) => (
                <div
                  className="m-item"
                  key={r.id}
                  onClick={() => {
                    void window.jarvis
                      .getExplanation?.(r.id)
                      .then((s: unknown) => {
                        if (s) setStage({ kind: 'story', data: s as Explanation })
                        setDrawer(false)
                      })
                      .catch(() => setNotice('That investigation could not be opened.'))
                  }}
                >
                  <div className="m-thumb placeholder">{r.subject.slice(0, 1).toUpperCase()}</div>
                  <div className="m-item-text">
                    <div className="m-item-title">{r.subject}</div>
                    <div className="m-item-sub">{new Date(r.at).toLocaleString()}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {halted && (
        <div className="m-halted">
          <div>
            <strong>STOPPED</strong>
            <span>Speech, research and pending actions halted.</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** The ambient presence. Its state is JARVIS's state — nothing decorative. */
function Core({
  state,
  busy,
  listening
}: {
  state: JarvisState
  busy: boolean
  listening: boolean
}): JSX.Element {
  const mood = listening ? 'listening' : busy ? 'working' : state.toLowerCase()
  return (
    <div className={`m-core ${mood}`} aria-label={`JARVIS is ${mood}`}>
      <div className="m-core-ring" />
      <div className="m-core-ring slow" />
      <div className="m-core-eye" />
    </div>
  )
}

function MicIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Pairing.
 *
 * The desktop shows a six-digit code; entering it here exchanges it for a
 * device token. The code is short-lived and single-use, because this grants a
 * device the authority of the workstation.
 */
function Pairing({ onPaired }: { onPaired: () => void }): JSX.Element {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const name = /iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone'
    const result = await pair(code, name)
    setBusy(false)
    if (result.ok) onPaired()
    else setError(result.error)
  }

  return (
    <div className="m-root">
      <div className="m-ambient" />
      <div className="m-rail">
        <div className="m-mark">
          J<b>A</b>RVIS
        </div>
      </div>
      <form className="m-pair" onSubmit={submit}>
        <h1>Pair this device</h1>
        <p>
          On the workstation, open JARVIS and choose <b>Pair phone</b>. Enter the six
          digits it shows.
        </p>
        <div className="m-code">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="——————"
            aria-label="Pairing code"
          />
        </div>
        {error && <div className="m-error">{error}</div>}
        <button className="m-btn" disabled={busy || code.length !== 6}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>
    </div>
  )
}

/**
 * Voice on the phone.
 *
 * The desktop runs a native Swift helper with continuous recognition and a wake
 * word. Safari cannot do that: recognition must be started by a user gesture,
 * and it ends on its own after a pause. So the phone is push-to-talk, and the
 * conversational loop after that — interrupt, follow-up, stop — is preserved.
 *
 * Speech *output* comes from the phone rather than the workstation, because the
 * user is holding the phone and the Mac may be in another room. The desktop
 * still speaks its own replies; this is the same text arriving on both.
 */

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: SpeechRecognitionLikeEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

interface SpeechRecognitionLikeEvent {
  resultIndex: number
  results: ArrayLike<
    ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }
  >
}

type Ctor = new () => Recognition

function ctor(): Ctor | null {
  const w = window as unknown as {
    SpeechRecognition?: Ctor
    webkitSpeechRecognition?: Ctor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function speechSupported(): boolean {
  return ctor() !== null
}

export interface VoiceHandlers {
  onPartial?: (text: string) => void
  onFinal?: (text: string, confidence: number) => void
  onStart?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
}

export class PhoneVoice {
  private rec: Recognition | null = null
  private handlers: VoiceHandlers = {}
  private wantListening = false
  listening = false

  constructor(private locale = 'en-IN') {}

  set on(h: VoiceHandlers) {
    this.handlers = h
  }

  /**
   * Starts recognition. Must be called from a touch handler on iOS — Safari
   * refuses a recognition session that no gesture asked for.
   */
  start(): void {
    const C = ctor()
    if (!C) {
      this.handlers.onError?.('This browser has no speech recognition.')
      return
    }
    if (this.listening) return

    const rec = new C()
    rec.lang = this.locale
    // Continuous is unreliable on iOS: it ends after a pause regardless. The
    // restart in `onend` is what actually keeps a conversation open.
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onstart = () => {
      this.listening = true
      this.handlers.onStart?.()
    }

    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const best = result[0]
        if (!best) continue
        if (result.isFinal) this.handlers.onFinal?.(best.transcript.trim(), best.confidence ?? 0)
        else this.handlers.onPartial?.(best.transcript.trim())
      }
    }

    rec.onerror = (e) => {
      // "no-speech" and "aborted" are ordinary in a conversation, not failures
      // worth showing someone.
      if (e.error === 'no-speech' || e.error === 'aborted') return
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantListening = false
        this.handlers.onError?.('Microphone access was refused. Allow it in Settings › Safari.')
        return
      }
      this.handlers.onError?.(e.error)
    }

    rec.onend = () => {
      this.listening = false
      // Safari ends the session on every pause. Restarting keeps the loop open
      // until the user actually says stop.
      if (this.wantListening) {
        setTimeout(() => {
          if (this.wantListening) {
            try {
              rec.start()
            } catch {
              this.wantListening = false
              this.handlers.onEnd?.()
            }
          }
        }, 220)
      } else {
        this.handlers.onEnd?.()
      }
    }

    this.rec = rec
    this.wantListening = true
    try {
      rec.start()
    } catch (err) {
      this.wantListening = false
      this.handlers.onError?.(err instanceof Error ? err.message : 'could not start listening')
    }
  }

  stop(): void {
    this.wantListening = false
    this.listening = false
    try {
      this.rec?.stop()
    } catch {
      /* already stopped */
    }
  }

  /** Immediate silence, for the emergency stop. */
  abort(): void {
    this.wantListening = false
    this.listening = false
    try {
      this.rec?.abort()
    } catch {
      /* ignore */
    }
    shutUp()
  }
}

// ------------------------------------------------------------------ speech out

let voice: SpeechSynthesisVoice | null = null

/**
 * Picks the best available voice, on the same principle as the desktop:
 * quality first, then a warm conversational name.
 */
function pickVoice(): SpeechSynthesisVoice | null {
  const all = window.speechSynthesis?.getVoices?.() ?? []
  if (all.length === 0) return null
  const english = all.filter((v) => v.lang.startsWith('en'))
  if (english.length === 0) return null
  const preferred = ['Ava', 'Zoe', 'Samantha', 'Serena', 'Evan', 'Daniel', 'Karen']
  // iOS marks its better voices as non-local (they synthesise server-side).
  const enhanced = english.filter((v) => /premium|enhanced/i.test(v.name))
  const pool = enhanced.length > 0 ? enhanced : english
  for (const name of preferred) {
    const hit = pool.find((v) => v.name.startsWith(name))
    if (hit) return hit
  }
  return pool[0] ?? null
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  voice = pickVoice()
  // Voices load asynchronously on first use.
  window.speechSynthesis.onvoiceschanged = () => {
    voice = pickVoice()
  }
}

/**
 * Whether iOS has let us make a sound yet.
 *
 * Safari refuses to synthesise speech that no user gesture asked for, and it
 * refuses *silently* — `speak()` returns, the utterance queues, and nothing is
 * heard. Everything JARVIS says arrives on an event from the workstation, which
 * is by definition not a gesture, so without this the phone was mute: the whole
 * answer was there on screen and none of it was ever spoken.
 *
 * The unlock is one silent utterance issued from inside a real touch. After
 * that the browser considers the page allowed to make noise and everything
 * queued plays normally.
 */
let unlocked = false
let pending: string[] = []

export function audioUnlocked(): boolean {
  return unlocked
}

/**
 * Call from a genuine user gesture — a tap, not a timer or an event handler.
 * Safe to call repeatedly; it does nothing once the unlock has taken.
 */
export function unlockAudio(): void {
  if (unlocked || !window.speechSynthesis) return
  try {
    // A space rather than an empty string: some builds discard an empty
    // utterance without treating it as the gesture-blessed first one.
    const primer = new SpeechSynthesisUtterance(' ')
    primer.volume = 0
    window.speechSynthesis.speak(primer)
    unlocked = true
    // Anything JARVIS said while we were mute is spoken now, in order.
    const queued = pending
    pending = []
    for (const text of queued) say(text)
  } catch {
    /* left locked; the next gesture tries again */
  }
}

function say(text: string): void {
  const u = new SpeechSynthesisUtterance(text)
  if (voice) u.voice = voice
  u.rate = 1.0
  u.pitch = 1.0
  window.speechSynthesis.speak(u)
}

/**
 * Speaks, or holds it until audio is unlocked.
 *
 * Only the most recent few lines are held: coming back to a phone that then
 * recites everything it wanted to say ten minutes ago would be worse than
 * silence.
 */
export function speak(text: string): void {
  if (!window.speechSynthesis || !text.trim()) return
  if (!unlocked) {
    pending.push(text)
    if (pending.length > 3) pending.shift()
    return
  }
  say(text)
}

/** Barge-in: drop everything queued and stop mid-word. */
export function shutUp(): void {
  pending = []
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* ignore */
  }
}

/**
 * Safari stops synthesising after the screen locks or the app is backgrounded,
 * and stays stopped even once it is visible again. Nudging the queue on return
 * is the documented way out of it.
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    try {
      if (window.speechSynthesis?.paused) window.speechSynthesis.resume()
    } catch {
      /* ignore */
    }
  })
}

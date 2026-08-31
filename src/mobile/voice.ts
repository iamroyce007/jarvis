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

export function speak(text: string): void {
  if (!window.speechSynthesis || !text.trim()) return
  const u = new SpeechSynthesisUtterance(text)
  if (voice) u.voice = voice
  u.rate = 1.0
  u.pitch = 1.0
  window.speechSynthesis.speak(u)
}

/** Barge-in: drop everything queued and stop mid-word. */
export function shutUp(): void {
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* ignore */
  }
}

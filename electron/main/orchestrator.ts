import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { ClaudeSessionManager } from './claude/session.js'
import { VoiceController } from './voice/voice.js'
import { SentenceStream } from './voice/sentences.js'
import { classify, confirmationPrompt } from './permissions.js'
import type { JarvisState, TranscriptEntry, ActivityStep } from '../../shared/types.js'

/** Maps Claude tool names to language a person would actually use. */
const TOOL_LABELS: Record<string, string> = {
  Bash: 'Running a command',
  Read: 'Reading a file',
  Edit: 'Editing code',
  Write: 'Writing a file',
  Glob: 'Searching for files',
  Grep: 'Searching the code',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a page',
  Task: 'Delegating a subtask',
  TodoWrite: 'Planning'
}

type Events = {
  state: [JarvisState]
  transcript: [TranscriptEntry]
  activity: [ActivityStep]
  level: [number]
  session: []
  error: [string]
  /** A completed user/assistant pair, for downstream graph extraction. */
  exchange: [{ user: string; assistant: string }]
  /** A user request that has been accepted, emitted before Claude answers. */
  request: [string]
  halted: [{ speech: boolean; turn: boolean; what: string }]
}

export interface OrchestratorOptions {
  wakeWord: string
  conversationTimeoutMs: number
  /** When true JARVIS acts on everything it hears, with no wake word and no timeout. */
  alwaysListening: boolean
}

export class Orchestrator extends EventEmitter {
  private state: JarvisState = 'IDLE'
  private conversationMode = false
  private contextProvider: ((utterance: string) => Promise<string | null>) | null = null
  private convoTimer: NodeJS.Timeout | null = null
  private sentences = new SentenceStream()
  private currentTurnText = ''
  private partialAt = 0
  private opts: OrchestratorOptions

  /** True while a Claude turn is in flight, so barge-in knows to cancel it. */
  private turnInFlight = false
  /** The request the in-flight turn is answering, paired on completion. */
  private currentRequest = ''
  /** A risky request held back until the user says yes. */
  private pendingRequest: string | null = null

  constructor(
    private claude: ClaudeSessionManager,
    private voice: VoiceController,
    opts: OrchestratorOptions
  ) {
    super()
    this.opts = opts
    this.wire()
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...a: unknown[]) => void)
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a)
  }

  getState(): JarvisState {
    return this.state
  }

  isConversing(): boolean {
    return this.conversationMode
  }

  private setState(s: JarvisState): void {
    if (this.state === s) return
    this.state = s
    this.emit('state', s)
  }

  private say(text: string): void {
    this.voice.speak(text)
  }

  private pushTranscript(speaker: 'user' | 'jarvis', text: string, partial = false): void {
    this.emit('transcript', {
      id: randomUUID(),
      speaker,
      text,
      at: Date.now(),
      partial
    })
  }

  private pushActivity(label: string, status: ActivityStep['status'], detail?: string): string {
    const id = randomUUID()
    this.emit('activity', { id, label, detail, status, at: Date.now() })
    return id
  }

  private wire(): void {
    this.voice.on('level', (rms) => this.emit('level', rms))

    this.voice.on('speechStart', () => {
      // Barge-in: the user talking over JARVIS always wins.
      if (this.voice.speaking || this.turnInFlight) this.bargeIn()
    })

    this.voice.on('speechEnd', () => {
      // Let the recognizer settle, then close the utterance for a final result.
      this.voice.endUtterance()
    })

    this.voice.on('partial', (text) => {
      const now = Date.now()
      if (now - this.partialAt < 120) return
      this.partialAt = now
      if (this.state === 'LISTENING' || this.conversationMode) {
        this.pushTranscript('user', text, true)
      }
    })

    // The helper re-arms recognition itself after every final result, so no
    // cycle() is issued here — two overlapping tasks drop audio between them.
    this.voice.on('final', (text) => void this.onFinalTranscript(text))

    this.voice.on('ttsEnd', ({ cancelled }) => {
      if (cancelled) return
      if (!this.voice.speaking && this.state === 'SPEAKING') {
        this.setState(this.conversationMode ? 'LISTENING' : 'IDLE')
      }
    })

    this.claude.on('delta', (text) => {
      this.currentTurnText += text
      // Speak each sentence the moment it completes, without waiting for the
      // rest of the response.
      for (const sentence of this.sentences.push(text)) {
        if (this.state !== 'SPEAKING') this.setState('SPEAKING')
        this.say(sentence)
      }
    })

    this.claude.on('tool', ({ name, input }) => {
      this.setState('EXECUTING')
      const label = TOOL_LABELS[name] ?? name
      const detail =
        name === 'Bash' && typeof (input as { command?: string })?.command === 'string'
          ? (input as { command: string }).command
          : undefined
      this.pushActivity(label, 'running', detail)
    })

    this.claude.on('result', ({ text, isError }) => {
      this.turnInFlight = false
      const tail = this.sentences.flush()
      if (tail) {
        if (this.state !== 'SPEAKING') this.setState('SPEAKING')
        this.say(tail)
      }

      const full = this.currentTurnText.trim() || text.trim()
      if (full) this.pushTranscript('jarvis', full)
      this.currentTurnText = ''

      if (isError) {
        // A turn cancelled by barge-in comes back as an error with no text.
        // That is the user interrupting on purpose, not a failure, and
        // announcing it would talk over whatever they just said.
        const cancelled = !text.trim() || /interrupt|abort|cancel/i.test(text)
        if (cancelled) {
          this.setState(this.conversationMode ? 'LISTENING' : 'IDLE')
          return
        }
        this.setState('ERROR')
        this.say('That one failed on me.')
        return
      }

      if (this.currentRequest && full) {
        this.emit('exchange', { user: this.currentRequest, assistant: full })
      }
      this.currentRequest = ''

      this.emit('session')
      if (!this.voice.speaking) {
        this.setState(this.conversationMode ? 'LISTENING' : 'IDLE')
      }
      this.armConversationTimeout()
    })

    this.claude.on('error', (msg) => {
      this.turnInFlight = false
      this.setState('ERROR')
      this.emit('error', msg)
    })
  }

  /**
   * Emergency stop. Unlike barge-in this is explicit and reported: it stops
   * speech, abandons the running turn, drops anything queued and leaves JARVIS
   * idle rather than listening for a follow-up.
   */
  halt(): { speech: boolean; turn: boolean; what: string } {
    const speech = this.voice.speaking
    const turn = this.turnInFlight

    this.voice.shutUp()
    this.sentences.reset()
    this.currentTurnText = ''
    this.pendingRequest = null
    if (turn) this.claude.interrupt()
    this.turnInFlight = false
    this.clearConversationTimeout()
    this.setState('INTERRUPTED')

    const parts: string[] = []
    if (speech) parts.push('speech')
    if (turn) parts.push(`request: ${this.currentRequest.slice(0, 80) || 'in progress'}`)
    const what = parts.length ? parts.join(' · ') : 'nothing was running'
    this.currentRequest = ''

    const result = { speech, turn, what }
    this.emit('halted', result)
    return result
  }

  /** Cut off speech and abandon the in-flight Claude turn. */
  bargeIn(): void {
    this.voice.shutUp()
    this.sentences.reset()
    this.currentTurnText = ''
    if (this.turnInFlight) {
      this.claude.interrupt()
      this.turnInFlight = false
    }
    this.setState('LISTENING')
  }

  private stripWakeWord(text: string): { addressed: boolean; rest: string } {
    const wake = this.opts.wakeWord.toLowerCase()
    const normalized = text.trim().toLowerCase()
    // Recognizers commonly return "Jarvis," / "Hey Jarvis" / "Travis".
    const pattern = new RegExp(`^(hey\\s+|ok\\s+)?(${wake}|jervis|travis|charvis)\\b[\\s,.:!?-]*`, 'i')
    const m = text.trim().match(pattern)
    if (m) return { addressed: true, rest: text.trim().slice(m[0].length).trim() }
    return { addressed: normalized.startsWith(wake), rest: text.trim() }
  }

  /**
   * Filters stray noise without swallowing real openers.
   *
   * A flat two-word minimum meant "hello", "stop" and "hey" were dropped, so a
   * conversation could not be started by voice at all — the user had to click
   * or type first. Single words now count when they are plausible speech;
   * only recogniser noise fragments are discarded.
   */
  private isWorthActingOn(utterance: string, addressed: boolean): boolean {
    const clean = utterance.trim()
    if (!clean) return false
    // Being addressed by name is intent enough, whatever follows.
    if (addressed) return true

    const words = clean.split(/\s+/)
    if (words.length >= 2) return true

    const single = words[0].toLowerCase().replace(/[^a-z]/g, '')
    if (single.length < 2) return false
    // Common one-word openers and commands worth honouring.
    const SOLO = new Set([
      'hi', 'hey', 'hello', 'yo', 'stop', 'quit', 'cancel', 'wait', 'pause',
      'resume', 'continue', 'yes', 'yeah', 'yep', 'no', 'nope', 'ok', 'okay',
      'thanks', 'undo', 'repeat', 'again', 'sleep', 'help', 'what', 'why', 'how'
    ])
    return SOLO.has(single)
  }

  private async onFinalTranscript(raw: string): Promise<void> {
    const text = raw.trim()
    if (!text) return

    const { addressed, rest } = this.stripWakeWord(text)

    // Always-listening mode: act on everything, wake word optional. Very short
    // fragments are ignored so stray noise doesn't trigger a turn.
    if (this.opts.alwaysListening) {
      const utterance = addressed ? rest : text
      if (!this.isWorthActingOn(utterance, addressed)) return
      if (this.handleConfirmation(utterance)) return
      if (this.handleLocalCommand(utterance)) return
      this.pushTranscript('user', utterance)
      const risk = classify(utterance)
      if (risk !== 'SAFE') {
        this.pendingRequest = utterance
        this.setState('WAITING_FOR_CONFIRMATION')
        const q = confirmationPrompt(utterance, risk)
        this.pushTranscript('jarvis', q)
        this.say(q)
        return
      }
      await this.ask(utterance)
      return
    }

    // Otherwise JARVIS only responds when addressed by name.
    if (!this.conversationMode && !addressed) return

    if (addressed && !this.conversationMode) {
      this.enterConversation()
      // "Jarvis." on its own is just a summons.
      if (!rest) {
        this.setState('LISTENING')
        return
      }
    }

    const utterance = this.conversationMode && !addressed ? text : rest || text
    if (!utterance) return

    if (this.handleConfirmation(utterance)) return
    if (this.handleLocalCommand(utterance)) return

    this.pushTranscript('user', utterance)

    const risk = classify(utterance)
    if (risk !== 'SAFE') {
      this.pendingRequest = utterance
      this.setState('WAITING_FOR_CONFIRMATION')
      const q = confirmationPrompt(utterance, risk)
      this.pushTranscript('jarvis', q)
      this.say(q)
      return
    }

    await this.ask(utterance)
  }

  /** Resolves a held-back request when the user answers yes or no. */
  private handleConfirmation(text: string): boolean {
    if (!this.pendingRequest) return false
    const t = text.toLowerCase().replace(/[.!?]+$/, '').trim()

    if (/^(yes|yeah|yep|yup|confirm|do it|go ahead|proceed|affirmative|sure|ok|okay)$/.test(t)) {
      const req = this.pendingRequest
      this.pendingRequest = null
      void this.ask(req)
      return true
    }
    if (/^(no|nope|cancel|stop|don'?t|nevermind|never mind|abort)$/.test(t)) {
      this.pendingRequest = null
      const msg = 'Cancelled.'
      this.pushTranscript('jarvis', msg)
      this.say(msg)
      this.setState(this.conversationMode ? 'LISTENING' : 'IDLE')
      return true
    }
    // Anything else replaces the pending request rather than answering it.
    this.pendingRequest = null
    return false
  }

  /** Commands JARVIS answers itself, with no round-trip to Claude. */
  private handleLocalCommand(text: string): boolean {
    const t = text.toLowerCase().replace(/[.!?]+$/, '').trim()

    // Emergency stop is deliberately matched before anything else and accepts
    // the phrasings people actually use under pressure.
    if (/^(jarvis[,\s]+)?(stop everything|cancel everything|emergency stop|abort|halt)$/.test(t)) {
      this.halt()
      this.setState('EMERGENCY_HALT')
      return true
    }
    if (/^(stop|quiet|silence|shut up|never ?mind|cancel that|wait)$/.test(t)) {
      this.bargeIn()
      return true
    }
    if (/^(go to sleep|sleep|that'?s all|leave it there|stand down)$/.test(t)) {
      this.exitConversation()
      this.say('Standing by.')
      return true
    }
    if (/^(silent mode|mute)$/.test(t)) {
      this.voice.muted = true
      this.voice.shutUp()
      return true
    }
    if (/^(unmute|speak again|voice on)$/.test(t)) {
      this.voice.muted = false
      this.say('Voice restored.')
      return true
    }
    return false
  }

  /** Send a turn to Claude Code. Used by both voice and typed input. */
  /**
   * Supplies the caller-provided environment snapshot (frontmost app, window
   * title) so a bare "fix this" has a referent. Cheap enough to run per turn;
   * the screenshot itself is left to Claude, which takes one when it needs to.
   */
  setContextProvider(fn: (utterance: string) => Promise<string | null>): void {
    this.contextProvider = fn
  }

  async ask(text: string): Promise<void> {
    if (!this.claude.isRunning) {
      this.setState('ERROR')
      this.emit('error', 'Claude Code session is not running.')
      this.say('I have lost my connection to Claude.')
      return
    }

    this.clearConversationTimeout()
    this.setState('THINKING')
    this.sentences.reset()
    this.currentTurnText = ''
    this.turnInFlight = true

    try {
      // Prefix the environment so deictic requests ("fix this", "what's this")
      // resolve to whatever the user is actually looking at.
      this.currentRequest = text
      this.emit('request', text)
      let payload = text
      if (this.contextProvider) {
        try {
          const ctx = await this.contextProvider(text)
          if (ctx) payload = `${ctx}\n\nUser said: ${text}`
        } catch {
          /* context is best-effort; never block the turn */
        }
      }
      await this.claude.send(payload)
    } catch (err) {
      this.turnInFlight = false
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'interrupted') return
      this.setState('ERROR')
      this.emit('error', msg)
    }
  }

  enterConversation(): void {
    this.conversationMode = true
    this.setState('LISTENING')
    this.armConversationTimeout()
  }

  exitConversation(): void {
    this.conversationMode = false
    this.clearConversationTimeout()
    this.setState('IDLE')
  }

  private armConversationTimeout(): void {
    this.clearConversationTimeout()
    // Always-listening never times out.
    if (!this.conversationMode || this.opts.alwaysListening) return
    this.convoTimer = setTimeout(() => {
      this.exitConversation()
    }, this.opts.conversationTimeoutMs)
  }

  private clearConversationTimeout(): void {
    if (this.convoTimer) {
      clearTimeout(this.convoTimer)
      this.convoTimer = null
    }
  }
}

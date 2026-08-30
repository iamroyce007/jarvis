import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { stripForSpeech } from './sentences.js'

/** Wraps the native Swift helper: on-device STT, native TTS, RMS VAD. */

type Events = {
  ready: []
  auth: [{ ok: boolean; status: string }]
  partial: [string]
  final: [string, number]
  speechStart: []
  speechEnd: []
  level: [number]
  ttsStart: [string]
  ttsEnd: [{ id: string; cancelled: boolean }]
  inputDevice: [string]
  voiceSelected: [{ name: string; quality: string; lang?: string }]
  listening: [boolean]
  /** Fires when the whole spoken queue has drained naturally. */
  spokenAll: []
  error: [string]
}

export class VoiceController extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private queue: { id: string; text: string }[] = []
  private speakingId: string | null = null
  private binaryPath: string

  listening = false
  speaking = false
  muted = false

  get isAlive(): boolean {
    return this.proc !== null
  }

  constructor(binaryPath: string) {
    super()
    this.binaryPath = binaryPath
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...a: unknown[]) => void)
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a)
  }

  start(): void {
    if (this.proc) return
    if (!existsSync(this.binaryPath)) {
      this.emit('error', `Voice helper missing at ${this.binaryPath}. Run: npm run native`)
      return
    }
    console.log('[jarvis] launching voice helper:', this.binaryPath)

    const proc = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (c: string) => this.onData(c))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (c: string) => this.emit('error', c.trim()))

    proc.on('error', (err) => {
      this.proc = null
      this.emit('error', `Voice helper failed to launch: ${err.message}`)
    })

    proc.on('exit', (code, signal) => {
      console.log('[jarvis] voice helper exited', code, signal)
      this.proc = null
      this.listening = false
      this.speaking = false
      if (code !== 0) this.emit('error', `Voice helper exited (${code ?? signal}).`)
    })
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.proc) return
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n')
    } catch {
      /* helper died */
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      let m: Record<string, unknown>
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      this.handle(m)
    }
  }

  private handle(m: Record<string, unknown>): void {
    switch (m.type) {
      case 'ready':
        this.emit('ready')
        break
      case 'auth':
        this.emit('auth', { ok: m.ok === true, status: String(m.status) })
        break
      case 'level':
        this.emit('level', Number(m.rms) || 0)
        break
      case 'speech_start':
        this.emit('speechStart')
        break
      case 'speech_end':
        this.emit('speechEnd')
        break
      case 'stt_partial':
        this.emit('partial', String(m.text ?? ''))
        break
      case 'stt_final':
        this.emit('final', String(m.text ?? ''), Number(m.confidence) || 0)
        break
      case 'listening':
        this.listening = m.value === true
        this.emit('listening', this.listening)
        break
      case 'tts_start':
        this.speaking = true
        this.emit('ttsStart', String(m.id ?? ''))
        break
      case 'tts_end': {
        const cancelled = m.cancelled === true
        this.emit('ttsEnd', { id: String(m.id ?? ''), cancelled })
        if (cancelled) {
          // Barge-in: abandon everything still queued.
          this.queue = []
          this.speakingId = null
          this.speaking = false
        } else {
          this.speakingId = null
          if (this.queue.length > 0) this.dequeue()
          else {
            this.speaking = false
            this.emit('spokenAll')
          }
        }
        break
      }
      case 'voice_selected':
        this.emit('voiceSelected', {
          name: String(m.name ?? 'unknown'),
          quality: String(m.quality ?? 'default'),
          lang: m.lang ? String(m.lang) : undefined
        })
        break
      case 'input_device':
        this.emit('inputDevice', String(m.name ?? 'unknown'))
        break
      case 'warn':
        this.emit('error', `${m.where}: ${m.message}`)
        break
      case 'error':
        this.emit('error', `${m.where}: ${m.message}`)
        break
    }
  }

  configure(cfg: {
    voice?: string
    rate?: number
    volume?: number
    vadSilenceMs?: number
    onDevice?: boolean
    contextualStrings?: string[]
  }): void {
    this.send({ op: 'configure', ...cfg })
  }

  requestAuth(): void {
    this.send({ op: 'auth' })
  }

  listen(locale = 'en-US'): void {
    this.send({ op: 'listen_start', locale })
  }

  stopListening(): void {
    this.send({ op: 'listen_stop' })
  }

  /** Close the current utterance so a final transcript is produced. */
  endUtterance(): void {
    this.send({ op: 'end_utterance' })
  }

  /** Begin a fresh recognition pass without restarting the audio engine. */
  cycle(): void {
    this.send({ op: 'cycle' })
  }

  /** Queue a sentence. Speaks immediately when idle, otherwise waits its turn. */
  /**
   * Queues speech. Returns the utterance id, or null when nothing was queued
   * (muted, or the text was empty once stripped), so a caller that needs to
   * wait for this specific utterance can tell the difference between "wait for
   * `ttsEnd`" and "there is nothing to wait for".
   */
  speak(text: string): string | null {
    if (this.muted) return null
    const clean = stripForSpeech(text)
    if (!clean) return null
    const id = randomUUID()
    this.queue.push({ id, text: clean })
    if (!this.speakingId) this.dequeue()
    return id
  }

  private dequeue(): void {
    const next = this.queue.shift()
    if (!next) {
      this.speaking = false
      this.emit('spokenAll')
      return
    }
    this.speakingId = next.id
    this.speaking = true
    this.send({ op: 'speak', text: next.text, id: next.id })
  }

  /** Immediate barge-in: silence output and clear anything pending. */
  shutUp(): void {
    this.queue = []
    this.speakingId = null
    this.send({ op: 'stop_speaking' })
    this.speaking = false
  }

  stop(): void {
    this.send({ op: 'quit' })
    this.proc = null
  }
}

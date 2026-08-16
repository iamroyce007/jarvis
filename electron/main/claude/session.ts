import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { resolveClaudeBinary, enrichedPath } from './resolve.js'

/**
 * Persistent bridge to Claude Code over its supported stream-json stdio protocol.
 *
 * Intelligence comes from the user's Claude Pro subscription via the locally
 * authenticated CLI. No Anthropic API key is used or accepted anywhere here.
 */

export interface ClaudeSessionOptions {
  cwd: string
  model?: string
  /** Claude Code permission mode. JARVIS gates dangerous work itself before sending. */
  permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan'
  systemPromptAppend?: string
  binary?: string
  /** Hard denylist enforced by Claude Code itself, e.g. "Bash(rm -rf *)". */
  disallowedTools?: string[]
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export interface ToolActivity {
  id: string
  name: string
  input: unknown
}

type Events = {
  init: [{ sessionId: string; model: string; tools: string[] }]
  /** Incremental assistant text, already de-duplicated against full messages. */
  delta: [string]
  /** A complete assistant text block. */
  message: [string]
  tool: [ToolActivity]
  toolResult: [{ id: string; isError: boolean }]
  result: [{ text: string; turns: number; latencyMs: number; isError: boolean }]
  error: [string]
  exit: [{ code: number | null; signal: string | null }]
  stderr: [string]
}

export class ClaudeSessionManager extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private opts: ClaudeSessionOptions
  private starting = false
  private intentionalStop = false

  sessionId: string | null = null
  model: string | null = null
  connected = false
  turns = 0
  lastLatencyMs: number | null = null

  private turnStartedAt = 0
  private pendingTurn: {
    resolve: (v: string) => void
    reject: (e: Error) => void
  } | null = null
  /** Text accumulated for the in-flight turn, used for sentence-streaming to TTS. */
  private restartAttempts = 0

  constructor(opts: ClaudeSessionOptions) {
    super()
    this.opts = opts
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...a: unknown[]) => void)
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a)
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed
  }

  /** Launch the persistent Claude Code process. Resumes prior session when known. */
  async start(resume = true): Promise<void> {
    if (this.isRunning || this.starting) return
    this.starting = true
    this.intentionalStop = false

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Voice turns should start fast: skip discovering and booting MCP servers
      // configured for other projects.
      '--strict-mcp-config',
      // Spoken requests are mostly short, concrete actions. Low effort keeps
      // replies snappy; complex work still escalates through tool use.
      '--effort',
      this.opts.effort ?? 'low'
    ]

    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode)
    if (this.opts.systemPromptAppend)
      args.push('--append-system-prompt', this.opts.systemPromptAppend)
    // Passed as one comma-separated value: the flag is variadic, so separate
    // arguments would swallow whatever follows on the command line.
    if (this.opts.disallowedTools?.length)
      args.push('--disallowedTools', this.opts.disallowedTools.join(','))
    if (resume && this.sessionId) args.push('--resume', this.sessionId)

    const env = { ...process.env }
    // A GUI launch inherits launchd's minimal PATH, so tools Claude Code shells
    // out to (git, node, npm) would also be missing.
    env.PATH = enrichedPath()
    // JARVIS is subscription-only by design; never let a stray key redirect billing.
    delete env.ANTHROPIC_API_KEY

    const proc = spawn(this.opts.binary ?? resolveClaudeBinary(), args, {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => this.emit('stderr', chunk))

    // Claude Code withholds its `init` message until the first user turn
    // arrives, so a live process is what "connected" means here. `init` later
    // fills in the session id and model.
    this.connected = true
    this.restartAttempts = 0

    proc.on('error', (err) => {
      this.connected = false
      this.emit('error', `Failed to launch Claude Code: ${err.message}`)
    })

    proc.on('exit', (code, signal) => {
      this.connected = false
      this.proc = null
      this.emit('exit', { code, signal })
      if (this.pendingTurn) {
        this.pendingTurn.reject(new Error('Claude Code exited mid-turn'))
        this.pendingTurn = null
      }
      if (!this.intentionalStop) void this.autoRestart()
    })

    this.starting = false
  }

  private async autoRestart(): Promise<void> {
    if (this.restartAttempts >= 5) {
      this.emit('error', 'Claude Code keeps exiting; giving up on auto-restart.')
      return
    }
    const delay = Math.min(500 * 2 ** this.restartAttempts, 8000)
    this.restartAttempts += 1
    await new Promise((r) => setTimeout(r, delay))
    await this.start(true)
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (!line.trim()) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      this.handle(msg)
    }
  }

  private handle(msg: Record<string, unknown>): void {
    const type = msg.type as string

    if (type === 'system' && msg.subtype === 'init') {
      this.sessionId = (msg.session_id as string) ?? this.sessionId
      this.model = (msg.model as string) ?? this.model
      this.connected = true
      this.restartAttempts = 0
      this.emit('init', {
        sessionId: this.sessionId!,
        model: this.model!,
        tools: (msg.tools as string[]) ?? []
      })
      return
    }

    // Incremental text for low-latency speech.
    if (type === 'stream_event') {
      const ev = msg.event as Record<string, unknown> | undefined
      if (ev?.type === 'content_block_delta') {
        const delta = ev.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.emit('delta', delta.text)
        }
      }
      return
    }

    if (type === 'assistant') {
      const message = msg.message as { content?: unknown[] } | undefined
      for (const block of message?.content ?? []) {
        const b = block as Record<string, unknown>
        if (b.type === 'tool_use') {
          this.emit('tool', {
            id: b.id as string,
            name: b.name as string,
            input: b.input
          })
        }
      }
      return
    }

    if (type === 'user') {
      const message = msg.message as { content?: unknown[] } | undefined
      for (const block of message?.content ?? []) {
        const b = block as Record<string, unknown>
        if (b.type === 'tool_result') {
          this.emit('toolResult', {
            id: b.tool_use_id as string,
            isError: b.is_error === true
          })
        }
      }
      return
    }

    if (type === 'result') {
      const text = typeof msg.result === 'string' ? msg.result : ''
      const isError = msg.is_error === true || msg.subtype !== 'success'
      this.turns += 1
      this.lastLatencyMs = Date.now() - this.turnStartedAt
      if (typeof msg.session_id === 'string') this.sessionId = msg.session_id

      this.emit('result', {
        text,
        turns: this.turns,
        latencyMs: this.lastLatencyMs,
        isError
      })

      if (this.pendingTurn) {
        const p = this.pendingTurn
        this.pendingTurn = null
        if (isError) p.reject(new Error(text || 'Claude Code returned an error'))
        else p.resolve(text)
      }
      return
    }
  }

  /** Send a user turn. Resolves with the final text when the turn completes. */
  send(text: string): Promise<string> {
    if (!this.isRunning) return Promise.reject(new Error('Claude Code session is not running'))
    if (this.pendingTurn) return Promise.reject(new Error('A turn is already in flight'))

    this.turnStartedAt = Date.now()
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }
    this.proc!.stdin.write(JSON.stringify(payload) + '\n')

    return new Promise<string>((resolve, reject) => {
      this.pendingTurn = { resolve, reject }
    })
  }

  /** Barge-in: ask Claude Code to abandon the current turn. */
  interrupt(): void {
    if (!this.isRunning) return
    const req = {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' }
    }
    try {
      this.proc!.stdin.write(JSON.stringify(req) + '\n')
    } catch {
      /* process already gone */
    }
    if (this.pendingTurn) {
      this.pendingTurn.reject(new Error('interrupted'))
      this.pendingTurn = null
    }
  }

  /** Drop conversational history and begin a fresh Claude Code session. */
  async newSession(): Promise<void> {
    this.sessionId = null
    this.turns = 0
    await this.restart(false)
  }

  async switchProject(cwd: string): Promise<void> {
    this.opts.cwd = cwd
    this.sessionId = null
    this.turns = 0
    await this.restart(false)
  }

  private async restart(resume: boolean): Promise<void> {
    this.stop()
    await new Promise((r) => setTimeout(r, 150))
    await this.start(resume)
  }

  stop(): void {
    this.intentionalStop = true
    if (!this.proc) return
    try {
      this.proc.stdin.end()
      this.proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    this.proc = null
    this.connected = false
  }
}

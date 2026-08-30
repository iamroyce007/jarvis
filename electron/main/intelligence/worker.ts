import { ClaudeSessionManager } from '../claude/session.js'
import { log } from '../log.js'

/**
 * A warm Claude process for structured work.
 *
 * Every `claude -p` invocation pays 10–15 seconds of CLI start-up before the
 * model does anything, which dominated the time to first paint: a Haiku sketch
 * that should take four seconds was taking seventeen.
 *
 * This keeps one process alive and feeds it prompts over the existing
 * stream-json channel, so that cost is paid once at launch instead of on every
 * request. It is deliberately separate from the conversational session — these
 * prompts must never pollute what the user is actually talking about, and
 * each request starts a fresh session so tasks cannot contaminate each other.
 */

export interface WorkerOptions {
  cwd: string
  model?: string
  effort?: 'low' | 'medium' | 'high'
  /** Tools this worker may use. Research needs the web; extraction needs none. */
  disallowedTools?: string[]
  allowWeb?: boolean
}

export class StructuredWorker {
  private session: ClaudeSessionManager
  private ready = false
  private busy = false
  private queue: (() => void)[] = []
  private tasksRun = 0
  private warming: Promise<void> | null = null

  /**
   * Tasks before the session is recycled.
   *
   * Restarting costs the start-up penalty again, so it cannot happen per task —
   * but context accumulates across prompts, so it cannot never happen either.
   * Structured prompts are short and self-contained, which makes a modest
   * batch safe.
   */
  private static readonly RECYCLE_AFTER = 8

  constructor(private opts: WorkerOptions) {
    this.session = new ClaudeSessionManager({
      cwd: opts.cwd,
      model: opts.model ?? 'claude-haiku-4-5-20251001',
      effort: opts.effort ?? 'low',
      // Structured tasks have no interactive channel, same as the main session.
      permissionMode: 'bypassPermissions',
      disallowedTools:
        opts.disallowedTools ??
        (opts.allowWeb
          ? ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task']
          : ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'])
    })
  }

  /**
   * Sends a throwaway prompt so the expensive part of start-up is already done.
   *
   * Spawning the process is not enough: Claude Code defers authentication,
   * tool discovery and the session handshake until the first prompt actually
   * arrives. A worker that had been "warm" since launch still took
   * twenty-eight seconds to answer a four-second question, because the user's
   * question *was* the first prompt.
   *
   * The exchange is left in context deliberately. Clearing it means restarting
   * the process, which discards exactly the state this is paying for — the
   * first attempt did that and made things worse. One trivial turn is
   * harmless: every real prompt here is self-contained and carries its own
   * instructions.
   */
  private async prime(): Promise<void> {
    try {
      await Promise.race([
        this.session.send('Reply with the single word: ready'),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('priming timed out')), 90_000)
        )
      ])
      this.tasksRun = 1
    } catch (err) {
      // Not fatal — the first real prompt simply pays the cost instead,
      // exactly as it did before any of this existed.
      log(`worker priming failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Spawns the process and primes it, once, however many callers ask. */
  async warm(): Promise<void> {
    if (this.ready) return
    if (this.warming) return this.warming
    this.warming = (async () => {
      const started = Date.now()
      await this.session.start(false)
      this.ready = true
      await this.prime()
      log(
        `worker ready: ${this.opts.model ?? 'haiku'}` +
          `${this.opts.allowWeb ? ' (web)' : ''} in ${Date.now() - started}ms`
      )
    })()
    return this.warming
  }

  /** Serialises access: one prompt at a time per worker. */
  private async acquire(): Promise<void> {
    if (!this.busy) {
      this.busy = true
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.busy = true
  }

  private release(): void {
    this.busy = false
    const next = this.queue.shift()
    if (next) next()
  }

  /**
   * Runs one prompt and returns its full text.
   * Starts a fresh session first so no earlier task remains in context.
   */
  async run(prompt: string, timeoutMs = 120_000): Promise<string> {
    await this.warm()
    await this.acquire()
    try {
      // Recycle occasionally so context cannot grow without bound, but never
      // per task — the restart is exactly the cost this class exists to avoid.
      if (this.tasksRun >= StructuredWorker.RECYCLE_AFTER) {
        await this.session.newSession()
        this.tasksRun = 0
        // The restart throws away the CLI's initialised state, so the next
        // task would otherwise pay the full cold start. Re-prime here instead,
        // where nobody is waiting on an answer.
        await this.prime()
      }
      this.tasksRun += 1

      const result = await Promise.race([
        this.session.send(prompt),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('worker timed out')), timeoutMs)
        )
      ])
      return result
    } finally {
      this.release()
    }
  }

  stop(): void {
    this.session.stop()
    this.ready = false
    this.warming = null
  }
}

/** Knowledge-only worker: fast sketches, entity extraction. No tools at all. */
export const fastWorker = (cwd: string): StructuredWorker =>
  new StructuredWorker({ cwd, model: 'claude-haiku-4-5-20251001', effort: 'low' })

/** Research worker: web search enabled, nothing that touches this machine. */
export const webWorker = (cwd: string): StructuredWorker =>
  new StructuredWorker({ cwd, model: 'claude-sonnet-5', effort: 'low', allowWeb: true })

import type { ClaudeSessionManager } from './session.js'
import { log } from '../log.js'

/**
 * Automatic context compaction.
 *
 * A voice conversation never ends — JARVIS runs all day in the menu bar — so
 * the session's context grows without bound. Every turn re-sends the whole
 * history, which means the tenth question in a conversation costs several
 * times what the first one did, for no extra usefulness. That is the slow leak
 * behind "usage jumped and I only asked a few things".
 *
 * This is the same idea as typing `/compact`: ask the session to summarise
 * itself, throw away the transcript, and start again from the summary. The
 * thread of the conversation survives; the token weight of it does not.
 *
 * It runs between turns, never during one, and a failure is silent — a session
 * that will not summarise simply keeps its history, which is only expensive.
 */

const SUMMARY_PROMPT =
  'Summarise this conversation for your own future reference in under 150 words. ' +
  'Cover: what the user is working on, decisions already made, facts about them or ' +
  'their machine worth remembering, and anything still unfinished. Write it as ' +
  'notes to yourself, not as a reply to the user. Output only the summary.'

export interface CompactorOptions {
  /** Turns before a compaction is considered. */
  everyTurns?: number
  /** Weighted tokens in one session before compaction is forced. */
  tokenCeiling?: number
}

export class Compactor {
  private everyTurns: number
  private tokenCeiling: number
  private turnsBaseline = 0
  /**
   * Weighted usage at the last compaction.
   *
   * `totalUsage` on the session is cumulative and survives `newSession()`, so
   * without a baseline the token ceiling stays crossed forever and every turn
   * after the first compaction would trigger another one.
   */
  private tokenBaseline = 0
  private running = false

  constructor(
    private session: ClaudeSessionManager,
    opts: CompactorOptions = {}
  ) {
    this.everyTurns = opts.everyTurns ?? Number(process.env.JARVIS_COMPACT_TURNS ?? 12)
    this.tokenCeiling = opts.tokenCeiling ?? Number(process.env.JARVIS_COMPACT_TOKENS ?? 60_000)
  }

  /**
   * Whether the session is heavy enough to be worth compacting.
   *
   * Cache reads are the signal, not the input count: on a long conversation
   * almost the whole prompt is a cache hit, so a session whose cache reads have
   * ballooned is precisely one carrying a large history.
   */
  private shouldCompact(): boolean {
    const s = this.session as unknown as {
      turns: number
      totalUsage: { input: number; cacheRead: number; cacheWrite: number }
    }
    const turnsSince = s.turns - this.turnsBaseline
    if (turnsSince < 4) return false
    if (turnsSince >= this.everyTurns) return true
    const weight = s.totalUsage.input + s.totalUsage.cacheWrite + s.totalUsage.cacheRead / 10
    return weight - this.tokenBaseline >= this.tokenCeiling
  }

  /**
   * Compacts if warranted. Call between turns.
   *
   * Returns true when the session was actually replaced, so the caller can
   * refresh anything that displays session state.
   */
  async maybeCompact(): Promise<boolean> {
    if (this.running || !this.shouldCompact()) return false
    this.running = true
    try {
      const summary = await Promise.race([
        this.session.send(SUMMARY_PROMPT),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('summary timed out')), 45_000)
        )
      ])
      const clean = summary.trim()
      // A summary that failed to come back is not worth restarting for: the
      // restart would drop the history *and* the thread of the conversation.
      if (clean.length < 40) {
        log('compact: summary too thin, keeping history')
        return false
      }

      await this.session.newSession()
      await this.session.send(
        'Context from earlier in this conversation, carried forward after ' +
          'compaction. Acknowledge with nothing — do not reply to the user.\n\n' +
          clean
      )
      const s = this.session as unknown as {
        turns: number
        totalUsage: { input: number; cacheRead: number; cacheWrite: number }
      }
      this.turnsBaseline = s.turns
      this.tokenBaseline =
        s.totalUsage.input + s.totalUsage.cacheWrite + s.totalUsage.cacheRead / 10
      log(`compact: history replaced with a ${clean.length}-character summary`)
      return true
    } catch (err) {
      log(`compact failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      this.running = false
    }
  }

  /** Forced compaction, for an explicit request. */
  async compactNow(): Promise<boolean> {
    this.turnsBaseline = -Infinity
    this.tokenBaseline = -Infinity
    return this.maybeCompact()
  }
}

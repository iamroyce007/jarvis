import { usageSince } from '../store/usage.js'
import { log } from '../log.js'

/**
 * Spend control for the optional research pass.
 *
 * A Claude Pro subscription is metered in a rolling five-hour window, and the
 * expensive part of JARVIS is not the conversation — it is `explain()`, which
 * runs a Sonnet web-research pass whose context fills with whole scraped pages.
 * One of those costs more than a dozen spoken turns.
 *
 * The failure this exists to prevent: the router used to treat almost any
 * sentence as a research request, so an ordinary chat quietly launched a full
 * investigation behind it and the window drained in a handful of questions.
 * Routing is now narrow (see intent.ts), and this is the second line — a hard
 * ceiling so a burst of genuinely research-shaped questions still cannot eat
 * the window.
 *
 * Nothing here blocks conversation. When the budget is gone JARVIS still talks,
 * it just stops assembling storyboards until the window rolls over.
 */

/** Claude Pro's rate-limit window. */
export const WINDOW_MS = 5 * 60 * 60 * 1000

/**
 * Research passes allowed per window.
 *
 * Measured: one pass runs 120k–260k tokens once scraped pages land in context.
 * Six is roughly a fifth of a window, which leaves the rest for talking.
 */
const MAX_RESEARCH_PER_WINDOW = Number(process.env.JARVIS_RESEARCH_BUDGET ?? 6)

/**
 * Token ceiling for the window, counting everything JARVIS spends.
 *
 * Cache reads are counted at a tenth of their face value: they are real usage
 * but an order of magnitude cheaper, and counting them whole made a long
 * conversation look like a runaway even when it was costing almost nothing.
 */
const MAX_TOKENS_PER_WINDOW = Number(process.env.JARVIS_TOKEN_BUDGET ?? 900_000)

const passes: number[] = []

export interface BudgetState {
  researchUsed: number
  researchLimit: number
  tokensUsed: number
  tokenLimit: number
  /** 0–1. What fraction of the window is gone. */
  fraction: number
  allowed: boolean
  reason: string | null
}

function prune(): void {
  const cutoff = Date.now() - WINDOW_MS
  while (passes.length > 0 && passes[0] < cutoff) passes.shift()
}

/** Weighted token spend inside the current window. */
function tokensThisWindow(): number {
  const u = usageSince(WINDOW_MS)
  return u.input + u.output + u.cacheWrite + Math.round(u.cacheRead / 10)
}

export function budget(): BudgetState {
  prune()
  const tokensUsed = tokensThisWindow()
  const researchUsed = passes.length
  const fraction = Math.min(
    1,
    Math.max(researchUsed / MAX_RESEARCH_PER_WINDOW, tokensUsed / MAX_TOKENS_PER_WINDOW)
  )

  let reason: string | null = null
  if (researchUsed >= MAX_RESEARCH_PER_WINDOW) {
    reason = `${researchUsed} research passes already this window`
  } else if (tokensUsed >= MAX_TOKENS_PER_WINDOW) {
    reason = `${Math.round(tokensUsed / 1000)}k tokens already this window`
  }

  return {
    researchUsed,
    researchLimit: MAX_RESEARCH_PER_WINDOW,
    tokensUsed,
    tokenLimit: MAX_TOKENS_PER_WINDOW,
    fraction,
    allowed: reason === null,
    reason
  }
}

/**
 * Asks permission to run a research pass, and books it if granted.
 *
 * Booking on request rather than on completion is deliberate: a pass that is
 * cancelled or times out has still spent most of its tokens.
 */
export function claimResearch(): { ok: true } | { ok: false; reason: string } {
  const b = budget()
  if (!b.allowed) {
    log(`budget: research declined — ${b.reason}`)
    return { ok: false, reason: b.reason as string }
  }
  passes.push(Date.now())
  log(
    `budget: research ${passes.length}/${MAX_RESEARCH_PER_WINDOW} this window, ` +
      `${Math.round(b.tokensUsed / 1000)}k tokens`
  )
  return { ok: true }
}

/** Releases a booking that never actually ran (deduplicated, refused early). */
export function refundResearch(): void {
  passes.pop()
}

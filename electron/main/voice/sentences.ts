/**
 * Accumulates streaming text and releases complete sentences as soon as they
 * form, so speech can begin before the model has finished generating.
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'ie',
  'approx', 'apt', 'dept', 'est', 'fig', 'inc', 'ltd', 'no', 'vol'
])

/** Text that should never be spoken aloud: code fences, paths, bare URLs. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' that link ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export class SentenceStream {
  private buf = ''

  /** Feed a chunk; returns any sentences that are now complete. */
  push(chunk: string): string[] {
    this.buf += chunk
    const out: string[] = []

    for (;;) {
      const idx = this.findBoundary(this.buf)
      if (idx < 0) break
      const sentence = this.buf.slice(0, idx + 1).trim()
      this.buf = this.buf.slice(idx + 1)
      if (sentence) out.push(sentence)
    }
    return out
  }

  /** Release whatever remains, e.g. when the turn ends without terminal punctuation. */
  flush(): string | null {
    const rest = this.buf.trim()
    this.buf = ''
    return rest || null
  }

  reset(): void {
    this.buf = ''
  }

  private findBoundary(s: string): number {
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c !== '.' && c !== '!' && c !== '?' && c !== '\n') continue

      // Require whitespace/end after the mark so "3.5" and "e.g." don't split.
      const next = s[i + 1]
      if (c !== '\n' && next !== undefined && !/\s/.test(next)) continue

      if (c === '.') {
        const before = s.slice(Math.max(0, i - 12), i)
        const word = before.match(/([A-Za-z]+)$/)?.[1]?.toLowerCase()
        if (word && ABBREVIATIONS.has(word)) continue
        // Decimal or version numbers: digit "." digit
        if (/\d$/.test(before) && next !== undefined && /\d/.test(next)) continue
        // Single initial, e.g. "J. Smith"
        if (word && word.length === 1) continue
      }
      return i
    }
    return -1
  }
}

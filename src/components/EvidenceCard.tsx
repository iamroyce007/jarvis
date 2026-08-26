import { useState } from 'react'
import type { BriefingSource, ExplainSource } from '../../shared/types'

/**
 * A holographic evidence card — a floating glass panel showing a source.
 *
 * This is NOT a tiny citation at the bottom. It is a beautiful, cinematic
 * representation of the supporting evidence: article image, headline,
 * publication, date, verification status. It should feel like a transparent
 * display floating in space.
 */

interface ArticleCardProps {
  source: BriefingSource
  /** Optional: why this source matters in the current context */
  relevance?: string
  size?: 'normal' | 'compact' | 'large'
}

export function ArticleEvidenceCard({ source, relevance, size = 'normal' }: ArticleCardProps) {
  const [broken, setBroken] = useState(false)

  return (
    <a
      className={`ev glass ev-${size}`}
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={source.url}
    >
      <div className="ev-visual">
        {source.image && !broken ? (
          <img src={source.image} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <div className="ev-fallback">
            <span>{(source.publisher || source.domain).slice(0, 2).toUpperCase()}</span>
          </div>
        )}
        <div className="ev-badge-wrap">
          <span className={`ev-badge ${source.reachable ? 'ok' : 'bad'}`}>
            {source.reachable ? 'VERIFIED' : 'UNVERIFIED'}
          </span>
        </div>
      </div>
      <div className="ev-body">
        <div className="ev-headline">{source.title}</div>
        <div className="ev-pub">
          <span className="ev-pub-name">{source.publisher || source.domain}</span>
          {source.date ? <span className="ev-pub-date">{source.date}</span> : null}
        </div>
        {relevance ? <div className="ev-relevance">{relevance}</div> : null}
        <div className="ev-action">OPEN SOURCE →</div>
      </div>
    </a>
  )
}

/** Lightweight source chip for inline citation */
interface SourceChipProps {
  source: BriefingSource | ExplainSource
}

export function SourceChip({ source }: SourceChipProps) {
  const reachable = 'reachable' in source ? source.reachable !== false : true
  const pub = 'publisher' in source ? source.publisher : ('domain' in source ? (source as BriefingSource).domain : '')

  return (
    <a
      className="src-chip"
      href={source.url}
      target="_blank"
      rel="noreferrer"
    >
      <span className={`src-dot ${reachable ? 'ok' : 'bad'}`} />
      <span className="src-name">{pub}</span>
    </a>
  )
}

/** Source strip — a row of source chips */
export function SourceStrip({ sources }: { sources: (BriefingSource | ExplainSource)[] }) {
  if (!sources.length) return null
  return (
    <div className="src-strip">
      {sources.map((s) => (
        <SourceChip key={s.id} source={s} />
      ))}
    </div>
  )
}

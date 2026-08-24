import { useEffect, useRef, useState } from 'react'
import type { Briefing, BriefingSource } from '../../shared/types'
import { ConfidenceChip } from './EntityPanel'

/**
 * Intelligence briefing storyboard.
 *
 * Sections reveal in sequence rather than appearing at once, so the briefing
 * reads as something being delivered rather than a wall of text. Every section,
 * claim and timeline entry shows its confidence and the source clips backing
 * it; clicking a section highlights exactly which sources support it, which is
 * the visual answer to "why do you believe this?".
 *
 * Source clips are link previews — title, publisher, and the page's own
 * OpenGraph image — each marked verified only if JARVIS actually fetched it.
 */

interface Props {
  briefing: Briefing
  stage: string | null
  onClose: () => void
}

export function BriefingView({ briefing, stage, onClose }: Props) {
  const [revealed, setRevealed] = useState(0)
  const [activeSection, setActiveSection] = useState<number | null>(null)
  const [tab, setTab] = useState<'briefing' | 'timeline' | 'sources'>('briefing')
  const timers = useRef<number[]>([])

  // Staggered reveal. Cleared on unmount so a closed briefing cannot keep
  // firing timers against a dead component.
  useEffect(() => {
    setRevealed(0)
    timers.current.forEach(clearTimeout)
    timers.current = []
    const total = briefing.sections.length
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      setRevealed(total)
      return
    }
    for (let i = 1; i <= total; i++) {
      timers.current.push(window.setTimeout(() => setRevealed(i), i * 340))
    }
    return () => timers.current.forEach(clearTimeout)
  }, [briefing.id, briefing.sections.length])

  const sourcesFor = (idx: number[]): BriefingSource[] =>
    idx.map((i) => briefing.sources[i]).filter(Boolean)

  const highlighted =
    activeSection !== null ? new Set(briefing.sections[activeSection]?.sources ?? []) : null

  if (briefing.failure) {
    return (
      <div className="holo brief">
        <div className="holo-head">
          <span>BRIEFING — FAILED</span>
          <span className="act" onClick={onClose}>close</span>
        </div>
        <div className="holo-body">
          <div className="brief-fail">
            <div className="brief-fail-title">Could not brief on “{briefing.subject}”</div>
            <div className="brief-fail-why">{briefing.failure}</div>
          </div>
        </div>
      </div>
    )
  }

  const verified = briefing.sources.filter((s) => s.reachable).length

  return (
    <div className="holo brief">
      <div className="holo-head">
        <span>
          BRIEFING · {briefing.kind.toUpperCase()}
          {stage ? ` · ${stage.toUpperCase()}…` : ''}
        </span>
        <span style={{ display: 'flex', gap: 10 }}>
          <span className="muted">
            {verified}/{briefing.sources.length} verified
          </span>
          <span className="act" onClick={onClose}>close</span>
        </span>
      </div>

      <div className="brief-head">
        <div className="brief-headline">{briefing.headline}</div>
        {briefing.summary ? <div className="brief-summary">{briefing.summary}</div> : null}
      </div>

      <div className="brief-tabs">
        {(['briefing', 'timeline', 'sources'] as const).map((t) => (
          <button
            key={t}
            className={`brief-tab ${tab === t ? 'on' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
            {t === 'timeline' && briefing.timeline.length ? ` · ${briefing.timeline.length}` : ''}
            {t === 'sources' && briefing.sources.length ? ` · ${briefing.sources.length}` : ''}
          </button>
        ))}
      </div>

      <div className="holo-body brief-body">
        {/* ------------------------------------------------------- briefing */}
        {tab === 'briefing' ? (
          <>
            {briefing.sections.map((s, i) => (
              <section
                key={i}
                className={`brief-section ${i < revealed ? 'in' : ''} ${
                  activeSection === i ? 'active' : ''
                }`}
                onClick={() => setActiveSection(activeSection === i ? null : i)}
              >
                <div className="brief-section-head">
                  <span className="brief-section-title">{s.title}</span>
                  <ConfidenceChip level={s.confidence} />
                </div>
                <p className="brief-section-body">{s.body}</p>

                {s.sources.length ? (
                  <div className="clip-strip">
                    {sourcesFor(s.sources).map((src) => (
                      <SourceClip key={src.id} source={src} compact />
                    ))}
                  </div>
                ) : (
                  <div className="brief-nosrc">No source cited — treat as inference.</div>
                )}
              </section>
            ))}

            {briefing.claims.length ? (
              <section className={`brief-section ${revealed >= briefing.sections.length ? 'in' : ''}`}>
                <div className="brief-section-head">
                  <span className="brief-section-title">Key claims</span>
                </div>
                {briefing.claims.map((c, i) => (
                  <div key={i} className="claim">
                    <ConfidenceChip level={c.confidence} />
                    <div className="claim-text">
                      {c.statement}
                      {c.sources.length ? (
                        <span className="claim-cites">
                          {c.sources.map((n) => (
                            <span key={n} className="cite" title={briefing.sources[n]?.domain}>
                              {n + 1}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </section>
            ) : null}

            {briefing.openQuestions.length ? (
              <section className={`brief-section open-q ${revealed >= briefing.sections.length ? 'in' : ''}`}>
                <div className="brief-section-head">
                  <span className="brief-section-title">Open questions</span>
                </div>
                {briefing.openQuestions.map((q, i) => (
                  <div key={i} className="open-question">
                    <span className="q-mark">?</span>
                    {q}
                  </div>
                ))}
              </section>
            ) : null}
          </>
        ) : null}

        {/* ------------------------------------------------------- timeline */}
        {tab === 'timeline' ? (
          briefing.timeline.length === 0 ? (
            <div className="empty">No dated events found.</div>
          ) : (
            <div className="tl">
              {briefing.timeline.map((t, i) => (
                <div key={i} className="tl-item" style={{ animationDelay: `${i * 60}ms` }}>
                  <div className="tl-spine">
                    <span className="tl-dot" />
                  </div>
                  <div className="tl-content">
                    <div className="tl-date">{t.date}</div>
                    <div className="tl-label">{t.label}</div>
                    {t.detail ? <div className="tl-detail">{t.detail}</div> : null}
                    <div className="tl-meta">
                      <ConfidenceChip level={t.confidence} />
                      {sourcesFor(t.sources).map((s) => (
                        <a
                          key={s.id}
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="tl-src"
                        >
                          {s.domain}
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : null}

        {/* -------------------------------------------------------- sources */}
        {tab === 'sources' ? (
          briefing.sources.length === 0 ? (
            <div className="empty">
              No sources were found. Everything above is unverified.
            </div>
          ) : (
            <div className="clip-grid">
              {briefing.sources.map((s) => (
                <SourceClip
                  key={s.id}
                  source={s}
                  dim={highlighted ? !highlighted.has(s.id) : false}
                />
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  )
}

/**
 * A source clip: the page's own preview image, publisher, and whether JARVIS
 * could actually reach it. Unreachable sources are shown, not hidden — a
 * citation that cannot be opened is information the user needs.
 */
function SourceClip({
  source,
  compact = false,
  dim = false
}: {
  source: BriefingSource
  compact?: boolean
  dim?: boolean
}) {
  const [broken, setBroken] = useState(false)
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className={`clip ${compact ? 'compact' : ''} ${dim ? 'dim' : ''}`}
      title={source.url}
    >
      <div className="clip-frame">
        {source.image && !broken ? (
          <img src={source.image} alt="" onError={() => setBroken(true)} loading="lazy" />
        ) : (
          <div className="clip-fallback">{source.domain.slice(0, 2).toUpperCase()}</div>
        )}
        <span className={`clip-badge ${source.reachable ? 'ok' : 'bad'}`}>
          {source.reachable ? 'VERIFIED' : 'UNVERIFIED'}
        </span>
      </div>
      <div className="clip-meta">
        <div className="clip-title">{source.title}</div>
        <div className="clip-sub">
          {source.publisher || source.domain}
          {source.date ? ` · ${source.date}` : ''}
        </div>
      </div>
    </a>
  )
}

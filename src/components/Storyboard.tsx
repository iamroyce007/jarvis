import { useEffect, useRef, useState } from 'react'
import type { Briefing, BriefingFrame, BriefingSource } from '../../shared/types'
import { ArticleEvidenceCard, SourceStrip as SourceStripNew } from './EvidenceCard'

/**
 * The storyboard: JARVIS assembling an answer visually.
 *
 * One frame occupies the stage at a time. The media is the primary object —
 * a photograph fills the frame, the narration sits over it, and the supporting
 * evidence is secondary. Everything not currently being explained recedes.
 *
 * Frame *kind* is chosen upstream by the model, not here; this component's job
 * is to honour that choice with the right composition, and to make provenance
 * unavoidable — every image is credited, every claim carries its confidence.
 */

interface Props {
  briefing: Briefing
  stage: string | null
  onClose: () => void
  /** Investigate an entity mentioned in a frame. */
  onInvestigate?: (subject: string) => void
}

export function Storyboard({ briefing, stage, onClose, onInvestigate }: Props) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [showEvidence, setShowEvidence] = useState(false)
  const timer = useRef<number | null>(null)

  const frames = briefing.frames.length > 0 ? briefing.frames : synthesizeFrames(briefing)
  const frame = frames[Math.min(index, frames.length - 1)]

  // Auto-advance paces the story like a briefing being delivered. Reading
  // time scales with narration length so dense frames are not cut short.
  useEffect(() => {
    if (!playing || !frame) return
    const words = frame.narration.split(/\s+/).length
    const dwell = Math.max(5200, Math.min(14000, words * 380))
    timer.current = window.setTimeout(() => {
      setIndex((i) => (i + 1 < frames.length ? i + 1 : i))
    }, dwell)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [index, playing, frames.length, frame])

  // Arrow keys drive the story; Escape is reserved for the global halt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') {
        setPlaying(false)
        setIndex((i) => Math.min(i + 1, frames.length - 1))
      }
      if (e.key === 'ArrowLeft') {
        setPlaying(false)
        setIndex((i) => Math.max(i - 1, 0))
      }
      if (e.key === ' ') {
        e.preventDefault()
        setPlaying((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [frames.length])

  useEffect(() => {
    setIndex(0)
    setPlaying(true)
  }, [briefing.id])

  const srcs = (ids: number[]): BriefingSource[] =>
    ids.map((i) => briefing.sources[i]).filter(Boolean)

  if (briefing.failure) {
    return (
      <div className="sb sb-fail">
        <div className="sb-fail-inner">
          <div className="sb-fail-title">Could not brief on “{briefing.subject}”</div>
          <div className="sb-fail-why">{briefing.failure}</div>
          <button className="sb-btn" onClick={onClose}>Dismiss</button>
        </div>
      </div>
    )
  }

  if (!frame) {
    return (
      <div className="sb sb-loading">
        <div className="sb-loading-subject">{briefing.subject}</div>
        <div className="sb-loading-stage">{stage ?? 'Assembling'}…</div>
      </div>
    )
  }

  return (
    <div className="sb">
      {/* Background plate: the frame's own image, heavily dimmed for depth. */}
      {frame.media?.image ? (
        <div
          className="sb-plate"
          key={`plate-${index}`}
          style={{ backgroundImage: `url(${frame.media.image})` }}
        />
      ) : briefing.hero?.image ? (
        <div className="sb-plate faint" style={{ backgroundImage: `url(${briefing.hero.image})` }} />
      ) : null}
      <div className="sb-veil" />

      <header className="sb-top">
        <div className="sb-subject">
          <span className="sb-kind">{briefing.kind}</span>
          {briefing.headline}
        </div>
        <div className="sb-top-right">
          {stage ? <span className="sb-stage">{stage}…</span> : null}
          <span className="sb-verified">
            {briefing.sources.filter((s) => s.reachable).length}/{briefing.sources.length} verified
          </span>
          <button className="sb-x" onClick={onClose} aria-label="Close briefing">✕</button>
        </div>
      </header>

      <div className="sb-frame" key={index}>
        <FrameBody frame={frame} sources={srcs(frame.sources)} onInvestigate={onInvestigate} briefing={briefing} />
      </div>

      <footer className="sb-bottom">
        <div className="sb-progress">
          {frames.map((f, i) => (
            <button
              key={i}
              className={`sb-tick ${i === index ? 'on' : ''} ${i < index ? 'past' : ''}`}
              onClick={() => {
                setPlaying(false)
                setIndex(i)
              }}
              title={`${f.kind} — ${f.title}`}
              aria-label={`Frame ${i + 1}: ${f.title}`}
            />
          ))}
        </div>

        <div className="sb-controls">
          <button className="sb-btn ghost" onClick={() => setPlaying((p) => !p)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            className="sb-btn ghost"
            onClick={() => {
              setPlaying(false)
              setShowEvidence((s) => !s)
            }}
          >
            {showEvidence ? 'Hide evidence' : 'Show evidence'}
          </button>
          <span className="sb-count">
            {index + 1} / {frames.length}
          </span>
        </div>
      </footer>

      {showEvidence ? (
        <div className="sb-evidence" onClick={() => setShowEvidence(false)}>
          <div className="sb-evidence-inner" onClick={(e) => e.stopPropagation()}>
            <div className="sb-evidence-head">
              Sources · {briefing.sources.filter((s) => s.reachable).length} of{' '}
              {briefing.sources.length} verified
            </div>
            <div className="sb-evidence-grid">
              {briefing.sources.map((s) => (
                <SourceCard key={s.id} source={s} />
              ))}
            </div>
            {briefing.openQuestions.length ? (
              <>
                <div className="sb-evidence-head">Still unresolved</div>
                {briefing.openQuestions.map((q, i) => (
                  <div key={i} className="sb-openq">{q}</div>
                ))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Composition per frame kind. This is where the director's choice is honoured. */
function FrameBody({
  frame,
  sources,
  briefing,
  onInvestigate
}: {
  frame: BriefingFrame
  sources: BriefingSource[]
  briefing: Briefing
  onInvestigate?: (subject: string) => void
}) {
  const conf = <span className={`sb-conf conf-${frame.confidence}`}>{frame.confidence}</span>

  switch (frame.kind) {
    case 'hero':
      return (
        <div className="f-hero">
          {frame.media?.image ? (
            <figure className="f-hero-media">
              <img src={frame.media.image} alt={frame.title} />
              <figcaption>{frame.media.credit}</figcaption>
            </figure>
          ) : null}
          <div className="f-hero-text">
            <h1>{frame.title}</h1>
            <p>{frame.narration}</p>
            <div className="f-meta">{conf}</div>
          </div>
        </div>
      )

    case 'portrait':
    case 'place':
      return (
        <div className="f-portrait">
          <figure className="f-portrait-media">
            {frame.media?.image ? (
              <img src={frame.media.image} alt={frame.title} />
            ) : (
              <div className="f-noimg">No free image available</div>
            )}
            {frame.media?.credit ? <figcaption>{frame.media.credit}</figcaption> : null}
          </figure>
          <div className="f-portrait-text">
            <div className="f-eyebrow">{frame.kind === 'portrait' ? 'Person' : 'Location'}</div>
            <h2>{frame.title}</h2>
            {frame.role ? <div className="f-role">{frame.role}</div> : null}
            <p>{frame.narration}</p>
            <div className="f-meta">
              {conf}
              {frame.subject && onInvestigate ? (
                <button className="sb-btn tiny" onClick={() => onInvestigate(frame.subject as string)}>
                  Investigate
                </button>
              ) : null}
            </div>
            <SourceStrip sources={sources} />
          </div>
        </div>
      )

    case 'conflict':
      return (
        <div className="f-conflict">
          <div className="f-eyebrow warn">Sources disagree</div>
          <h2>{frame.title}</h2>
          <p className="f-lead">{frame.narration}</p>
          <div className="f-sides">
            {(frame.sides ?? []).map((side, i) => {
              const s = briefing.sources[side.source]
              return (
                <div key={i} className="f-side">
                  <div className="f-side-claim">{side.claim}</div>
                  {s ? (
                    <a className="f-side-src" href={s.url} target="_blank" rel="noreferrer">
                      {s.publisher || s.domain}
                      <span className={`sb-dot ${s.reachable ? 'ok' : 'bad'}`} />
                    </a>
                  ) : null}
                </div>
              )
            })}
          </div>
          <div className="f-unresolved">
            No source resolves this. Both accounts are shown as reported.
          </div>
        </div>
      )

    case 'stat':
      return (
        <div className="f-stat">
          <div className="f-stat-value">{frame.value}</div>
          {frame.unit ? <div className="f-stat-unit">{frame.unit}</div> : null}
          <h2>{frame.title}</h2>
          <p>{frame.narration}</p>
          <div className="f-meta">{conf}</div>
          <SourceStrip sources={sources} />
        </div>
      )

    case 'quote':
      return (
        <div className="f-quote">
          <blockquote>{frame.quote || frame.narration}</blockquote>
          {frame.attribution ? <cite>— {frame.attribution}</cite> : null}
          <div className="f-meta">{conf}</div>
          <SourceStrip sources={sources} />
        </div>
      )

    case 'timeline':
      return (
        <div className="f-timeline">
          <h2>{frame.title}</h2>
          <p className="f-lead">{frame.narration}</p>
          <div className="f-tl">
            {briefing.timeline.map((t, i) => (
              <div key={i} className="f-tl-item" style={{ animationDelay: `${i * 70}ms` }}>
                <div className="f-tl-date">{t.date}</div>
                <div className="f-tl-rail"><span /></div>
                <div className="f-tl-body">
                  <div className="f-tl-label">{t.label}</div>
                  {t.detail ? <div className="f-tl-detail">{t.detail}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )

    case 'conclusion':
      return (
        <div className="f-conclusion">
          <div className="f-eyebrow">Assessment</div>
          <h2>{frame.title}</h2>
          <p className="f-lead">{frame.narration}</p>
          <div className="f-meta">{conf}</div>
          {briefing.openQuestions.length ? (
            <div className="f-open">
              <div className="f-open-head">Still unresolved</div>
              {briefing.openQuestions.map((q, i) => (
                <div key={i} className="f-open-item">{q}</div>
              ))}
            </div>
          ) : null}
        </div>
      )

    default:
      return (
        <div className="f-evidence">
          <h2>{frame.title}</h2>
          <p className="f-lead">{frame.narration}</p>
          <div className="f-meta">{conf}</div>
          <div className="f-cards">
            {sources.map((s) => (
              <SourceCard key={s.id} source={s} />
            ))}
          </div>
          {sources.length === 0 ? (
            <div className="f-nosrc">No source cited for this — treat as inference.</div>
          ) : null}
        </div>
      )
  }
}

function SourceStrip({ sources }: { sources: BriefingSource[] }) {
  if (sources.length === 0) return null
  return <SourceStripNew sources={sources} />
}

function SourceCard({ source }: { source: BriefingSource }) {
  return <ArticleEvidenceCard source={source} size="compact" />
}

/**
 * Fallback storyboard for briefings produced before the director existed, so
 * older saved briefings still render as a story rather than failing.
 */
function synthesizeFrames(b: Briefing): BriefingFrame[] {
  const frames: BriefingFrame[] = [
    {
      kind: 'hero',
      title: b.headline,
      narration: b.summary,
      confidence: 'reported',
      sources: [],
      media: b.hero ?? undefined
    }
  ]
  for (const s of b.sections) {
    frames.push({
      kind: 'evidence',
      title: s.title,
      narration: s.body,
      confidence: s.confidence,
      sources: s.sources
    })
  }
  if (b.timeline.length) {
    frames.push({
      kind: 'timeline',
      title: 'How it unfolded',
      narration: '',
      confidence: 'reported',
      sources: []
    })
  }
  return frames
}

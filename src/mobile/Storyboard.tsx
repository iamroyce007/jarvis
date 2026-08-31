import { useEffect, useRef, useState, useCallback } from 'react'
import type { Explanation, ExplainFrame, ExplainSource } from '../../shared/types'

/**
 * The investigation, on a phone.
 *
 * The desktop composes a frame spatially — photograph, evidence and chronology
 * arranged in one view. There is no room for that here, so the same frames run
 * vertically instead: one at a time, full-bleed, advanced by swipe. The story
 * is identical; only its arrangement in space changes.
 *
 * Each frame answers the four questions the interface must always answer:
 * what am I looking at, why does it matter, what proves it, what connects.
 */

interface Props {
  story: Explanation
  onAsk: (text: string) => void
  onClose: () => void
  /** Narration for the frame the user just arrived at. */
  onNarrate?: (text: string) => void
}

const CONFIDENCE_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  corroborated: 'Corroborated',
  reported: 'Source report',
  inferred: 'Inference',
  disputed: 'Disputed',
  unknown: 'Unverified'
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default function MobileStoryboard({ story, onAsk, onClose, onNarrate }: Props): JSX.Element {
  const frames = story.frames ?? []
  const [index, setIndex] = useState(0)
  const [expanded, setExpanded] = useState<ExplainSource | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const narrated = useRef<string | null>(null)

  const frame: ExplainFrame | undefined = frames[index]

  /**
   * Snap-scroll position is the source of truth for which frame is current.
   * Deriving it from scroll rather than driving scroll from state means a
   * flick, a slow drag and a programmatic jump all agree.
   */
  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const next = Math.round(el.scrollTop / el.clientHeight)
    if (next !== index && next >= 0 && next < frames.length) setIndex(next)
  }, [index, frames.length])

  // §5/§22: JARVIS narrates the frame you arrive at, once.
  useEffect(() => {
    if (!frame || !onNarrate) return
    if (narrated.current === frame.id) return
    narrated.current = frame.id
    if (frame.narration) onNarrate(frame.narration)
  }, [frame, onNarrate])

  const go = useCallback((to: number) => {
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: to * el.clientHeight, behavior: 'smooth' })
  }, [])

  if (frames.length === 0) {
    return (
      <div className="ms-empty">
        <span>{story.failure ?? 'Assembling…'}</span>
      </div>
    )
  }

  return (
    <div className="ms">
      {/* Where you are in the story — a spine, not a progress bar. */}
      <div className="ms-spine" aria-hidden>
        {frames.map((f, i) => (
          <button
            key={f.id}
            className={`ms-tick ${i === index ? 'here' : ''} ${i < index ? 'past' : ''}`}
            onClick={() => go(i)}
          />
        ))}
      </div>

      <div className="ms-head">
        <button className="ms-back" onClick={onClose} aria-label="Back">‹</button>
        <div className="ms-head-text">
          <strong>{story.headline || story.subject}</strong>
          <span>
            {index + 1} of {frames.length}
            {story.cached ? ' · from memory' : ''}
          </span>
        </div>
      </div>

      <div className="ms-run" ref={scroller} onScroll={onScroll}>
        {frames.map((f) => (
          <Frame
            key={f.id}
            frame={f}
            sources={story.sources ?? []}
            onAsk={onAsk}
            onOpenSource={setExpanded}
          />
        ))}
      </div>

      {expanded && <SourceSheet source={expanded} onClose={() => setExpanded(null)} />}
    </div>
  )
}

/** One frame: one primary thing, narration under it, provenance beneath that. */
function Frame({
  frame,
  sources,
  onAsk,
  onOpenSource
}: {
  frame: ExplainFrame
  sources: ExplainSource[]
  onAsk: (t: string) => void
  onOpenSource: (s: ExplainSource) => void
}): JSX.Element {
  const cited = (frame.sources ?? [])
    .map((id) => sources.find((s) => s.id === id))
    .filter((s): s is ExplainSource => s !== undefined)

  return (
    <section className="ms-frame">
      {/* The depth plate: the frame's own image, blurred behind it. */}
      {frame.media?.image && (
        <div className="ms-plate" style={{ backgroundImage: `url(${frame.media.image})` }} />
      )}
      <div className="ms-veil" />

      <div className="ms-body">
        {/* §3/§8 — the photograph is the subject, shown large, never a node. */}
        {frame.media?.image && (
          <figure className="ms-photo">
            <img src={frame.media.image} alt={frame.media.caption ?? frame.title} loading="lazy" />
            {frame.media.credit && <figcaption>{frame.media.credit}</figcaption>}
          </figure>
        )}

        <div className="ms-kind">{frame.kind}</div>
        <h2 className="ms-title">{frame.title}</h2>

        {frame.value && (
          <div className="ms-value">
            {frame.value}
            {frame.unit && <em>{frame.unit}</em>}
          </div>
        )}

        {frame.quote && (
          <blockquote className="ms-quote">
            {frame.quote}
            {frame.attribution && <cite>{frame.attribution}</cite>}
          </blockquote>
        )}

        {frame.narration && <p className="ms-narration">{frame.narration}</p>}

        {frame.facts && frame.facts.length > 0 && (
          <dl className="ms-facts">
            {frame.facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {/* §11 — chronology as a spatial run, not a list of dates. */}
        {frame.timeline && frame.timeline.length > 0 && (
          <ol className="ms-time">
            {frame.timeline.map((t, i) => (
              <li key={`${t.date}-${i}`}>
                <span className="ms-time-date">{t.date}</span>
                <span className="ms-time-label">{t.label}</span>
                {t.detail && <span className="ms-time-detail">{t.detail}</span>}
              </li>
            ))}
          </ol>
        )}

        {/* §12 — a possible connection, stated as what it actually rests on. */}
        {frame.connections && frame.connections.length > 0 && (
          <div className="ms-conns">
            {frame.connections.map((c, i) => (
              <div className="ms-conn" key={i}>
                <div className="ms-conn-pair">
                  <span>{c.name}</span>
                  <em>{c.kind}</em>
                </div>
                <div className={`ms-basis ${c.basis}`}>{c.basis.replace('-', ' ')}</div>
                <p>{c.statement}</p>
                {c.via && c.via.length > 0 && (
                  <div className="ms-via">via {c.via.join(' · ')}</div>
                )}
                <div className="ms-review">Requires investigator review</div>
              </div>
            ))}
          </div>
        )}

        <div className="ms-foot">
          <span className={`ms-conf ${frame.confidence}`}>
            {CONFIDENCE_LABEL[frame.confidence] ?? frame.confidence}
          </span>
          {cited.map((s) => (
            <button key={s.id} className="ms-src" onClick={() => onOpenSource(s)}>
              {hostOf(s.url)}
            </button>
          ))}
        </div>

        {/* §14/§15 — "go deeper" and "show me", reachable by thumb as well as voice. */}
        {frame.subject && (
          <div className="ms-actions">
            <button onClick={() => onAsk(`Tell me more about ${frame.subject}`)}>Go deeper</button>
            <button onClick={() => onAsk(`Show me ${frame.subject}`)}>Show me</button>
          </div>
        )}
      </div>
    </section>
  )
}

/** §9/§13 level three: the source itself, occupying the screen. */
function SourceSheet({
  source,
  onClose
}: {
  source: ExplainSource
  onClose: () => void
}): JSX.Element {
  return (
    <div className="ms-sheet" onClick={onClose}>
      <div className="ms-sheet-body" onClick={(e) => e.stopPropagation()}>
        <div className="ms-sheet-grip" />
        <div className="ms-sheet-pub">{source.publisher || hostOf(source.url)}</div>
        <h3>{source.title}</h3>
        {source.date && <div className="ms-sheet-date">{source.date}</div>}
        <div className="ms-sheet-why">
          {source.reachable === false
            ? 'This source could not be opened when the investigation ran.'
            : 'Opened and read during this investigation.'}
        </div>
        <a className="ms-btn-wide" href={source.url} target="_blank" rel="noreferrer noopener">
          Open original
        </a>
      </div>
    </div>
  )
}

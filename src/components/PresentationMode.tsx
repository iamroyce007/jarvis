import { useState, useEffect, useRef } from 'react'
import type { Explanation, ExplainFrame } from '../../shared/types'

/**
 * JARVIS Presentation Mode.
 *
 * A structured intelligence briefing that walks through:
 * 01 — CONTEXT → 02 — WHAT HAPPENED → 03 — WHO → 04 — EVIDENCE
 * → 05 — TIMELINE → 06 — RELATED → 07 — WHAT CHANGED
 * → 08 — UNCERTAIN → 09 — DEVELOPMENTS → 10 — RECOMMENDATION
 *
 * Each stage is a full-screen cinematic frame. The user can interrupt
 * at any time with voice or click to navigate, ask follow-ups, or
 * dive deeper into any element.
 */

interface Props {
  story: Explanation
  onClose: () => void
  onInvestigate: (subject: string) => void
}

const STAGE_LABELS = [
  'CONTEXT',
  'WHAT HAPPENED',
  'WHO',
  'EVIDENCE',
  'TIMELINE',
  'RELATED',
  'WHAT CHANGED',
  'UNCERTAIN',
  'DEVELOPMENTS',
  'RECOMMENDATION'
]

export function PresentationMode({ story, onClose, onInvestigate }: Props) {
  const [frameIdx, setFrameIdx] = useState(0)
  const [playing, setPlaying] = useState(true)
  const timer = useRef<number | null>(null)

  const frames = story.frames
  const frame = frames[Math.min(frameIdx, Math.max(0, frames.length - 1))]

  // Auto-advance paced by narration length
  useEffect(() => {
    if (!playing || !frame || frames.length === 0) return
    const words = frame.narration.split(/\s+/).length
    const dwell = Math.max(6000, Math.min(18000, words * 400))
    timer.current = window.setTimeout(
      () => setFrameIdx((i) => (i + 1 < frames.length ? i + 1 : i)),
      dwell
    )
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [frameIdx, playing, frames.length, frame])

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') { setPlaying(false); setFrameIdx((i) => Math.min(i + 1, frames.length - 1)) }
      if (e.key === 'ArrowLeft') { setPlaying(false); setFrameIdx((i) => Math.max(i - 1, 0)) }
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [frames.length])

  useEffect(() => { setFrameIdx(0); setPlaying(true) }, [story.id])

  if (!frame) return null

  const stageLabel = STAGE_LABELS[frameIdx] || `STAGE ${frameIdx + 1}`
  const stageNum = String(frameIdx + 1).padStart(2, '0')

  return (
    <div className="pres">
      {/* Background plate */}
      {frame.media ? (
        <div className="pres-plate" key={frame.media.image} style={{ backgroundImage: `url(${frame.media.image})` }} />
      ) : null}
      <div className="pres-veil" />

      {/* Stage number and label */}
      <div className="pres-stage-indicator">
        <span className="pres-stage-num">{stageNum}</span>
        <span className="pres-stage-label">{stageLabel}</span>
      </div>

      {/* Content */}
      <div className="pres-content" key={frameIdx}>
        {frame.media ? (
          <figure className="pres-media">
            <img src={frame.media.image} alt={frame.title} />
            {frame.media.credit ? <figcaption>{frame.media.credit}</figcaption> : null}
          </figure>
        ) : null}

        <div className="pres-text">
          <div className="pres-eyebrow">{frame.kind === 'portrait' ? 'PERSON' : frame.kind === 'place' ? 'LOCATION' : frame.kind.toUpperCase()}</div>
          <h1 className="pres-title">{frame.title}</h1>
          {frame.role ? <div className="pres-role">{frame.role}</div> : null}
          <p className="pres-narration">{frame.narration}</p>

          {frame.facts?.length ? (
            <dl className="pres-facts">
              {frame.facts.map((f, i) => (
                <div key={i} className="pres-fact">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {frame.subject ? (
            <div className="pres-actions">
              <button className="btn" onClick={() => onInvestigate(frame.subject as string)}>
                Investigate
              </button>
            </div>
          ) : null}

          <div className="pres-conf">
            <span className={`conf conf-${frame.confidence}`}>{frame.confidence}</span>
          </div>
        </div>
      </div>

      {/* Related subjects */}
      {frameIdx === frames.length - 1 && story.relatedSubjects.length > 0 ? (
        <div className="pres-related">
          <span className="pres-related-label">INVESTIGATE NEXT</span>
          {story.relatedSubjects.map((r) => (
            <button key={r} className="btn ghost sm" onClick={() => onInvestigate(r)}>
              {r}
            </button>
          ))}
        </div>
      ) : null}

      {/* Controls */}
      <div className="pres-controls">
        <div className="pres-progress">
          {frames.map((_, i) => (
            <button
              key={i}
              className={`pres-tick ${i === frameIdx ? 'on' : ''} ${i < frameIdx ? 'past' : ''}`}
              onClick={() => { setPlaying(false); setFrameIdx(i) }}
            />
          ))}
        </div>
        <div className="pres-btns">
          <button className="bar-btn" onClick={() => setPlaying((p) => !p)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <span className="pres-counter">{stageNum}/{String(frames.length).padStart(2, '0')}</span>
          <button className="bar-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

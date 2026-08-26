import { useEffect, useRef, useState } from 'react'
import type { Explanation, ExplainFrame, ExplainSource } from '../../shared/types'

/**
 * The assembled explanation.
 *
 * An information surface first and a picture frame second: every frame leads
 * with what is actually known — dates, numbers, roles, disagreements — and the
 * photograph supports it. Frames arrive as text and their imagery streams in
 * afterwards, so the story is readable before it is illustrated.
 */

interface Props {
  story: Explanation
  onClose: () => void
  onInvestigate: (subject: string) => void
}

export function StoryView({ story, onClose, onInvestigate }: Props) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [showSources, setShowSources] = useState(false)
  const timer = useRef<number | null>(null)

  const frames = story.frames
  const frame = frames[Math.min(index, Math.max(0, frames.length - 1))]

  // Auto-advance paced by how much there is to read on each frame.
  useEffect(() => {
    if (!playing || !frame || frames.length === 0) return
    const words = (frame.narration + (frame.facts?.map((f) => f.value).join(' ') ?? '')).split(/\s+/).length
    const dwell = Math.max(5000, Math.min(15000, words * 360))
    timer.current = window.setTimeout(
      () => setIndex((i) => (i + 1 < frames.length ? i + 1 : i)),
      dwell
    )
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [index, playing, frames.length, frame])

  useEffect(() => {
    setIndex(0)
    setPlaying(true)
  }, [story.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') { setPlaying(false); setIndex((i) => Math.min(i + 1, frames.length - 1)) }
      if (e.key === 'ArrowLeft') { setPlaying(false); setIndex((i) => Math.max(i - 1, 0)) }
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [frames.length])

  if (story.failure) {
    return (
      <div className="st st-fail">
        <div className="st-fail-title">Couldn’t assemble “{story.subject}”</div>
        <div className="st-fail-why">{story.failure}</div>
        <button className="sb-btn ghost" onClick={onClose}>Close</button>
      </div>
    )
  }

  if (!frame) {
    return (
      <div className="st st-fail">
        <div className="st-fail-title">{story.headline}</div>
        <div className="st-fail-why">{story.summary}</div>
        <button className="sb-btn ghost" onClick={onClose}>Close</button>
      </div>
    )
  }

  const srcs = frame.sources.map((i) => story.sources[i]).filter(Boolean)

  return (
    <div className="st">
      {frame.media ? (
        <div className="st-plate" key={frame.media.image} style={{ backgroundImage: `url(${frame.media.image})` }} />
      ) : null}
      <div className="st-veil" />

      <header className="st-top">
        <div className="st-head">
          <span className="st-kind">{story.kind}</span>
          {story.provisional ? (
            <span className="st-prov" title="From memory — sources are still being checked">
              unverified
            </span>
          ) : null}
          <span className="st-headline">{story.headline}</span>
        </div>
        <div className="st-top-right">
          {story.sources.length ? (
            <button className="bar-btn" onClick={() => setShowSources((s) => !s)}>
              {story.sources.length} sources
            </button>
          ) : (
            <span className="st-checking">checking sources…</span>
          )}
          <button className="bar-btn" onClick={onClose}>Close</button>
        </div>
      </header>

      <div className="st-frame" key={frame.id}>
        <FrameView frame={frame} sources={srcs} story={story} onInvestigate={onInvestigate} />
      </div>

      <footer className="st-bottom">
        <div className="st-ticks">
          {frames.map((f, i) => (
            <button
              key={f.id}
              className={`st-tick ${i === index ? 'on' : ''} ${i < index ? 'past' : ''}`}
              onClick={() => { setPlaying(false); setIndex(i) }}
              title={`${f.kind} — ${f.title}`}
            />
          ))}
        </div>
        <div className="st-controls">
          <button className="bar-btn" onClick={() => setPlaying((p) => !p)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <span className="st-count">{index + 1}/{frames.length}</span>
        </div>
      </footer>

      {showSources ? (
        <div className="st-sources" onClick={() => setShowSources(false)}>
          <div className="st-sources-inner" onClick={(e) => e.stopPropagation()}>
            <div className="st-label">Sources</div>
            {story.sources.map((s) => (
              <a key={s.id} className="st-source" href={s.url} target="_blank" rel="noreferrer">
                <span className={`st-dot ${s.reachable === false ? 'bad' : 'ok'}`} />
                <span className="st-source-pub">{s.publisher}</span>
                <span className="st-source-title">{s.title}</span>
              </a>
            ))}
            {story.openQuestions.length ? (
              <>
                <div className="st-label">Still unresolved</div>
                {story.openQuestions.map((q, i) => (
                  <div key={i} className="st-openq">{q}</div>
                ))}
              </>
            ) : null}
            {story.relatedSubjects.length ? (
              <>
                <div className="st-label">Worth investigating next</div>
                <div className="st-related">
                  {story.relatedSubjects.map((r) => (
                    <button key={r} className="sb-btn ghost" onClick={() => onInvestigate(r)}>{r}</button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function FrameView({
  frame,
  sources,
  story,
  onInvestigate
}: {
  frame: ExplainFrame
  sources: ExplainSource[]
  story: Explanation
  onInvestigate: (s: string) => void
}) {
  const conf = <span className={`conf conf-${frame.confidence}`}>{frame.confidence}</span>
  const photo = frame.media ? (
    <figure className="st-photo">
      <img src={frame.media.image} alt={frame.title} />
      <figcaption>
        {frame.media.caption ? <span className="st-cap">{frame.media.caption}</span> : null}
        {frame.media.credit}
      </figcaption>
    </figure>
  ) : null

  switch (frame.kind) {
    // The quick-reference panel: this is the "information powerhouse" frame.
    case 'facts': {
      const facts = frame.facts?.length ? frame.facts : story.facts
      return (
        <div className="st-split">
          {photo}
          <div className="st-body">
            <h2>{frame.title || 'Key facts'}</h2>
            <p className="st-lead">{frame.narration}</p>
            <dl className="st-facts">
              {facts.map((f, i) => (
                <div key={i} className="st-fact">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            <SourceLine sources={sources} extra={conf} />
          </div>
        </div>
      )
    }

    case 'hero':
      return (
        <div className="st-split">
          {photo}
          <div className="st-body">
            <h1>{frame.title}</h1>
            <p className="st-lead">{frame.narration}</p>
            {story.facts.length ? (
              <dl className="st-facts tight">
                {story.facts.slice(0, 4).map((f, i) => (
                  <div key={i} className="st-fact">
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <SourceLine sources={sources} extra={conf} />
          </div>
        </div>
      )

    case 'portrait':
    case 'place':
      return (
        <div className="st-split">
          {photo}
          <div className="st-body">
            <div className="st-eyebrow">{frame.kind === 'portrait' ? 'Person' : 'Location'}</div>
            <h2>{frame.title}</h2>
            {frame.role ? <div className="st-role">{frame.role}</div> : null}
            <p>{frame.narration}</p>
            {frame.facts?.length ? (
              <dl className="st-facts tight">
                {frame.facts.map((f, i) => (
                  <div key={i} className="st-fact">
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <div className="st-actions">
              {frame.subject ? (
                <button className="sb-btn ghost" onClick={() => onInvestigate(frame.subject as string)}>
                  Investigate
                </button>
              ) : null}
            </div>
            <SourceLine sources={sources} extra={conf} />
          </div>
        </div>
      )

    case 'conflict':
      return (
        <div className="st-wide">
          <div className="st-eyebrow warn">Sources disagree</div>
          <h2>{frame.title}</h2>
          <p className="st-lead">{frame.narration}</p>
          <div className="st-sides">
            {(frame.sides ?? []).map((side, i) => {
              const s = story.sources[side.source]
              return (
                <div key={i} className="st-side">
                  <div className="st-side-claim">{side.claim}</div>
                  {s ? (
                    <a className="st-side-src" href={s.url} target="_blank" rel="noreferrer">
                      {s.publisher}
                    </a>
                  ) : null}
                </div>
              )
            })}
          </div>
          <div className="st-unresolved">No source resolves this. Both are shown as reported.</div>
        </div>
      )

    case 'stat':
      return (
        <div className="st-split">
          {photo}
          <div className="st-body">
            <div className="st-statv">{frame.value}</div>
            {frame.unit ? <div className="st-statu">{frame.unit}</div> : null}
            <h2>{frame.title}</h2>
            <p>{frame.narration}</p>
            <SourceLine sources={sources} extra={conf} />
          </div>
        </div>
      )

    case 'quote':
      return (
        <div className="st-wide">
          <blockquote className="st-quote">{frame.quote || frame.narration}</blockquote>
          {frame.attribution ? <cite className="st-cite">— {frame.attribution}</cite> : null}
          <SourceLine sources={sources} extra={conf} />
        </div>
      )

    case 'timeline':
      return (
        <div className="st-wide">
          <h2>{frame.title}</h2>
          <p className="st-lead">{frame.narration}</p>
          <div className="st-tl">
            {(frame.timeline ?? []).map((t, i) => (
              <div key={i} className="st-tl-row" style={{ animationDelay: `${i * 60}ms` }}>
                <div className="st-tl-date">{t.date}</div>
                <div className="st-tl-rail"><span /></div>
                <div>
                  <div className="st-tl-label">{t.label}</div>
                  {t.detail ? <div className="st-tl-detail">{t.detail}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )

    case 'conclusion':
      return (
        <div className="st-wide">
          <div className="st-eyebrow">Assessment</div>
          <h2>{frame.title}</h2>
          <p className="st-lead">{frame.narration}</p>
          {story.openQuestions.length ? (
            <div className="st-open">
              <div className="st-label">Still unresolved</div>
              {story.openQuestions.map((q, i) => (
                <div key={i} className="st-openq">{q}</div>
              ))}
            </div>
          ) : null}
          <SourceLine sources={sources} extra={conf} />
        </div>
      )

    default:
      return (
        <div className={photo ? 'st-split' : 'st-wide'}>
          {photo}
          <div className="st-body">
            <h2>{frame.title}</h2>
            <p className="st-lead">{frame.narration}</p>
            {frame.facts?.length ? (
              <dl className="st-facts tight">
                {frame.facts.map((f, i) => (
                  <div key={i} className="st-fact">
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <SourceLine sources={sources} extra={conf} />
          </div>
        </div>
      )
  }
}

function SourceLine({ sources, extra }: { sources: ExplainSource[]; extra: React.ReactNode }) {
  return (
    <div className="st-srcline">
      {extra}
      {sources.map((s) => (
        <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="st-srcchip">
          {s.publisher}
        </a>
      ))}
      {sources.length === 0 ? <span className="st-nosrc">no source cited</span> : null}
    </div>
  )
}

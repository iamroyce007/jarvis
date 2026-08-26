import type { Spotlight } from '../../shared/types'

/**
 * One object, centre stage.
 *
 * This is what "show me" produces: the photograph dominates, the text is
 * secondary, and provenance sits underneath the image where it cannot be
 * mistaken for JARVIS's own material. Other publishers' imagery is offered as
 * a single quiet strip, not a grid — the hierarchy has to survive.
 */

interface Props {
  spotlight: Spotlight
  onClose: () => void
  onBrief: (subject: string) => void
}

export function SpotlightView({ spotlight: s, onClose, onBrief }: Props) {
  if (!s.image) {
    return (
      <div className="sp">
        <div className="sp-empty">
          <div className="sp-empty-title">Nothing to show for “{s.subject}”</div>
          <div className="sp-empty-why">{s.failure}</div>
          {s.extract ? <p className="sp-text">{s.extract}</p> : null}
          <button className="sb-btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="sp">
      <figure className="sp-photo">
        <img src={s.image} alt={s.title ?? s.subject} />
        <figcaption>
          {s.credit}
          {s.sourceUrl ? (
            <>
              {' · '}
              <a href={s.sourceUrl} target="_blank" rel="noreferrer">open source</a>
            </>
          ) : null}
        </figcaption>
      </figure>

      <div className="sp-side">
        <h1 className="sp-name">{s.subject}</h1>
        {s.description ? <div className="sp-role">{s.description}</div> : null}
        {s.extract ? <p className="sp-text">{s.extract}</p> : null}

        <div className="sp-actions">
          <button className="sb-btn" onClick={() => onBrief(s.subject)}>Full briefing</button>
          <button className="sb-btn ghost" onClick={onClose}>Close</button>
        </div>

        {s.gallery.length ? (
          <div className="sp-strip">
            {s.gallery.slice(0, 5).map((g) => (
              <a key={g.url} href={g.pageUrl} target="_blank" rel="noreferrer" className="sp-thumb">
                <img src={g.url} alt="" loading="lazy" />
                <span>{g.publisher}</span>
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

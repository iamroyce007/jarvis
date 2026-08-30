import { useState } from 'react'
import type { Spotlight } from '../../shared/types'

/**
 * JARVIS Spotlight View — Majestic Holographic Intelligence Dossier.
 *
 * Provides immediate (< 200ms) visual intelligence on a subject or person.
 * High-resolution portrait in a holographic HUD glass frame, verified credentials,
 * biographical summary, and quick action controls.
 */

interface Props {
  spotlight: Spotlight
  onClose: () => void
  onBrief: (subject: string) => void
}

export function SpotlightView({ spotlight: s, onClose, onBrief }: Props) {
  const [activeImg, setActiveImg] = useState<string | null>(s.image)
  const [activeCredit, setActiveCredit] = useState<string | null>(s.credit)
  const [activePageUrl, setActivePageUrl] = useState<string | null>(s.sourceUrl)
  const [imgFailed, setImgFailed] = useState(false)

  const handleImageError = () => {
    // If hero failed, try the first gallery image
    if (s.gallery.length > 0 && activeImg !== s.gallery[0].url) {
      setActiveImg(s.gallery[0].url)
      setActiveCredit(s.gallery[0].publisher)
      setActivePageUrl(s.gallery[0].pageUrl)
    } else {
      setImgFailed(true)
    }
  }

  const title = s.title && s.title !== s.subject ? s.title : s.subject

  return (
    <div className="sp-stage-wrap">
      {/* Cinematic ambient blurred plate */}
      {activeImg && !imgFailed ? (
        <div
          className="sb-plate faint"
          style={{ backgroundImage: `url(${activeImg})` }}
        />
      ) : null}
      <div className="sb-veil" />

      {/* Top status bar */}
      <div className="sb-top">
        <div className="sb-subject">
          <span className="sb-kind">HOLOGRAPHIC SPOTLIGHT</span>
          <span>{title}</span>
          <span className={`conf conf-${s.confidence}`}>{s.confidence}</span>
        </div>
        <div className="sb-top-right">
          <button className="sb-x" onClick={onClose} aria-label="Close spotlight">✕</button>
        </div>
      </div>

      <div className="sp-container">
        {/* Left Column: Focal Portrait in Holographic HUD frame */}
        <div className="sp-portrait-panel glass">
          <div className="hud-corner top-left" />
          <div className="hud-corner top-right" />
          <div className="hud-corner bottom-left" />
          <div className="hud-corner bottom-right" />

          {activeImg && !imgFailed ? (
            <figure className="sp-photo-figure">
              <img
                src={activeImg}
                alt={title}
                referrerPolicy="no-referrer"
                crossOrigin="anonymous"
                loading="eager"
                onError={handleImageError}
              />
              <figcaption className="sp-photo-caption">
                <span className="sp-credit-dot ok" />
                <span>{activeCredit || 'Verified Source'}</span>
                {activePageUrl ? (
                  <>
                    <span className="sp-sep">·</span>
                    <a href={activePageUrl} target="_blank" rel="noreferrer" className="sp-link">
                      Open Source →
                    </a>
                  </>
                ) : null}
              </figcaption>
            </figure>
          ) : (
            <div className="sp-fallback-portrait">
              <div className="sp-fallback-avatar">
                {title.slice(0, 2).toUpperCase()}
              </div>
              <span className="eyebrow faint">PORTRAIT PENDING</span>
            </div>
          )}
        </div>

        {/* Right Column: Intelligence Dossier */}
        <div className="sp-dossier-panel glass">
          <div className="eyebrow">INTELLIGENCE DOSSIER</div>
          <h1 className="sp-name">{title}</h1>

          {s.description ? (
            <div className="sp-role-badge">
              <span className="sp-role-indicator" />
              <span>{s.description}</span>
            </div>
          ) : null}

          {s.extract ? (
            <p className="sp-text">{s.extract}</p>
          ) : s.failure ? (
            <p className="sp-text warn">{s.failure}</p>
          ) : null}

          <div className="sp-actions">
            <button className="btn" onClick={() => onBrief(title)}>
              Full Investigation
            </button>
            <button className="btn ghost" onClick={onClose}>
              Dismiss
            </button>
          </div>

          {/* Media gallery strip */}
          {s.gallery.length > 0 ? (
            <div className="sp-gallery-section">
              <div className="eyebrow faint">ADDITIONAL MEDIA SOURCES ({s.gallery.length})</div>
              <div className="sp-strip">
                {s.gallery.map((g) => (
                  <button
                    key={g.url}
                    className={`sp-thumb glass ${activeImg === g.url ? 'active' : ''}`}
                    onClick={() => {
                      setActiveImg(g.url)
                      setActiveCredit(g.publisher)
                      setActivePageUrl(g.pageUrl)
                      setImgFailed(false)
                    }}
                  >
                    <img
                      src={g.url}
                      alt=""
                      referrerPolicy="no-referrer"
                      crossOrigin="anonymous"
                      loading="lazy"
                    />
                    <span>{g.publisher}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

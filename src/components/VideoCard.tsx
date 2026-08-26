/**
 * Video evidence card — cinematic video panel.
 *
 * When JARVIS says "here's the relevant footage", the video card
 * brings forward a large panel with thumbnail, title, source, date,
 * and relevant context. Links out to the source.
 */

interface VideoCardProps {
  thumbnail?: string | null
  title: string
  source: string
  url: string
  date?: string
  context?: string
  size?: 'normal' | 'large'
}

export function VideoCard({ thumbnail, title, source, url, date, context, size = 'normal' }: VideoCardProps) {
  return (
    <a
      className={`vid glass vid-${size}`}
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      <div className="vid-visual">
        {thumbnail ? (
          <img src={thumbnail} alt={title} loading="lazy" />
        ) : (
          <div className="vid-fallback" />
        )}
        <div className="vid-play">
          <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </div>
      <div className="vid-body">
        <div className="vid-title">{title}</div>
        <div className="vid-meta">
          <span className="vid-source">{source}</span>
          {date ? <span className="vid-date">{date}</span> : null}
        </div>
        {context ? <div className="vid-context">{context}</div> : null}
      </div>
    </a>
  )
}

import { useRef, useEffect } from 'react'

/**
 * Cinematic horizontal timeline.
 *
 * A continuous holographic temporal strip — not a chart, not a graph.
 * Each event can expand to show photograph, article, video, document,
 * and explanation. The strip should feel like a luminous ribbon of time.
 */

interface TimelineEvent {
  date: string
  label: string
  detail?: string
  active?: boolean
}

interface TimelineProps {
  events: TimelineEvent[]
  onSelect?: (index: number) => void
  /** Orientation for the timeline */
  layout?: 'horizontal' | 'vertical'
}

export function Timeline({ events, onSelect, layout = 'vertical' }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to end for horizontal
  useEffect(() => {
    if (layout === 'horizontal' && scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
    }
  }, [events.length, layout])

  if (layout === 'horizontal') {
    return (
      <div className="tl-h" ref={scrollRef}>
        <div className="tl-h-track">
          <div className="tl-h-line" />
          {events.map((evt, i) => (
            <button
              key={i}
              className={`tl-h-node ${evt.active ? 'active' : ''}`}
              onClick={() => onSelect?.(i)}
              title={evt.detail || evt.label}
            >
              <div className="tl-h-dot" />
              <div className="tl-h-date">{evt.date}</div>
              <div className="tl-h-label">{evt.label}</div>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="tl-v">
      {events.map((evt, i) => (
        <div
          key={i}
          className={`tl-v-item ${evt.active ? 'active' : ''}`}
          style={{ animationDelay: `${i * 60}ms` }}
          onClick={() => onSelect?.(i)}
        >
          <div className="tl-v-date">{evt.date}</div>
          <div className="tl-v-rail">
            <span className="tl-v-dot" />
            {i < events.length - 1 ? <div className="tl-v-line" /> : null}
          </div>
          <div className="tl-v-body">
            <div className="tl-v-label">{evt.label}</div>
            {evt.detail ? <div className="tl-v-detail">{evt.detail}</div> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

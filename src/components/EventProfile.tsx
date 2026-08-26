import { useState } from 'react'
import type { BriefingSource, Confidence } from '../../shared/types'
import { ArticleEvidenceCard, SourceStrip } from './EvidenceCard'
import { Timeline } from './Timeline'

/**
 * Event Intelligence Profile.
 *
 * Cinematic dossier view for an event or development:
 * Event banner imagery, situational summary, key participants involved,
 * event progression timeline, and supporting evidence cards.
 */

export interface EventProfileData {
  id: string
  title: string
  date?: string
  location?: string
  status?: string
  image?: string | null
  imageCredit?: string | null
  summary: string
  confidence: Confidence
  keyDetails: { label: string; value: string }[]
  participants?: { name: string; role?: string; photo?: string }[]
  timeline?: { date: string; label: string; detail?: string }[]
  sources?: BriefingSource[]
  openQuestions?: string[]
}

interface Props {
  event: EventProfileData
  onClose: () => void
  onInvestigate: (subject: string) => void
}

export function EventProfile({ event, onClose, onInvestigate }: Props) {
  const [activeTab, setActiveTab] = useState<'overview' | 'timeline' | 'sources'>('overview')

  return (
    <div className="event-profile glass">
      {/* Background ambient plate */}
      {event.image ? (
        <div
          className="sb-plate faint"
          style={{ backgroundImage: `url(${event.image})` }}
        />
      ) : null}
      <div className="sb-veil" />

      {/* Top navigation */}
      <div className="sb-top">
        <div className="sb-subject">
          <span className="sb-kind">EVENT INTELLIGENCE</span>
          <span>{event.title}</span>
          <span className={`conf conf-${event.confidence}`}>{event.confidence}</span>
        </div>
        <div className="sb-top-right">
          <div className="tab-pills">
            <button
              className={`sb-btn ${activeTab === 'overview' ? '' : 'ghost'} tiny`}
              onClick={() => setActiveTab('overview')}
            >
              Overview
            </button>
            {event.timeline?.length ? (
              <button
                className={`sb-btn ${activeTab === 'timeline' ? '' : 'ghost'} tiny`}
                onClick={() => setActiveTab('timeline')}
              >
                Chronology ({event.timeline.length})
              </button>
            ) : null}
            {event.sources?.length ? (
              <button
                className={`sb-btn ${activeTab === 'sources' ? '' : 'ghost'} tiny`}
                onClick={() => setActiveTab('sources')}
              >
                Evidence ({event.sources.length})
              </button>
            ) : null}
          </div>
          <button className="sb-x" onClick={onClose} aria-label="Close event view">✕</button>
        </div>
      </div>

      {/* Main body */}
      <div className="event-body">
        {activeTab === 'overview' && (
          <div className="event-overview-grid">
            {/* Left Column: Visual & Metadata */}
            <div className="event-media-col">
              <figure className="sp-photo">
                {event.image ? (
                  <img src={event.image} alt={event.title} />
                ) : (
                  <div className="f-noimg">EVENT IMAGERY PENDING</div>
                )}
                {event.imageCredit ? (
                  <figcaption>{event.imageCredit}</figcaption>
                ) : null}
              </figure>

              {event.keyDetails.length > 0 && (
                <div className="event-details-card glass">
                  <div className="eyebrow faint">INCIDENT METRICS</div>
                  <dl className="st-facts tight">
                    {event.date ? (
                      <div className="st-fact">
                        <dt>DATE</dt>
                        <dd>{event.date}</dd>
                      </div>
                    ) : null}
                    {event.location ? (
                      <div className="st-fact">
                        <dt>LOCATION</dt>
                        <dd>{event.location}</dd>
                      </div>
                    ) : null}
                    {event.status ? (
                      <div className="st-fact">
                        <dt>STATUS</dt>
                        <dd>{event.status}</dd>
                      </div>
                    ) : null}
                    {event.keyDetails.map((k, i) => (
                      <div key={i} className="st-fact">
                        <dt>{k.label}</dt>
                        <dd>{k.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              <div className="event-actions">
                <button
                  className="btn"
                  onClick={() => onInvestigate(`Impact and fallout of ${event.title}`)}
                >
                  Analyze Fallout
                </button>
                <button
                  className="btn ghost"
                  onClick={() => onInvestigate(`Timeline of events leading to ${event.title}`)}
                >
                  Trace Causes
                </button>
              </div>
            </div>

            {/* Right Column: Narrative & Participants */}
            <div className="event-info-col">
              <div className="eyebrow">SITUATION ASSESSMENT</div>
              <h1 className="sp-name">{event.title}</h1>
              {event.date || event.location ? (
                <div className="sp-role">
                  {[event.date, event.location, event.status].filter(Boolean).join(' · ')}
                </div>
              ) : null}

              <p className="sp-text">{event.summary}</p>

              {event.participants && event.participants.length > 0 && (
                <div className="event-participants-card">
                  <div className="eyebrow faint">KEY ENTITIES INVOLVED</div>
                  <div className="participants-grid">
                    {event.participants.map((p, i) => (
                      <button
                        key={i}
                        className="participant-card glass"
                        onClick={() => onInvestigate(p.name)}
                      >
                        {p.photo ? (
                          <img src={p.photo} alt={p.name} className="participant-avatar" />
                        ) : (
                          <div className="participant-avatar-fallback">
                            {p.name.slice(0, 1)}
                          </div>
                        )}
                        <div className="participant-info">
                          <div className="participant-name">{p.name}</div>
                          {p.role ? <div className="participant-role">{p.role}</div> : null}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {event.openQuestions && event.openQuestions.length > 0 && (
                <div className="event-questions glass">
                  <div className="eyebrow warn">UNRESOLVED QUESTIONS</div>
                  <div className="event-questions-list">
                    {event.openQuestions.map((q, i) => (
                      <div key={i} className="event-question-item">
                        <span className="event-question-bullet" />
                        <span>{q}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {event.sources && event.sources.length > 0 && (
                <div className="event-sources-preview">
                  <div className="eyebrow faint">KEY SOURCES</div>
                  <SourceStrip sources={event.sources.slice(0, 4)} />
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'timeline' && event.timeline && (
          <div className="event-timeline-view">
            <div className="eyebrow">EVENT UNFOLDING</div>
            <h2>Chronological Sequence</h2>
            <Timeline events={event.timeline} />
          </div>
        )}

        {activeTab === 'sources' && event.sources && (
          <div className="event-evidence-view">
            <div className="eyebrow">VERIFIED EVIDENCE</div>
            <h2>Intelligence Sources & Coverage</h2>
            <div className="f-cards">
              {event.sources.map((s) => (
                <ArticleEvidenceCard key={s.id} source={s} size="normal" />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

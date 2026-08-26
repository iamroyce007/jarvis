import { useState } from 'react'
import type { BriefingSource, Confidence } from '../../shared/types'
import { ArticleEvidenceCard, SourceStrip } from './EvidenceCard'
import { Timeline } from './Timeline'

/**
 * Person Intelligence Profile.
 *
 * Cinematic dossier view for an individual:
 * Large portrait photograph, floating holographic credentials,
 * verified facts, chronological timeline of actions, connected entities,
 * and supporting intelligence sources.
 */

export interface PersonProfileData {
  id: string
  name: string
  role?: string
  organization?: string
  photo?: string | null
  photoCredit?: string | null
  summary: string
  confidence: Confidence
  facts: { label: string; value: string }[]
  timeline?: { date: string; label: string; detail?: string }[]
  relations?: { name: string; role: string; type: string }[]
  sources?: BriefingSource[]
}

interface Props {
  person: PersonProfileData
  onClose: () => void
  onInvestigate: (subject: string) => void
}

export function PersonProfile({ person, onClose, onInvestigate }: Props) {
  const [activeTab, setActiveTab] = useState<'overview' | 'timeline' | 'evidence'>('overview')

  return (
    <div className="person-profile glass">
      {/* Background ambient plate */}
      {person.photo ? (
        <div
          className="sb-plate faint"
          style={{ backgroundImage: `url(${person.photo})` }}
        />
      ) : null}
      <div className="sb-veil" />

      {/* Header bar */}
      <div className="sb-top">
        <div className="sb-subject">
          <span className="sb-kind">PERSON PROFILE</span>
          <span>{person.name}</span>
          <span className={`conf conf-${person.confidence}`}>{person.confidence}</span>
        </div>
        <div className="sb-top-right">
          <div className="tab-pills">
            <button
              className={`sb-btn ${activeTab === 'overview' ? '' : 'ghost'} tiny`}
              onClick={() => setActiveTab('overview')}
            >
              Overview
            </button>
            {person.timeline?.length ? (
              <button
                className={`sb-btn ${activeTab === 'timeline' ? '' : 'ghost'} tiny`}
                onClick={() => setActiveTab('timeline')}
              >
                Timeline ({person.timeline.length})
              </button>
            ) : null}
            {person.sources?.length ? (
              <button
                className={`sb-btn ${activeTab === 'evidence' ? '' : 'ghost'} tiny`}
                onClick={() => setActiveTab('evidence')}
              >
                Evidence ({person.sources.length})
              </button>
            ) : null}
          </div>
          <button className="sb-x" onClick={onClose} aria-label="Close profile">✕</button>
        </div>
      </div>

      {/* Main content body */}
      <div className="person-body">
        {activeTab === 'overview' && (
          <div className="person-overview-grid">
            {/* Left: Portrait & credentials */}
            <div className="person-portrait-col">
              <figure className="sp-photo">
                {person.photo ? (
                  <img src={person.photo} alt={person.name} />
                ) : (
                  <div className="f-noimg">NO VERIFIED PORTRAIT</div>
                )}
                {person.photoCredit ? (
                  <figcaption>{person.photoCredit}</figcaption>
                ) : null}
              </figure>

              <div className="person-actions">
                <button
                  className="btn"
                  onClick={() => onInvestigate(`Deep dive into ${person.name}`)}
                >
                  Full Investigation
                </button>
                <button
                  className="btn ghost"
                  onClick={() => onInvestigate(`Connections and associates of ${person.name}`)}
                >
                  Map Network
                </button>
              </div>
            </div>

            {/* Right: Bio, facts, and relations */}
            <div className="person-info-col">
              <div className="eyebrow">INTELLIGENCE DOSSIER</div>
              <h1 className="sp-name">{person.name}</h1>
              {person.role || person.organization ? (
                <div className="sp-role">
                  {person.role}
                  {person.role && person.organization ? ' · ' : ''}
                  {person.organization}
                </div>
              ) : null}

              <p className="sp-text">{person.summary}</p>

              {person.facts.length > 0 && (
                <div className="person-facts-card glass">
                  <div className="eyebrow faint">VERIFIED ATTRIBUTES</div>
                  <dl className="st-facts tight">
                    {person.facts.map((f, i) => (
                      <div key={i} className="st-fact">
                        <dt>{f.label}</dt>
                        <dd>{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {person.relations && person.relations.length > 0 && (
                <div className="person-relations">
                  <div className="eyebrow faint">AFFILIATIONS & NETWORK</div>
                  <div className="relation-chips">
                    {person.relations.map((r, i) => (
                      <button
                        key={i}
                        className="relation-chip glass"
                        onClick={() => onInvestigate(r.name)}
                      >
                        <span className="relation-name">{r.name}</span>
                        <span className="relation-type">{r.role || r.type}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {person.sources && person.sources.length > 0 && (
                <div className="person-sources-preview">
                  <div className="eyebrow faint">PRIMARY SOURCES</div>
                  <SourceStrip sources={person.sources.slice(0, 4)} />
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'timeline' && person.timeline && (
          <div className="person-timeline-view">
            <div className="eyebrow">CHRONOLOGICAL RECORD</div>
            <h2>Key Events & Actions</h2>
            <Timeline events={person.timeline} />
          </div>
        )}

        {activeTab === 'evidence' && person.sources && (
          <div className="person-evidence-view">
            <div className="eyebrow">SUPPORTING EVIDENCE</div>
            <h2>Verified Reports & Intelligence Sources</h2>
            <div className="f-cards">
              {person.sources.map((s) => (
                <ArticleEvidenceCard key={s.id} source={s} size="normal" />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

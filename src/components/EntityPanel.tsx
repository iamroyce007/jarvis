import { useEffect, useState } from 'react'
import type { EntityProfile, Confidence } from '../../shared/types'

/**
 * Entity intelligence profile.
 *
 * Every claim is shown with its confidence and its source. Nothing appears as
 * bare fact — if JARVIS inferred something, the panel says so, and the evidence
 * section answers "why do you believe this?" directly rather than asking the
 * user to take it on trust.
 */

const CONFIDENCE_NOTE: Record<Confidence, string> = {
  confirmed: 'Directly observed by JARVIS',
  corroborated: 'Supported by more than one source',
  reported: 'Stated by a source, not independently verified',
  inferred: 'Deduced by JARVIS, not directly stated',
  disputed: 'Sources disagree',
  unknown: 'Provenance unknown'
}

export function ConfidenceChip({ level }: { level: Confidence }) {
  return (
    <span className={`conf conf-${level}`} title={CONFIDENCE_NOTE[level]}>
      {level}
    </span>
  )
}

interface Props {
  entityId: string
  onFocus: (id: string) => void
  onClose: () => void
}

export function EntityPanel({ entityId, onFocus, onClose }: Props) {
  const [profile, setProfile] = useState<EntityProfile | null>(null)
  const [tab, setTab] = useState<'links' | 'evidence' | 'timeline'>('links')

  useEffect(() => {
    let alive = true
    void window.jarvis.graphProfile(entityId).then((p) => {
      if (alive) setProfile(p)
    })
    return () => {
      alive = false
    }
  }, [entityId])

  const e = profile?.entity
  if (!e) {
    return (
      <div className="holo" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="holo-head">
          <span>ENTITY</span>
        </div>
        <div className="holo-body" style={{ color: 'var(--ink-ghost)', fontSize: 11 }}>
          Loading…
        </div>
      </div>
    )
  }

  const counts = {
    links: profile.relations.length,
    evidence: profile.evidence.length,
    timeline: profile.timeline.length
  }

  return (
    <div className="holo" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="holo-head">
        <span>{e.kind.toUpperCase()}</span>
        <span style={{ cursor: 'pointer' }} onClick={onClose} role="button" tabIndex={0}>
          close
        </span>
      </div>

      <div style={{ padding: '12px 12px 8px' }}>
        <div style={{ fontSize: 15, color: 'var(--ink)', marginBottom: 6, lineHeight: 1.3 }}>
          {e.name}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <ConfidenceChip level={e.confidence} />
          <span style={{ fontSize: 9.5, color: 'var(--ink-ghost)' }}>
            {e.mentions} mention{e.mentions === 1 ? '' : 's'}
          </span>
        </div>
        {e.summary ? (
          <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginTop: 8, lineHeight: 1.5 }}>
            {e.summary}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 2, padding: '0 12px', borderBottom: '1px solid var(--glass-edge)' }}>
        {(['links', 'evidence', 'timeline'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${tab === t ? 'var(--cyan)' : 'transparent'}`,
              color: tab === t ? 'var(--ink)' : 'var(--ink-faint)',
              fontSize: 9.5,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              padding: '7px 8px',
              cursor: 'pointer'
            }}
          >
            {t} {counts[t] ? `· ${counts[t]}` : ''}
          </button>
        ))}
      </div>

      <div className="holo-body" style={{ flex: 1 }}>
        {tab === 'links' ? (
          profile.relations.length === 0 ? (
            <Empty text="No relationships found yet." />
          ) : (
            profile.relations.map((r) => (
              <div
                key={r.id + r.direction}
                onClick={() => onFocus(r.other.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 0',
                  borderBottom: '1px solid rgba(120,190,235,0.06)',
                  cursor: 'pointer'
                }}
              >
                <span style={{ fontSize: 9, color: 'var(--cyan-dim)', minWidth: 14 }}>
                  {r.direction === 'out' ? '→' : '←'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--ink)' }}>{r.other.name}</div>
                  <div style={{ fontSize: 9, color: 'var(--ink-faint)', letterSpacing: '0.06em' }}>
                    {r.kind.replace(/_/g, ' ')}
                    {r.label ? ` — ${r.label}` : ''}
                  </div>
                </div>
                <ConfidenceChip level={r.confidence} />
              </div>
            ))
          )
        ) : null}

        {tab === 'evidence' ? (
          profile.evidence.length === 0 ? (
            <Empty text="No evidence recorded. This entity is inferred only." />
          ) : (
            profile.evidence.map((ev) => (
              <div
                key={ev.id}
                style={{ padding: '8px 0', borderBottom: '1px solid rgba(120,190,235,0.06)' }}
              >
                <div style={{ fontSize: 11.5, color: 'var(--ink)', lineHeight: 1.45 }}>
                  {ev.claim}
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                    marginTop: 5,
                    flexWrap: 'wrap'
                  }}
                >
                  <ConfidenceChip level={ev.confidence} />
                  <span style={{ fontSize: 9, color: 'var(--ink-faint)' }}>
                    {ev.sourceKind} · {new Date(ev.at).toLocaleString()}
                  </span>
                </div>
                {ev.excerpt ? (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--ink-ghost)',
                      marginTop: 5,
                      paddingLeft: 8,
                      borderLeft: '2px solid var(--glass-edge)',
                      lineHeight: 1.45
                    }}
                  >
                    “{ev.excerpt}”
                  </div>
                ) : null}
              </div>
            ))
          )
        ) : null}

        {tab === 'timeline' ? (
          profile.timeline.length === 0 ? (
            <Empty text="No timeline events recorded." />
          ) : (
            profile.timeline.map((t) => (
              <div key={t.id} style={{ display: 'flex', gap: 10, padding: '7px 0' }}>
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--cyan-dim)',
                    marginTop: 5,
                    flexShrink: 0
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--ink)' }}>{t.label}</div>
                  {t.detail ? (
                    <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>
                      {t.detail}
                    </div>
                  ) : null}
                  <div style={{ fontSize: 9, color: 'var(--ink-ghost)', marginTop: 3 }}>
                    {new Date(t.occurredAt ?? t.at).toLocaleString()}
                  </div>
                </div>
              </div>
            ))
          )
        ) : null}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 10.5, color: 'var(--ink-ghost)', padding: '10px 0', lineHeight: 1.5 }}>
      {text}
    </div>
  )
}

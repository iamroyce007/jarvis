import { useState } from 'react'
import type { Projection, Scenario } from '../../shared/types'

/**
 * Scenario projection.
 *
 * Three or four possible futures as separate scenes, not a branching diagram.
 * The design enforces the epistemics: what is currently *observed* sits apart
 * from what is *projected*, every scene shows the assumptions it rests on, and
 * the falsifier — what would rule this path out — is given equal weight to the
 * outcome. A projection you cannot disprove is presented as a warning, not a
 * finding.
 */

const BAND: Record<string, { color: string; label: string }> = {
  'most likely': { color: 'var(--ok)', label: 'Most likely' },
  plausible: { color: 'var(--cyan)', label: 'Plausible' },
  possible: { color: 'var(--warn)', label: 'Possible' },
  unlikely: { color: 'var(--ink-faint)', label: 'Unlikely' }
}

interface Props {
  projection: Projection
  onClose: () => void
}

export function ScenarioView({ projection, onClose }: Props) {
  const [open, setOpen] = useState<number | null>(0)

  if (projection.failure) {
    return (
      <div className="sc">
        <div className="sc-top">
          <span className="sc-eyebrow">Projection failed</span>
          <button className="sb-btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="sc-fail">{projection.failure}</div>
      </div>
    )
  }

  return (
    <div className="sc">
      <div className="sc-top">
        <div>
          <div className="sc-eyebrow">Plausible paths — not predictions</div>
          <h2 className="sc-subject">{projection.subject}</h2>
        </div>
        <button className="sb-btn ghost" onClick={onClose}>Close</button>
      </div>

      {/* Observed reality, kept visually distinct from anything projected. */}
      {projection.currentState || projection.observations.length ? (
        <section className="sc-now">
          <div className="sc-label">Observed now</div>
          {projection.currentState ? <p className="sc-state">{projection.currentState}</p> : null}
          {projection.observations.map((o, i) => (
            <div key={i} className="sc-obs">
              <span className="sc-obs-mark" />
              {o}
            </div>
          ))}
        </section>
      ) : null}

      <div className="sc-divider">
        <span>Everything below is projection</span>
      </div>

      <div className="sc-scenes">
        {projection.scenarios.map((s, i) => (
          <ScenarioScene
            key={i}
            scenario={s}
            open={open === i}
            onToggle={() => setOpen(open === i ? null : i)}
          />
        ))}
      </div>

      {projection.keyVariables.length ? (
        <section className="sc-vars">
          <div className="sc-label">What determines which path</div>
          {projection.keyVariables.map((v, i) => (
            <div key={i} className="sc-var">
              <span className="sc-var-n">{i + 1}</span>
              {v}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  )
}

function ScenarioScene({
  scenario,
  open,
  onToggle
}: {
  scenario: Scenario
  open: boolean
  onToggle: () => void
}) {
  const band = BAND[scenario.likelihood] ?? BAND.possible
  const unfalsifiable = scenario.falsifiers.length === 0

  return (
    <article
      className={`sc-scene ${open ? 'open' : ''}`}
      style={{ ['--band' as string]: band.color }}
      onClick={onToggle}
    >
      <header className="sc-scene-head">
        <span className="sc-band">{band.label}</span>
        <h3>{scenario.title}</h3>
      </header>
      <p className="sc-outline">{scenario.outline}</p>

      {open ? (
        <div className="sc-detail">
          {scenario.assumptions.length ? (
            <Group label="Rests on" items={scenario.assumptions} />
          ) : null}
          {scenario.triggers.length ? (
            <Group label="Signals this is happening" items={scenario.triggers} />
          ) : null}
          {scenario.consequences.length ? (
            <Group label="If it happens" items={scenario.consequences} />
          ) : null}

          {unfalsifiable ? (
            <div className="sc-unfalsifiable">
              No falsifier given — treat this as speculation, not analysis.
            </div>
          ) : (
            <Group label="Ruled out by" items={scenario.falsifiers} accent />
          )}
        </div>
      ) : (
        <div className="sc-hint">{scenario.assumptions.length} assumptions · click to open</div>
      )}
    </article>
  )
}

function Group({
  label,
  items,
  accent = false
}: {
  label: string
  items: string[]
  accent?: boolean
}) {
  return (
    <div className={`sc-group ${accent ? 'accent' : ''}`}>
      <div className="sc-group-label">{label}</div>
      {items.map((it, i) => (
        <div key={i} className="sc-group-item">{it}</div>
      ))}
    </div>
  )
}

import { useEffect, useRef, useState, useCallback } from 'react'
import type { GraphEntity, GraphRelation, EntityKind } from '../../shared/types'

/**
 * The World Graph.
 *
 * A force-directed spatial view of entities and their relationships. New nodes
 * animate into existence and pulses travel along edges when a relationship is
 * discovered, so the user sees the model being built rather than a static
 * diagram appearing. Clicking an entity re-centres the graph on it.
 */

interface Props {
  entities: GraphEntity[]
  relations: GraphRelation[]
  focusId: string | null
  onFocus: (id: string | null) => void
  lens: Lens
}

export type Lens =
  | 'RELATIONSHIPS' | 'PEOPLE' | 'EVENTS' | 'TECHNOLOGY' | 'DEPENDENCIES' | 'SOURCES'

interface Node {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  entity: GraphEntity
  /** 0 → 1 as the node materialises; drives the entrance animation. */
  born: number
}

interface Edge {
  source: Node
  target: Node
  relation: GraphRelation
  /** Position of the travelling data pulse, 0 → 1, or null when idle. */
  pulse: number | null
}

const KIND_COLOR: Record<EntityKind, string> = {
  person: '#4fd6ff',
  organization: '#9d8cff',
  company: '#9d8cff',
  event: '#ffb454',
  place: '#52e0a8',
  product: '#6ba8ff',
  technology: '#6ba8ff',
  document: '#7fd4c1',
  file: '#7fd4c1',
  repository: '#7fd4c1',
  service: '#6ba8ff',
  device: '#8a94a6',
  project: '#4fd6ff',
  task: '#8a94a6',
  concept: '#a9bccf',
  financial: '#52e0a8',
  team: '#4fd6ff',
  other: '#6b8299'
}

/** Which entity kinds each lens emphasises. Empty means "show everything". */
const LENS_KINDS: Record<Lens, EntityKind[]> = {
  RELATIONSHIPS: [],
  PEOPLE: ['person', 'organization', 'company', 'team'],
  EVENTS: ['event', 'task', 'project'],
  TECHNOLOGY: ['technology', 'product', 'repository', 'service', 'device', 'file'],
  DEPENDENCIES: ['service', 'repository', 'technology', 'file', 'project'],
  SOURCES: ['document', 'file', 'concept']
}

export function WorldGraph({ entities, relations, focusId, onFocus, lens }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const nodesRef = useRef<Map<string, Node>>(new Map())
  const edgesRef = useRef<Edge[]>([])
  const [hover, setHover] = useState<string | null>(null)
  const hoverRef = useRef<string | null>(null)
  const focusRef = useRef<string | null>(focusId)
  const lensRef = useRef<Lens>(lens)
  const cameraRef = useRef({ x: 0, y: 0, zoom: 1 })

  hoverRef.current = hover
  focusRef.current = focusId
  lensRef.current = lens

  // Rebuild the simulation whenever the graph changes, preserving positions so
  // existing nodes stay put and only genuinely new ones animate in.
  useEffect(() => {
    const nodes = nodesRef.current
    const seen = new Set<string>()

    for (const e of entities) {
      seen.add(e.id)
      const existing = nodes.get(e.id)
      if (existing) {
        existing.entity = e
        existing.r = 6 + Math.min(14, Math.sqrt(e.mentions) * 3)
      } else {
        const angle = Math.random() * Math.PI * 2
        const dist = 120 + Math.random() * 160
        nodes.set(e.id, {
          id: e.id,
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          vx: 0,
          vy: 0,
          r: 6 + Math.min(14, Math.sqrt(e.mentions) * 3),
          entity: e,
          born: 0
        })
      }
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id)

    const prevPulses = new Map(edgesRef.current.map((e) => [e.relation.id, e.pulse]))
    edgesRef.current = relations
      .map((r) => {
        const source = nodes.get(r.sourceId)
        const target = nodes.get(r.targetId)
        if (!source || !target) return null
        return {
          source,
          target,
          relation: r,
          // A relation we have not drawn before gets a pulse to announce itself.
          pulse: prevPulses.has(r.id) ? (prevPulses.get(r.id) ?? null) : 0
        }
      })
      .filter((e): e is Edge => e !== null)
  }, [entities, relations])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let width = wrap.clientWidth
    let height = wrap.clientHeight

    const resize = (): void => {
      width = wrap.clientWidth
      height = wrap.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let t = 0

    const visible = (n: Node): boolean => {
      const kinds = LENS_KINDS[lensRef.current]
      return kinds.length === 0 || kinds.includes(n.entity.kind)
    }

    const step = (): void => {
      t += 0.016
      const nodes = [...nodesRef.current.values()]
      const edges = edgesRef.current
      const focus = focusRef.current

      // --- Force simulation ------------------------------------------------
      if (!reduceMotion) {
        for (const n of nodes) {
          n.born = Math.min(1, n.born + 0.04)
          // Gentle pull toward the centre keeps the graph from drifting away.
          n.vx += -n.x * 0.0016
          n.vy += -n.y * 0.0016
        }

        // Repulsion between every pair, so labels stay readable.
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i]
            const b = nodes[j]
            const dx = b.x - a.x
            const dy = b.y - a.y
            const d2 = dx * dx + dy * dy + 0.01
            const d = Math.sqrt(d2)
            const min = (a.r + b.r) * 4
            if (d < min * 3) {
              const force = (900 / d2) * (d < min ? 3 : 1)
              const fx = (dx / d) * force
              const fy = (dy / d) * force
              a.vx -= fx
              a.vy -= fy
              b.vx += fx
              b.vy += fy
            }
          }
        }

        // Edges act as springs; heavier relations pull tighter.
        for (const e of edges) {
          const dx = e.target.x - e.source.x
          const dy = e.target.y - e.source.y
          const d = Math.sqrt(dx * dx + dy * dy) + 0.01
          const rest = 120 - Math.min(40, e.relation.weight * 6)
          const force = (d - rest) * 0.004
          const fx = (dx / d) * force
          const fy = (dy / d) * force
          e.source.vx += fx
          e.source.vy += fy
          e.target.vx -= fx
          e.target.vy -= fy
        }

        // The focused entity is drawn to the centre of the view.
        if (focus) {
          const f = nodesRef.current.get(focus)
          if (f) {
            f.vx += -f.x * 0.06
            f.vy += -f.y * 0.06
          }
        }

        for (const n of nodes) {
          n.vx *= 0.86
          n.vy *= 0.86
          n.x += n.vx
          n.y += n.vy
        }
      }

      // --- Render ----------------------------------------------------------
      ctx.clearRect(0, 0, width, height)
      const cam = cameraRef.current
      ctx.save()
      ctx.translate(width / 2 + cam.x, height / 2 + cam.y)
      ctx.scale(cam.zoom, cam.zoom)

      const focusNode = focus ? nodesRef.current.get(focus) : null
      const neighbours = new Set<string>()
      if (focusNode) {
        for (const e of edges) {
          if (e.source.id === focus) neighbours.add(e.target.id)
          if (e.target.id === focus) neighbours.add(e.source.id)
        }
      }

      // Edges first, so nodes sit on top.
      for (const e of edges) {
        if (!visible(e.source) || !visible(e.target)) continue
        const related =
          !focus || e.source.id === focus || e.target.id === focus
        const alpha = related ? 0.4 : 0.08

        ctx.strokeStyle = `rgba(120,190,235,${alpha})`
        ctx.lineWidth = related ? 1.2 : 0.6
        ctx.beginPath()
        ctx.moveTo(e.source.x, e.source.y)
        ctx.lineTo(e.target.x, e.target.y)
        ctx.stroke()

        // A pulse travels the edge once, announcing a newly found relationship.
        if (e.pulse !== null && !reduceMotion) {
          e.pulse += 0.02
          if (e.pulse > 1) {
            e.pulse = null
          } else {
            const px = e.source.x + (e.target.x - e.source.x) * e.pulse
            const py = e.source.y + (e.target.y - e.source.y) * e.pulse
            ctx.fillStyle = `rgba(79,214,255,${1 - e.pulse})`
            ctx.beginPath()
            ctx.arc(px, py, 2.5, 0, Math.PI * 2)
            ctx.fill()
          }
        }

        // Relationship labels appear only where the user is looking.
        if (related && focus && cam.zoom > 0.7) {
          const mx = (e.source.x + e.target.x) / 2
          const my = (e.source.y + e.target.y) / 2
          ctx.fillStyle = 'rgba(169,188,207,0.75)'
          ctx.font = '8px -apple-system, system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(e.relation.kind.replace(/_/g, ' '), mx, my - 3)
        }
      }

      for (const n of nodes) {
        if (!visible(n)) continue
        const isFocus = n.id === focus
        const isHover = n.id === hoverRef.current
        const dimmed = focus && !isFocus && !neighbours.has(n.id)
        const ease = n.born * n.born * (3 - 2 * n.born)
        const r = n.r * ease * (isFocus ? 1.5 : isHover ? 1.25 : 1)
        const color = KIND_COLOR[n.entity.kind] ?? KIND_COLOR.other
        const alpha = dimmed ? 0.25 : 1

        // Newly born nodes emit an expanding ring so arrivals are noticeable.
        if (n.born < 1) {
          ctx.strokeStyle = `rgba(79,214,255,${(1 - n.born) * 0.6})`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(n.x, n.y, r + (1 - n.born) * 26, 0, Math.PI * 2)
          ctx.stroke()
        }

        if (isFocus || isHover) {
          const glow = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 4)
          glow.addColorStop(0, `${color}55`)
          glow.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.fillStyle = glow
          ctx.beginPath()
          ctx.arc(n.x, n.y, r * 4, 0, Math.PI * 2)
          ctx.fill()
        }

        ctx.globalAlpha = alpha
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fill()

        // A ring marks entities we have direct evidence for.
        if (n.entity.confidence === 'confirmed' || n.entity.confidence === 'corroborated') {
          ctx.strokeStyle = 'rgba(82,224,168,0.9)'
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2)
          ctx.stroke()
        }

        if (!dimmed && (cam.zoom > 0.55 || isFocus || isHover)) {
          ctx.fillStyle = isFocus ? '#e8f2fb' : 'rgba(169,188,207,0.85)'
          ctx.font = `${isFocus ? 11 : 9.5}px -apple-system, system-ui, sans-serif`
          ctx.textAlign = 'center'
          const label =
            n.entity.name.length > 26 ? `${n.entity.name.slice(0, 24)}…` : n.entity.name
          ctx.fillText(label, n.x, n.y + r + 12)
        }
        ctx.globalAlpha = 1
      }

      ctx.restore()
      raf = requestAnimationFrame(step)
    }

    step()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  /** Maps a pointer position to a node, accounting for camera transform. */
  const nodeAt = useCallback((clientX: number, clientY: number): Node | null => {
    const wrap = wrapRef.current
    if (!wrap) return null
    const rect = wrap.getBoundingClientRect()
    const cam = cameraRef.current
    const x = (clientX - rect.left - rect.width / 2 - cam.x) / cam.zoom
    const y = (clientY - rect.top - rect.height / 2 - cam.y) / cam.zoom
    for (const n of nodesRef.current.values()) {
      const kinds = LENS_KINDS[lensRef.current]
      if (kinds.length && !kinds.includes(n.entity.kind)) continue
      if ((x - n.x) ** 2 + (y - n.y) ** 2 < (n.r + 8) ** 2) return n
    }
    return null
  }, [])

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', width: '100%', height: '100%', cursor: hover ? 'pointer' : 'default' }}
      onMouseMove={(e) => setHover(nodeAt(e.clientX, e.clientY)?.id ?? null)}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        const n = nodeAt(e.clientX, e.clientY)
        onFocus(n ? n.id : null)
      }}
      onWheel={(e) => {
        const cam = cameraRef.current
        cam.zoom = Math.max(0.3, Math.min(3, cam.zoom * (e.deltaY > 0 ? 0.94 : 1.06)))
      }}
    >
      <canvas ref={canvasRef} />
      {entities.length === 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: 'var(--ink-ghost)',
            fontSize: 11,
            letterSpacing: '0.08em',
            textAlign: 'center',
            pointerEvents: 'none'
          }}
        >
          NO ENTITIES YET
          <br />
          <span style={{ fontSize: 10, opacity: 0.7 }}>
            The graph builds itself as you talk.
          </span>
        </div>
      ) : null}
    </div>
  )
}

import { useEffect, useRef } from 'react'
import type { JarvisState } from '../../shared/types'

/**
 * The JARVIS core.
 *
 * A layered canvas visualization whose behaviour is derived from system state,
 * not decoration: ring rotation tracks activity, particle convergence tracks
 * reasoning, the waveform tracks real microphone or speech amplitude, and the
 * colour is the state colour. Someone watching only this should be able to say
 * what the system is doing.
 */

interface Props {
  state: JarvisState
  /** 0..1 audio amplitude, drives the waveform while listening or speaking. */
  level: number
  size?: number
}

interface Ring {
  radius: number
  speed: number
  segments: number
  gap: number
  width: number
  phase: number
}

interface Particle {
  angle: number
  radius: number
  speed: number
  size: number
  drift: number
}

/** Per-state visual behaviour. Each field maps to something observable. */
const BEHAVIOUR: Record<
  JarvisState,
  {
    color: string
    spin: number
    pulse: number
    particles: number
    converge: number
    jitter: number
    coreScale: number
  }
> = {
  IDLE:                    { color: '#2a8db3', spin: 0.10, pulse: 0.35, particles: 18, converge: 0,    jitter: 0,    coreScale: 1 },
  LISTENING:               { color: '#4fd6ff', spin: 0.25, pulse: 0.9,  particles: 30, converge: 0,    jitter: 0,    coreScale: 1.05 },
  UNDERSTANDING:           { color: '#6ba8ff', spin: 0.55, pulse: 0.7,  particles: 42, converge: 0.55, jitter: 0,    coreScale: 1.02 },
  THINKING:                { color: '#9d8cff', spin: 0.9,  pulse: 0.6,  particles: 54, converge: 0.75, jitter: 0,    coreScale: 0.98 },
  PLANNING:                { color: '#9d8cff', spin: 0.7,  pulse: 0.5,  particles: 46, converge: 0.4,  jitter: 0,    coreScale: 1 },
  RESEARCHING:             { color: '#6ba8ff', spin: 1.2,  pulse: 0.65, particles: 62, converge: -0.5, jitter: 0,    coreScale: 1 },
  EXECUTING:               { color: '#4fd6ff', spin: 1.6,  pulse: 1.0,  particles: 50, converge: 0.2,  jitter: 0.4,  coreScale: 1.08 },
  WAITING_FOR_CONFIRMATION:{ color: '#ffb454', spin: 0.15, pulse: 1.3,  particles: 24, converge: 0,    jitter: 0,    coreScale: 1 },
  SPEAKING:                { color: '#4fd6ff', spin: 0.35, pulse: 0.8,  particles: 34, converge: 0,    jitter: 0,    coreScale: 1.04 },
  SUCCESS:                 { color: '#52e0a8', spin: 0.3,  pulse: 0.5,  particles: 40, converge: -1,   jitter: 0,    coreScale: 1.1 },
  WARNING:                 { color: '#ffb454', spin: 0.4,  pulse: 1.1,  particles: 28, converge: 0,    jitter: 0.2,  coreScale: 1 },
  INTERRUPTED:             { color: '#ffb454', spin: 0.05, pulse: 0.3,  particles: 14, converge: 0,    jitter: 0.8,  coreScale: 0.94 },
  ERROR:                   { color: '#ff6b6b', spin: 0.08, pulse: 1.5,  particles: 16, converge: 0,    jitter: 1.2,  coreScale: 0.92 },
  EMERGENCY_HALT:          { color: '#ff6b6b', spin: 0,    pulse: 2.2,  particles: 8,  converge: 0,    jitter: 2.0,  coreScale: 0.88 }
}

export function JarvisCore({ state, level, size = 260 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  const levelRef = useRef(level)
  // Behaviour is interpolated rather than switched, so state changes read as
  // the system shifting attention instead of a hard cut.
  const currentRef = useRef({ ...BEHAVIOUR.IDLE, colorRGB: [42, 141, 179] as number[] })

  stateRef.current = state
  levelRef.current = level

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const cx = size / 2
    const cy = size / 2
    const maxR = size * 0.44

    const rings: Ring[] = [
      { radius: 0.96, speed: -0.18, segments: 3,  gap: 0.42, width: 1,   phase: 0 },
      { radius: 0.84, speed: 0.32,  segments: 6,  gap: 0.2,  width: 1.5, phase: 0.4 },
      { radius: 0.7,  speed: -0.5,  segments: 12, gap: 0.1,  width: 1,   phase: 1.1 },
      { radius: 0.56, speed: 0.75,  segments: 4,  gap: 0.3,  width: 2,   phase: 2.2 }
    ]

    const particles: Particle[] = Array.from({ length: 70 }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: 0.35 + Math.random() * 0.6,
      speed: 0.2 + Math.random() * 0.8,
      size: 0.6 + Math.random() * 1.6,
      drift: Math.random() * Math.PI * 2
    }))

    const hexToRgb = (hex: string): number[] => {
      const n = parseInt(hex.slice(1), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let raf = 0
    let t = 0
    let smoothLevel = 0

    const draw = (): void => {
      const target = BEHAVIOUR[stateRef.current] ?? BEHAVIOUR.IDLE
      const cur = currentRef.current
      const targetRGB = hexToRgb(target.color)

      // Ease every parameter toward its target.
      const k = reduceMotion ? 1 : 0.06
      cur.spin += (target.spin - cur.spin) * k
      cur.pulse += (target.pulse - cur.pulse) * k
      cur.particles += (target.particles - cur.particles) * k
      cur.converge += (target.converge - cur.converge) * k
      cur.jitter += (target.jitter - cur.jitter) * k
      cur.coreScale += (target.coreScale - cur.coreScale) * k
      for (let i = 0; i < 3; i++) {
        cur.colorRGB[i] += (targetRGB[i] - cur.colorRGB[i]) * k
      }

      const [r, g, b] = cur.colorRGB.map(Math.round)
      const rgb = (a: number): string => `rgba(${r},${g},${b},${a})`

      smoothLevel += (levelRef.current - smoothLevel) * 0.25
      const amp = Math.min(1, smoothLevel * 6)

      t += reduceMotion ? 0 : 0.016
      ctx.clearRect(0, 0, size, size)

      const breathe = 1 + Math.sin(t * cur.pulse * 2) * 0.03
      const jitterX = cur.jitter ? (Math.random() - 0.5) * cur.jitter * 2 : 0
      const jitterY = cur.jitter ? (Math.random() - 0.5) * cur.jitter * 2 : 0

      ctx.save()
      ctx.translate(cx + jitterX, cy + jitterY)

      // --- Outer atmosphere ------------------------------------------------
      const halo = ctx.createRadialGradient(0, 0, maxR * 0.2, 0, 0, maxR * 1.5)
      halo.addColorStop(0, rgb(0.1))
      halo.addColorStop(0.5, rgb(0.03))
      halo.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(0, 0, maxR * 1.5, 0, Math.PI * 2)
      ctx.fill()

      // --- Segmented orbital rings ----------------------------------------
      for (const ring of rings) {
        const rr = maxR * ring.radius * breathe
        const rot = t * ring.speed * cur.spin * 3 + ring.phase
        const arc = ((Math.PI * 2) / ring.segments) * (1 - ring.gap)

        ctx.lineWidth = ring.width
        for (let i = 0; i < ring.segments; i++) {
          const start = rot + ((Math.PI * 2) / ring.segments) * i
          // Segments fade with depth so the structure reads as three-dimensional.
          const depth = 0.35 + 0.65 * ((Math.sin(start + t * 0.5) + 1) / 2)
          ctx.strokeStyle = rgb(0.5 * depth)
          ctx.beginPath()
          ctx.arc(0, 0, rr, start, start + arc)
          ctx.stroke()
        }
      }

      // --- Particle field --------------------------------------------------
      const count = Math.round(cur.particles)
      for (let i = 0; i < count; i++) {
        const p = particles[i]
        p.angle += 0.004 * p.speed * (1 + cur.spin)
        // Positive converge pulls inward (synthesis), negative pushes outward
        // (search): the field visibly gathers or casts about.
        const conv = Math.sin(t * 0.8 + p.drift) * 0.12 * cur.converge
        const pr = maxR * (p.radius - conv) * breathe
        const px = Math.cos(p.angle) * pr
        const py = Math.sin(p.angle) * pr * 0.85
        const twinkle = 0.35 + 0.65 * ((Math.sin(t * 2 + p.drift) + 1) / 2)

        ctx.fillStyle = rgb(0.55 * twinkle)
        ctx.beginPath()
        ctx.arc(px, py, p.size, 0, Math.PI * 2)
        ctx.fill()
      }

      // --- Live waveform ---------------------------------------------------
      // Only drawn when audio is genuinely flowing, so it always means sound.
      if (amp > 0.02 && (stateRef.current === 'LISTENING' || stateRef.current === 'SPEAKING')) {
        const waveR = maxR * 0.5
        ctx.strokeStyle = rgb(0.85)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        for (let a = 0; a <= Math.PI * 2 + 0.05; a += 0.05) {
          const wobble =
            Math.sin(a * 7 + t * 6) * amp * 11 + Math.sin(a * 13 - t * 4) * amp * 5
          const rr = waveR + wobble
          const x = Math.cos(a) * rr
          const y = Math.sin(a) * rr
          if (a === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.stroke()
      }

      // --- Inner core ------------------------------------------------------
      const coreR = maxR * 0.22 * cur.coreScale * breathe * (1 + amp * 0.25)
      const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 2.4)
      coreGrad.addColorStop(0, rgb(0.95))
      coreGrad.addColorStop(0.35, rgb(0.45))
      coreGrad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = coreGrad
      ctx.beginPath()
      ctx.arc(0, 0, coreR * 2.4, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = rgb(0.98)
      ctx.beginPath()
      ctx.arc(0, 0, coreR * 0.5, 0, Math.PI * 2)
      ctx.fill()

      // --- Radial ticks ----------------------------------------------------
      // A fine technical scale; density rises with activity.
      const ticks = 48
      ctx.lineWidth = 1
      for (let i = 0; i < ticks; i++) {
        const a = ((Math.PI * 2) / ticks) * i + t * 0.05 * cur.spin
        const active = i % 4 === 0 || Math.sin(t * 2 + i) > 0.85
        const len = active ? 7 : 3
        const inner = maxR * 1.02
        ctx.strokeStyle = rgb(active ? 0.4 : 0.14)
        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner)
        ctx.lineTo(Math.cos(a) * (inner + len), Math.sin(a) * (inner + len))
        ctx.stroke()
      }

      ctx.restore()
      raf = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(raf)
  }, [size])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: 'block' }}
      role="img"
      aria-label={`JARVIS core, state: ${state.toLowerCase().replace(/_/g, ' ')}`}
    />
  )
}

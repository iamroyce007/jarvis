import { useEffect, useRef } from 'react'
import type { JarvisState } from '../../shared/types'

/**
 * JARVIS Holographic Arc Reactor Core.
 *
 * Inspired by Tony Stark's Mark VII laboratory interface:
 * Volumetric luminous energy core surrounded by holographic HUD rings,
 * rotating orbital telemetry arcs, segmented compass degrees,
 * dynamic audio frequency waveforms, and ambient particle dust.
 */

interface Props {
  state: JarvisState
  /** 0..1 audio amplitude */
  level: number
  size?: number
}

interface StateStyle {
  color: string
  coreGlow: string
  intensity: number
  spinSpeed: number
  breathRate: number
  bloom: number
}

const BEHAVIOUR: Record<JarvisState, StateStyle> = {
  IDLE:                     { color: '#4fd6ff', coreGlow: '#2a8db3', intensity: 0.75, spinSpeed: 0.4,  breathRate: 0.8, bloom: 0.6 },
  LISTENING:                { color: '#52e0a8', coreGlow: '#4fd6ff', intensity: 1.0,  spinSpeed: 0.9,  breathRate: 1.4, bloom: 0.9 },
  UNDERSTANDING:            { color: '#6ba8ff', coreGlow: '#4fd6ff', intensity: 0.9,  spinSpeed: 1.2,  breathRate: 1.8, bloom: 0.8 },
  THINKING:                 { color: '#9d8cff', coreGlow: '#6ba8ff', intensity: 1.0,  spinSpeed: 1.8,  breathRate: 2.2, bloom: 0.95 },
  PLANNING:                 { color: '#9d8cff', coreGlow: '#4fd6ff', intensity: 0.85, spinSpeed: 1.4,  breathRate: 1.6, bloom: 0.75 },
  RESEARCHING:              { color: '#6ba8ff', coreGlow: '#9d8cff', intensity: 1.0,  spinSpeed: 2.2,  breathRate: 2.6, bloom: 1.0 },
  EXECUTING:                { color: '#4fd6ff', coreGlow: '#52e0a8', intensity: 1.0,  spinSpeed: 2.5,  breathRate: 3.0, bloom: 1.0 },
  WAITING_FOR_CONFIRMATION: { color: '#ffb454', coreGlow: '#ffb454', intensity: 0.9,  spinSpeed: 0.8,  breathRate: 1.2, bloom: 0.8 },
  SPEAKING:                 { color: '#4fd6ff', coreGlow: '#52e0a8', intensity: 0.95, spinSpeed: 1.1,  breathRate: 1.5, bloom: 0.85 },
  SUCCESS:                  { color: '#52e0a8', coreGlow: '#52e0a8', intensity: 0.9,  spinSpeed: 0.6,  breathRate: 1.0, bloom: 0.8 },
  WARNING:                  { color: '#ffb454', coreGlow: '#ff6b6b', intensity: 0.85, spinSpeed: 1.6,  breathRate: 1.8, bloom: 0.7 },
  INTERRUPTED:              { color: '#ffb454', coreGlow: '#ff6b6b', intensity: 0.5,  spinSpeed: 0.2,  breathRate: 0.5, bloom: 0.3 },
  ERROR:                    { color: '#ff6b6b', coreGlow: '#ff6b6b', intensity: 0.8,  spinSpeed: 0.3,  breathRate: 2.0, bloom: 0.5 },
  EMERGENCY_HALT:           { color: '#ff6b6b', coreGlow: '#ff6b6b', intensity: 0.4,  spinSpeed: 0.0,  breathRate: 0.2, bloom: 0.2 }
}

export function JarvisCore({ state, level, size = 320 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  const levelRef = useRef(level)
  const animRef = useRef({
    intensity: 0.75,
    spin: 0,
    breath: 0,
    r: 79, g: 214, b: 255
  })

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

    const cx = (size * dpr) / 2
    const cy = (size * dpr) / 2
    const baseR = (size * dpr) * 0.38

    const hexToRgb = (hex: string): [number, number, number] => {
      const n = parseInt(hex.slice(1), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }

    // Holographic particle field
    const particles = Array.from({ length: 32 }, () => ({
      angle: Math.random() * Math.PI * 2,
      dist: baseR * (0.3 + Math.random() * 0.9),
      speed: (0.2 + Math.random() * 0.6) * (Math.random() > 0.5 ? 1 : -1),
      size: 1 + Math.random() * 2,
      alpha: 0.2 + Math.random() * 0.6
    }))

    let raf = 0
    let smoothLevel = 0

    const draw = (): void => {
      const target = BEHAVIOUR[stateRef.current] ?? BEHAVIOUR.IDLE
      const cur = animRef.current
      const [tr, tg, tb] = hexToRgb(target.color)

      // Smooth interpolations
      cur.intensity += (target.intensity - cur.intensity) * 0.08
      cur.r += (tr - cur.r) * 0.08
      cur.g += (tg - cur.g) * 0.08
      cur.b += (tb - cur.b) * 0.08

      smoothLevel += (levelRef.current - smoothLevel) * 0.35
      const amp = Math.min(1, smoothLevel * 4.5)

      cur.spin += 0.008 * target.spinSpeed
      cur.breath += 0.02 * target.breathRate

      const r = Math.round(cur.r)
      const g = Math.round(cur.g)
      const b = Math.round(cur.b)
      const rgb = (a: number): string => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.save()
      ctx.translate(cx, cy)

      const breathe = 1 + Math.sin(cur.breath) * 0.05
      const coreR = baseR * 0.35 * breathe * (1 + amp * 0.2)

      // ── Layer 1: Ambient Volumetric Haze ──────────────────
      const haze = ctx.createRadialGradient(0, 0, coreR * 0.2, 0, 0, baseR * 1.3)
      haze.addColorStop(0, rgb(0.28 * cur.intensity))
      haze.addColorStop(0.3, rgb(0.12 * cur.intensity))
      haze.addColorStop(0.7, rgb(0.03 * cur.intensity))
      haze.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = haze
      ctx.beginPath()
      ctx.arc(0, 0, baseR * 1.3, 0, Math.PI * 2)
      ctx.fill()

      // ── Layer 2: Particle Dust Field ───────────────────────
      for (const p of particles) {
        p.angle += p.speed * 0.01 * target.spinSpeed
        const px = Math.cos(p.angle) * p.dist * breathe
        const py = Math.sin(p.angle) * p.dist * breathe
        ctx.fillStyle = rgb(p.alpha * cur.intensity * (0.5 + Math.sin(cur.breath + p.dist) * 0.5))
        ctx.beginPath()
        ctx.arc(px, py, p.size * dpr, 0, Math.PI * 2)
        ctx.fill()
      }

      // ── Layer 3: Outer Telemetry Compass Ring ──────────────
      const outerR = baseR * 1.05
      ctx.strokeStyle = rgb(0.18 * cur.intensity)
      ctx.lineWidth = 1 * dpr
      ctx.beginPath()
      ctx.arc(0, 0, outerR, 0, Math.PI * 2)
      ctx.stroke()

      // Compass tick marks
      const numTicks = 60
      for (let i = 0; i < numTicks; i++) {
        const a = (i / numTicks) * Math.PI * 2 + cur.spin * 0.2
        const isMajor = i % 5 === 0
        const len = (isMajor ? 6 : 3) * dpr
        const r1 = outerR - len
        const r2 = outerR
        ctx.strokeStyle = rgb((isMajor ? 0.35 : 0.15) * cur.intensity)
        ctx.lineWidth = (isMajor ? 1.5 : 0.8) * dpr
        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1)
        ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2)
        ctx.stroke()
      }

      // ── Layer 4: Segmented Rotating HUD Arcs ────────────────
      const midR = baseR * 0.82
      ctx.save()
      ctx.rotate(-cur.spin * 0.7)
      for (let i = 0; i < 4; i++) {
        const start = (i * Math.PI) / 2 + 0.15
        const end = start + Math.PI / 2 - 0.3
        ctx.strokeStyle = rgb(0.35 * cur.intensity)
        ctx.lineWidth = 2 * dpr
        ctx.beginPath()
        ctx.arc(0, 0, midR, start, end)
        ctx.stroke()

        // Corner node dots
        const dotX = Math.cos(start) * midR
        const dotY = Math.sin(start) * midR
        ctx.fillStyle = rgb(0.8 * cur.intensity)
        ctx.beginPath()
        ctx.arc(dotX, dotY, 2.5 * dpr, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()

      // ── Layer 5: Inner Counter-Rotating Bracket Ring ────────
      const innerRingR = baseR * 0.58
      ctx.save()
      ctx.rotate(cur.spin * 1.1)
      for (let i = 0; i < 3; i++) {
        const start = (i * Math.PI * 2) / 3
        const end = start + Math.PI * 0.35
        ctx.strokeStyle = rgb(0.5 * cur.intensity)
        ctx.lineWidth = 2.5 * dpr
        ctx.beginPath()
        ctx.arc(0, 0, innerRingR, start, end)
        ctx.stroke()
      }
      ctx.restore()

      // ── Layer 6: Audio Frequency Equalizer Ring ─────────────
      if (amp > 0.01 || stateRef.current === 'SPEAKING' || stateRef.current === 'LISTENING') {
        const eqR = baseR * 0.46
        const bars = 48
        for (let i = 0; i < bars; i++) {
          const a = (i / bars) * Math.PI * 2 + cur.spin
          const h = (Math.sin(i * 3 + cur.breath * 4) * 0.5 + 0.5) * amp * 22 * dpr + (2 * dpr)
          const x1 = Math.cos(a) * eqR
          const y1 = Math.sin(a) * eqR
          const x2 = Math.cos(a) * (eqR + h)
          const y2 = Math.sin(a) * (eqR + h)

          ctx.strokeStyle = rgb(0.6 * cur.intensity * (0.4 + amp * 0.6))
          ctx.lineWidth = 1.8 * dpr
          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          ctx.stroke()
        }
      }

      // ── Layer 7: Central High-Energy Arc Reactor Core ───────
      // Outermost core bloom
      const bloom = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 2.4)
      bloom.addColorStop(0, rgb(0.85 * cur.intensity))
      bloom.addColorStop(0.2, rgb(0.5 * cur.intensity))
      bloom.addColorStop(0.5, rgb(0.18 * cur.intensity))
      bloom.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = bloom
      ctx.beginPath()
      ctx.arc(0, 0, coreR * 2.4, 0, Math.PI * 2)
      ctx.fill()

      // Core sphere body
      const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR)
      coreGrad.addColorStop(0, '#ffffff')
      coreGrad.addColorStop(0.25, rgb(0.95 * cur.intensity))
      coreGrad.addColorStop(0.7, rgb(0.6 * cur.intensity))
      coreGrad.addColorStop(1, rgb(0.2 * cur.intensity))
      ctx.fillStyle = coreGrad
      ctx.beginPath()
      ctx.arc(0, 0, coreR, 0, Math.PI * 2)
      ctx.fill()

      // Inner white fusion point
      const fusionR = coreR * 0.38
      const fusion = ctx.createRadialGradient(0, 0, 0, 0, 0, fusionR)
      fusion.addColorStop(0, '#ffffff')
      fusion.addColorStop(0.6, `rgba(255,255,255,${0.9 * cur.intensity})`)
      fusion.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = fusion
      ctx.beginPath()
      ctx.arc(0, 0, fusionR, 0, Math.PI * 2)
      ctx.fill()

      // ── Layer 8: Horizontal & Vertical Lens Streaks ─────────
      if (cur.intensity > 0.4) {
        const streakAlpha = 0.25 * cur.intensity * (0.7 + Math.sin(cur.breath * 2) * 0.3)
        // Horizontal lens flare
        const streakGradH = ctx.createLinearGradient(-coreR * 3.5, 0, coreR * 3.5, 0)
        streakGradH.addColorStop(0, 'rgba(0,0,0,0)')
        streakGradH.addColorStop(0.5, rgb(streakAlpha))
        streakGradH.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.strokeStyle = streakGradH
        ctx.lineWidth = 1.5 * dpr
        ctx.beginPath()
        ctx.moveTo(-coreR * 3.5, 0)
        ctx.lineTo(coreR * 3.5, 0)
        ctx.stroke()
      }

      ctx.restore()
      raf = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(raf)
  }, [size])

  return (
    <div className="jarvis-core-wrap" style={{ width: size, height: size }}>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size, display: 'block' }}
        role="img"
        aria-label={`JARVIS holographic core: ${state.toLowerCase().replace(/_/g, ' ')}`}
      />
    </div>
  )
}

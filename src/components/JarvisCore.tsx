import { useEffect, useRef } from 'react'
import type { JarvisState } from '../../shared/types'

/**
 * The JARVIS core — a single luminous sphere of intelligence.
 *
 * No dots. No rings. No particles. No orbital mechanics.
 * A living point of light whose radiance, color, and breathing rhythm
 * communicate what the system is doing. Someone watching only this
 * should know whether JARVIS is idle, listening, thinking, or speaking.
 *
 * The waveform is drawn as a luminous ripple on the core's surface
 * when audio is flowing — not a separate ring.
 */

interface Props {
  state: JarvisState
  /** 0..1 audio amplitude */
  level: number
  size?: number
}

const BEHAVIOUR: Record<
  JarvisState,
  { color: string; intensity: number; breathRate: number; breathDepth: number; bloom: number; scale: number }
> = {
  IDLE:                     { color: '#2a8db3', intensity: 0.5,  breathRate: 0.6,  breathDepth: 0.04, bloom: 0.3,  scale: 1.0 },
  LISTENING:                { color: '#4fd6ff', intensity: 0.85, breathRate: 1.0,  breathDepth: 0.06, bloom: 0.6,  scale: 1.05 },
  UNDERSTANDING:            { color: '#6ba8ff', intensity: 0.75, breathRate: 1.4,  breathDepth: 0.05, bloom: 0.5,  scale: 1.02 },
  THINKING:                 { color: '#9d8cff', intensity: 0.9,  breathRate: 2.0,  breathDepth: 0.03, bloom: 0.7,  scale: 0.98 },
  PLANNING:                 { color: '#9d8cff', intensity: 0.7,  breathRate: 1.6,  breathDepth: 0.04, bloom: 0.5,  scale: 1.0 },
  RESEARCHING:              { color: '#6ba8ff', intensity: 0.95, breathRate: 2.4,  breathDepth: 0.04, bloom: 0.8,  scale: 1.02 },
  EXECUTING:                { color: '#4fd6ff', intensity: 1.0,  breathRate: 3.0,  breathDepth: 0.02, bloom: 0.9,  scale: 1.06 },
  WAITING_FOR_CONFIRMATION: { color: '#ffb454', intensity: 0.7,  breathRate: 1.0,  breathDepth: 0.08, bloom: 0.5,  scale: 1.0 },
  SPEAKING:                 { color: '#4fd6ff', intensity: 0.8,  breathRate: 1.2,  breathDepth: 0.05, bloom: 0.6,  scale: 1.04 },
  SUCCESS:                  { color: '#52e0a8', intensity: 0.75, breathRate: 0.8,  breathDepth: 0.05, bloom: 0.5,  scale: 1.08 },
  WARNING:                  { color: '#ffb454', intensity: 0.7,  breathRate: 1.4,  breathDepth: 0.06, bloom: 0.4,  scale: 1.0 },
  INTERRUPTED:              { color: '#ffb454', intensity: 0.4,  breathRate: 0.3,  breathDepth: 0.02, bloom: 0.2,  scale: 0.95 },
  ERROR:                    { color: '#ff6b6b', intensity: 0.6,  breathRate: 2.0,  breathDepth: 0.08, bloom: 0.3,  scale: 0.92 },
  EMERGENCY_HALT:           { color: '#ff6b6b', intensity: 0.3,  breathRate: 3.0,  breathDepth: 0.1,  bloom: 0.15, scale: 0.88 }
}

export function JarvisCore({ state, level, size = 260 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  const levelRef = useRef(level)
  const currentRef = useRef({
    ...BEHAVIOUR.IDLE,
    r: 42, g: 141, b: 179
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
    ctx.scale(dpr, dpr)

    const cx = size / 2
    const cy = size / 2
    const maxR = size * 0.38

    const hexToRgb = (hex: string): [number, number, number] => {
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
      const [tr, tg, tb] = hexToRgb(target.color)

      // Smooth interpolation
      const k = reduceMotion ? 1 : 0.05
      cur.intensity += (target.intensity - cur.intensity) * k
      cur.breathRate += (target.breathRate - cur.breathRate) * k
      cur.breathDepth += (target.breathDepth - cur.breathDepth) * k
      cur.bloom += (target.bloom - cur.bloom) * k
      cur.scale += (target.scale - cur.scale) * k
      cur.r += (tr - cur.r) * k
      cur.g += (tg - cur.g) * k
      cur.b += (tb - cur.b) * k

      const r = Math.round(cur.r)
      const g = Math.round(cur.g)
      const b = Math.round(cur.b)
      const rgb = (a: number): string => `rgba(${r},${g},${b},${a})`

      smoothLevel += (levelRef.current - smoothLevel) * 0.3
      const amp = Math.min(1, smoothLevel * 5)

      t += reduceMotion ? 0 : 0.016
      ctx.clearRect(0, 0, size, size)

      const breathe = 1 + Math.sin(t * cur.breathRate * 2) * cur.breathDepth
      const coreR = maxR * 0.32 * cur.scale * breathe * (1 + amp * 0.15)

      ctx.save()
      ctx.translate(cx, cy)

      // ── Outermost atmospheric haze ──────────────────────────
      const atmo = ctx.createRadialGradient(0, 0, coreR, 0, 0, maxR * 1.8)
      atmo.addColorStop(0, rgb(0.06 * cur.intensity))
      atmo.addColorStop(0.3, rgb(0.03 * cur.intensity))
      atmo.addColorStop(0.6, rgb(0.01 * cur.intensity))
      atmo.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = atmo
      ctx.beginPath()
      ctx.arc(0, 0, maxR * 1.8, 0, Math.PI * 2)
      ctx.fill()

      // ── Bloom layer ─────────────────────────────────────────
      const bloomR = coreR * (2.8 + amp * 0.6)
      const bloom = ctx.createRadialGradient(0, 0, coreR * 0.5, 0, 0, bloomR)
      bloom.addColorStop(0, rgb(0.35 * cur.bloom * cur.intensity))
      bloom.addColorStop(0.25, rgb(0.18 * cur.bloom * cur.intensity))
      bloom.addColorStop(0.5, rgb(0.06 * cur.bloom * cur.intensity))
      bloom.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = bloom
      ctx.beginPath()
      ctx.arc(0, 0, bloomR, 0, Math.PI * 2)
      ctx.fill()

      // ── Waveform ripple (only when audio is flowing) ────────
      if (amp > 0.02 && (stateRef.current === 'LISTENING' || stateRef.current === 'SPEAKING')) {
        const waveR = coreR * 1.6
        const waveAlpha = 0.4 * amp * cur.intensity
        ctx.strokeStyle = rgb(waveAlpha)
        ctx.lineWidth = 1.5

        for (let ring = 0; ring < 3; ring++) {
          const ringR = waveR + ring * 8
          const ringAlpha = (1 - ring * 0.3) * waveAlpha
          ctx.strokeStyle = rgb(ringAlpha)
          ctx.beginPath()
          for (let a = 0; a <= Math.PI * 2 + 0.05; a += 0.04) {
            const wobble = Math.sin(a * 5 + t * 8 + ring * 1.2) * amp * 6
              + Math.sin(a * 9 - t * 5 + ring * 0.8) * amp * 3
            const rr = ringR + wobble
            const x = Math.cos(a) * rr
            const y = Math.sin(a) * rr
            if (a === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.closePath()
          ctx.stroke()
        }
      }

      // ── Main core glow ──────────────────────────────────────
      const coreGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 2)
      coreGlow.addColorStop(0, rgb(0.95 * cur.intensity))
      coreGlow.addColorStop(0.15, rgb(0.7 * cur.intensity))
      coreGlow.addColorStop(0.4, rgb(0.25 * cur.intensity))
      coreGlow.addColorStop(0.7, rgb(0.06 * cur.intensity))
      coreGlow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = coreGlow
      ctx.beginPath()
      ctx.arc(0, 0, coreR * 2, 0, Math.PI * 2)
      ctx.fill()

      // ── Inner bright core ───────────────────────────────────
      const innerGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR)
      innerGrad.addColorStop(0, `rgba(255,255,255,${0.95 * cur.intensity})`)
      innerGrad.addColorStop(0.2, rgb(0.9 * cur.intensity))
      innerGrad.addColorStop(0.6, rgb(0.5 * cur.intensity))
      innerGrad.addColorStop(1, rgb(0.15 * cur.intensity))
      ctx.fillStyle = innerGrad
      ctx.beginPath()
      ctx.arc(0, 0, coreR, 0, Math.PI * 2)
      ctx.fill()

      // ── Bright center point ─────────────────────────────────
      const dotR = coreR * 0.35
      const dot = ctx.createRadialGradient(0, 0, 0, 0, 0, dotR)
      dot.addColorStop(0, `rgba(255,255,255,${0.98 * cur.intensity})`)
      dot.addColorStop(0.5, `rgba(255,255,255,${0.4 * cur.intensity})`)
      dot.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = dot
      ctx.beginPath()
      ctx.arc(0, 0, dotR, 0, Math.PI * 2)
      ctx.fill()

      // ── Subtle lens flare ───────────────────────────────────
      if (cur.intensity > 0.5) {
        const flareAlpha = 0.08 * cur.intensity * (0.7 + Math.sin(t * 0.3) * 0.3)
        // Horizontal streak
        ctx.strokeStyle = rgb(flareAlpha)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(-coreR * 3, 0)
        ctx.lineTo(coreR * 3, 0)
        ctx.stroke()
        // Vertical subtle
        ctx.strokeStyle = rgb(flareAlpha * 0.4)
        ctx.beginPath()
        ctx.moveTo(0, -coreR * 2)
        ctx.lineTo(0, coreR * 2)
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

import { useEffect, useRef } from 'react'
import type { JarvisState } from '../../shared/types'

/**
 * The JARVIS core. Layered geometry — orbital rings, particle field, and a
 * reactive waveform — driven by real state and live microphone amplitude.
 */

interface Props {
  state: JarvisState
  level: number
}

const PALETTE: Record<JarvisState, [number, number, number]> = {
  IDLE: [120, 150, 190],
  LISTENING: [94, 179, 255],
  THINKING: [124, 140, 255],
  EXECUTING: [80, 200, 220],
  WAITING_FOR_CONFIRMATION: [251, 191, 36],
  SPEAKING: [94, 179, 255],
  INTERRUPTED: [251, 191, 36],
  ERROR: [248, 113, 113]
}

interface Particle {
  angle: number
  radius: number
  speed: number
  size: number
  phase: number
}

export function Core({ state, level }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Refs so the animation loop never restarts on prop changes.
  const stateRef = useRef(state)
  const levelRef = useRef(0)
  const smoothLevel = useRef(0)
  const colorRef = useRef<[number, number, number]>(PALETTE.IDLE)

  stateRef.current = state
  levelRef.current = level

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const size = 260
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const cx = size / 2
    const cy = size / 2

    const particles: Particle[] = Array.from({ length: 46 }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: 58 + Math.random() * 44,
      speed: 0.0016 + Math.random() * 0.004,
      size: 0.7 + Math.random() * 1.5,
      phase: Math.random() * Math.PI * 2
    }))

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let t = 0

    const draw = (): void => {
      t += reduceMotion ? 0.002 : 0.01
      const s = stateRef.current

      // Ease colour transitions so state changes feel physical, not abrupt.
      const target = PALETTE[s]
      const c = colorRef.current
      for (let i = 0; i < 3; i++) c[i] += (target[i] - c[i]) * 0.06
      const rgb = `${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}`

      // Amplitude: mic level when listening, synthetic envelope when speaking.
      const raw =
        s === 'LISTENING'
          ? Math.min(1, levelRef.current * 14)
          : s === 'SPEAKING'
            ? 0.35 + Math.sin(t * 7.5) * 0.16 + Math.sin(t * 13.3) * 0.08
            : 0
      smoothLevel.current += (raw - smoothLevel.current) * 0.18
      const amp = smoothLevel.current

      const breathe = Math.sin(t * (s === 'IDLE' ? 1.1 : 2.2)) * 0.5 + 0.5
      const energy =
        s === 'EXECUTING' ? 1 : s === 'THINKING' ? 0.72 : s === 'IDLE' ? 0.22 : 0.5

      ctx.clearRect(0, 0, size, size)

      // --- outer glow ---
      const glow = ctx.createRadialGradient(cx, cy, 12, cx, cy, 118)
      glow.addColorStop(0, `rgba(${rgb}, ${0.16 + amp * 0.2 + breathe * 0.05})`)
      glow.addColorStop(0.55, `rgba(${rgb}, 0.05)`)
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, size, size)

      // --- orbital rings: tilted ellipses rotating at different rates ---
      const rings = [
        { r: 104, tilt: 0.34, rot: t * 0.24 * energy, w: 1.0, a: 0.3 },
        { r: 88, tilt: 0.62, rot: -t * 0.34 * energy, w: 0.8, a: 0.22 },
        { r: 118, tilt: 0.16, rot: t * 0.15 * energy, w: 0.7, a: 0.16 }
      ]
      for (const ring of rings) {
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(ring.rot)
        ctx.scale(1, ring.tilt)
        ctx.beginPath()
        ctx.arc(0, 0, ring.r, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${rgb}, ${ring.a + amp * 0.18})`
        ctx.lineWidth = ring.w
        ctx.stroke()
        ctx.restore()
      }

      // --- particle field ---
      for (const p of particles) {
        p.angle += p.speed * (0.4 + energy * 1.8)
        const wobble = Math.sin(t * 1.6 + p.phase) * 4
        const r = p.radius + wobble + amp * 12
        const x = cx + Math.cos(p.angle) * r
        const y = cy + Math.sin(p.angle) * r * 0.82
        const twinkle = 0.3 + (Math.sin(t * 2.4 + p.phase) * 0.5 + 0.5) * 0.55
        ctx.beginPath()
        ctx.arc(x, y, p.size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${rgb}, ${twinkle * (0.45 + energy * 0.4)})`
        ctx.fill()
      }

      // --- waveform ring: real amplitude around the core ---
      if (amp > 0.012) {
        const base = 46
        ctx.beginPath()
        for (let i = 0; i <= 96; i++) {
          const a = (i / 96) * Math.PI * 2
          const n =
            Math.sin(a * 5 + t * 5) * 0.5 + Math.sin(a * 9 - t * 3.4) * 0.3 + Math.sin(a * 3 + t * 2) * 0.2
          const r = base + n * amp * 26
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.strokeStyle = `rgba(${rgb}, ${0.5 + amp * 0.4})`
        ctx.lineWidth = 1.4
        ctx.stroke()
      }

      // --- inner sphere ---
      const coreR = 34 + breathe * (s === 'IDLE' ? 2.6 : 1.4) + amp * 7
      const sphere = ctx.createRadialGradient(cx - 9, cy - 11, 3, cx, cy, coreR)
      sphere.addColorStop(0, `rgba(255,255,255,${0.85 + amp * 0.15})`)
      sphere.addColorStop(0.32, `rgba(${rgb}, 0.75)`)
      sphere.addColorStop(1, `rgba(${rgb}, 0.06)`)
      ctx.beginPath()
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
      ctx.fillStyle = sphere
      ctx.fill()

      // Crisp rim.
      ctx.beginPath()
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${rgb}, ${0.35 + amp * 0.3})`
      ctx.lineWidth = 0.9
      ctx.stroke()

      // Thinking: a bright arc sweeping the core.
      if (s === 'THINKING' || s === 'EXECUTING') {
        const sweep = t * (s === 'EXECUTING' ? 3.4 : 2.1)
        ctx.beginPath()
        ctx.arc(cx, cy, coreR + 11, sweep, sweep + Math.PI * 0.42)
        ctx.strokeStyle = `rgba(${rgb}, 0.85)`
        ctx.lineWidth = 1.8
        ctx.lineCap = 'round'
        ctx.stroke()
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvasRef} className="core-canvas" aria-hidden="true" />
}

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * §21 — the phone as another sensor.
 *
 * Point it at a document, a screen, a sign, a photograph, and hand that to the
 * workstation: "investigate this". The capture is taken here and uploaded once;
 * everything after — reading it, researching it, deciding what it is — happens
 * on the Mac, because that is where the models and the database are.
 *
 * The stream never leaves the device. Only the single still the user chooses to
 * send is uploaded, and it goes to their own machine over the same authenticated
 * channel as everything else.
 */

interface Props {
  onClose: () => void
  onCapture: (jpegBase64: string, note: string) => Promise<void>
}

export default function Camera({ onClose, onCapture }: Props): JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [shot, setShot] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          // The rear camera is the one pointed at the world.
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
          audio: false
        })
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream.current = s
        if (video.current) {
          video.current.srcObject = s
          // `playsInline` matters on iOS or the video takes over the screen.
          await video.current.play().catch(() => undefined)
        }
      } catch (err) {
        const name = (err as { name?: string })?.name
        setError(
          name === 'NotAllowedError'
            ? 'Camera access was refused. Allow it in Settings › JARVIS.'
            : name === 'NotFoundError'
              ? 'No camera on this device.'
              : 'The camera could not be opened. This needs an HTTPS connection.'
        )
      }
    })()
    return () => {
      cancelled = true
      stream.current?.getTracks().forEach((t) => t.stop())
      stream.current = null
    }
  }, [])

  const capture = useCallback(() => {
    const v = video.current
    if (!v || !v.videoWidth) return
    const canvas = document.createElement('canvas')
    // Capped on the long edge: a document is legible well below the sensor's
    // full resolution, and the difference is seconds of upload over a phone
    // connection.
    const max = 1600
    const scale = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight))
    canvas.width = Math.round(v.videoWidth * scale)
    canvas.height = Math.round(v.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    setShot(canvas.toDataURL('image/jpeg', 0.82))
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }, [])

  const send = useCallback(async () => {
    if (!shot) return
    setSending(true)
    try {
      await onCapture(shot.split(',')[1], note.trim())
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The workstation did not accept it.')
      setSending(false)
    }
  }, [shot, note, onCapture, onClose])

  return (
    <div className="cam">
      {error ? (
        <div className="cam-error">
          <p>{error}</p>
          <button className="m-btn" onClick={onClose}>
            Close
          </button>
        </div>
      ) : shot ? (
        <>
          <img className="cam-shot" src={shot} alt="Captured" />
          <div className="cam-bar">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What should JARVIS do with this?"
              enterKeyHint="send"
            />
            <div className="cam-actions">
              <button onClick={onClose} disabled={sending}>
                Discard
              </button>
              <button className="primary" onClick={() => void send()} disabled={sending}>
                {sending ? 'Sending…' : 'Investigate'}
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <video ref={video} className="cam-view" playsInline muted autoPlay />
          <div className="cam-frame" aria-hidden />
          <div className="cam-bar">
            <div className="cam-hint">Point at a document, a screen or a sign.</div>
            <div className="cam-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="shutter" onClick={capture} aria-label="Capture" />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

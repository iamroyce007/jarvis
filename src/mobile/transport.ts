/**
 * The phone's transport.
 *
 * On the desktop `window.jarvis` is a preload bridge over Electron IPC. Here it
 * is the same shape over the network, so every component written for the
 * desktop — the storyboard, the person profile, the timeline — runs on the
 * phone with no knowledge that it moved. That is the whole point: one set of
 * components, one visual language, one implementation to keep correct.
 *
 * Downstream is an EventSource, upstream is POST. EventSource reconnects by
 * itself when the radio drops or iOS suspends the tab, which is most of what a
 * phone connection actually does.
 */

const TOKEN_KEY = 'jarvis.token'
const DEVICE_KEY = 'jarvis.device'

export interface Connection {
  status: 'unpaired' | 'connecting' | 'live' | 'lost'
  deviceName: string | null
}

type Listener = (value: unknown) => void

const listeners = new Map<string, Set<Listener>>()
let source: EventSource | null = null
let connection: Connection = { status: 'unpaired', deviceName: null }
const connectionWatchers = new Set<(c: Connection) => void>()

function setConnection(next: Partial<Connection>): void {
  connection = { ...connection, ...next }
  for (const w of connectionWatchers) w(connection)
}

export function onConnection(cb: (c: Connection) => void): () => void {
  connectionWatchers.add(cb)
  cb(connection)
  return () => connectionWatchers.delete(cb)
}

export function connectionState(): Connection {
  return connection
}

export function token(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function isPaired(): boolean {
  return token() !== null
}

/** Exchanges a pairing code for a device token. */
export async function pair(code: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name })
    })
    const body = (await res.json()) as { token?: string; name?: string; error?: string }
    if (!res.ok || !body.token) return { ok: false, error: body.error ?? 'pairing failed' }
    localStorage.setItem(TOKEN_KEY, body.token)
    localStorage.setItem(DEVICE_KEY, body.name ?? name)
    setConnection({ deviceName: body.name ?? name })
    connect()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' }
  }
}

export function unpair(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(DEVICE_KEY)
  } catch {
    /* private mode */
  }
  source?.close()
  source = null
  setConnection({ status: 'unpaired', deviceName: null })
}

/**
 * Rewrites the desktop's image URLs into ones the phone can load.
 *
 * The workstation hands out `jarvis-media://i/<payload>` — a scheme registered
 * inside Electron and meaningless anywhere else. The same payload maps onto an
 * HTTPS route served from the desktop's existing cache, so the picture arrives
 * without the phone ever contacting the publisher.
 *
 * Applied to everything crossing the bridge rather than at each call site: a
 * story carries imagery on frames, on media events and in stored records, and
 * missing one of those means a silently broken photograph.
 */
function rewriteMedia<T>(value: T): T {
  const t = token()
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (!value.startsWith('jarvis-media://i/')) return value
    const payload = value.slice('jarvis-media://i/'.length)
    return `/api/media/${payload}?token=${encodeURIComponent(t ?? '')}` as unknown as T
  }
  if (Array.isArray(value)) return value.map((v) => rewriteMedia(v)) as unknown as T
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteMedia(v)
    }
    return out as T
  }
  return value
}

/** One RPC call. Mirrors `ipcRenderer.invoke`. */
async function rpc(method: string, args: unknown[]): Promise<unknown> {
  const t = token()
  if (!t) throw new Error('unpaired')
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ method, args })
  })
  if (res.status === 401) {
    // The desktop revoked this device. Stop pretending to be connected.
    unpair()
    throw new Error('this device is no longer paired')
  }
  const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
  if (!body.ok) throw new Error(body.error ?? 'request failed')
  return rewriteMedia(body.result)
}

/**
 * Opens the event stream.
 *
 * EventSource cannot carry an Authorization header, so the token travels as a
 * query parameter on this one request. It never leaves the LAN, the connection
 * is TLS, and the server accepts it only for the stream — but it is the one
 * place the token is not in a header, which is worth knowing.
 */
function connect(): void {
  const t = token()
  if (!t) return
  source?.close()
  setConnection({ status: 'connecting' })

  const es = new EventSource(`/api/events?token=${encodeURIComponent(t)}`)
  source = es

  es.addEventListener('hello', (e) => {
    try {
      const d = JSON.parse((e as MessageEvent).data) as { device?: string }
      setConnection({ status: 'live', deviceName: d.device ?? connection.deviceName })
    } catch {
      setConnection({ status: 'live' })
    }
  })

  es.onerror = () => {
    // EventSource retries on its own; this only reflects it in the interface.
    setConnection({ status: 'lost' })
  }

  // Every channel the desktop broadcasts is re-emitted to local subscribers.
  for (const channel of listeners.keys()) attach(es, channel)
}

const attached = new WeakMap<EventSource, Set<string>>()

function attach(es: EventSource, channel: string): void {
  let set = attached.get(es)
  if (!set) {
    set = new Set()
    attached.set(es, set)
  }
  if (set.has(channel)) return
  set.add(channel)
  es.addEventListener(channel, (e) => {
    let value: unknown = null
    try {
      value = JSON.parse((e as MessageEvent).data)
    } catch {
      value = null
    }
    const rewritten = rewriteMedia(value)
    for (const cb of listeners.get(channel) ?? []) cb(rewritten)
  })
}

function subscribe(channel: string, cb: Listener): () => void {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(cb)
  if (source) attach(source, channel)
  return () => {
    set?.delete(cb)
  }
}

/**
 * The channel each API method maps to.
 *
 * Written out rather than derived, because this list is also the boundary of
 * what the phone may ask for. A generated bridge would silently grow whenever
 * the desktop did.
 */
const METHODS: Record<string, string> = {
  getSession: 'session:info',
  getState: 'jarvis:state',
  ask: 'jarvis:ask',
  interrupt: 'jarvis:interrupt',
  setConversation: 'jarvis:conversation',
  setListening: 'voice:listen',
  setMuted: 'voice:mute',
  requestVoiceAuth: 'voice:auth',
  sweep: 'maintenance:sweep',
  purgeScreenshots: 'maintenance:purge-screenshots',
  budgetState: 'budget:state',
  newSession: 'claude:new-session',
  setPersonality: 'claude:set-personality',
  spotlight: 'spotlight',
  project: 'project',
  explain: 'explain',
  recentExplanations: 'explain:recent',
  getExplanation: 'explain:get',
  research: 'brief:research',
  recentBriefings: 'brief:recent',
  getBriefing: 'brief:get',
  graphSnapshot: 'graph:snapshot',
  graphProfile: 'graph:profile',
  graphSearch: 'graph:search',
  graphChanges: 'graph:changes',
  graphStats: 'graph:stats',
  toolRegistry: 'tools:registry',
  halt: 'jarvis:halt',
  getCapabilities: 'caps:get',
  getHistory: 'history:recent',
  searchHistory: 'history:search',
  getErrors: 'errors:recent',
  watchAdd: 'watch:add',
  watchRemove: 'watch:remove',
  watchList: 'watch:list',
  watchFindings: 'watch:findings',
  watchSeen: 'watch:seen',
  mobileState: 'mobile:state'
}

/** Event channels the phone listens on. */
const EVENTS: Record<string, string> = {
  onState: 'state',
  onLevel: 'level',
  onSession: 'session',
  onIntent: 'intent',
  onTranscript: 'transcript',
  onActivity: 'activity',
  onListening: 'listening',
  onError: 'jarvis-error',
  onVoiceError: 'voice-error',
  onVoiceAuth: 'voice-auth',
  onSpotlight: 'spotlight',
  onStory: 'story',
  onStoryMedia: 'story-media',
  onBriefProgress: 'brief-progress',
  onBriefDone: 'brief-done',
  onProjection: 'projection',
  onChanges: 'changes',
  onFocusView: 'focus-view',
  onPresent: 'present',
  onGraphUpdated: 'graph-updated',
  onHalted: 'halted',
  onCapabilities: 'capabilities',
  onBudget: 'budget',
  onWatchDevelopment: 'watch-development'
}

/**
 * Installs the bridge as `window.jarvis`.
 *
 * Methods the phone has no business calling — clearing the graph, exporting
 * history, opening a macOS settings pane — are present but refuse, rather than
 * being absent: a component that calls one should fail loudly here instead of
 * crashing on `undefined is not a function` somewhere in a render.
 */
/**
 * Uploads a camera capture (§21).
 *
 * Separate from the RPC channel because it carries a megabyte or so of image
 * rather than a small JSON argument, and it wants its own size limit.
 */
export async function sendCapture(jpegBase64: string, note: string): Promise<void> {
  const t = token()
  if (!t) throw new Error('unpaired')
  const res = await fetch('/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ image: jpegBase64, note })
  })
  const body = (await res.json().catch(() => ({ ok: false, error: 'no response' }))) as {
    ok: boolean
    error?: string
  }
  if (!body.ok) throw new Error(body.error ?? 'the workstation refused the capture')
}

/**
 * Subscribes this device to notifications (§18).
 *
 * On iOS this only works once the app has been added to the Home Screen, and
 * permission must be requested from a user gesture — so this is called from a
 * tap, never on load.
 */
export async function enableNotifications(): Promise<{ ok: boolean; reason?: string }> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'This browser cannot receive notifications.' }
  }
  // iOS grants push only to an installed web app, and says so unhelpfully.
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  if (!standalone && /iPhone|iPad/.test(navigator.userAgent)) {
    return { ok: false, reason: 'Add JARVIS to your Home Screen first, then open it from there.' }
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: 'Notifications were not allowed.' }

  const t = token()
  const reg = await navigator.serviceWorker.ready
  const keyRes = await fetch('/api/push/key', { headers: { Authorization: `Bearer ${t}` } })
  const { key } = (await keyRes.json()) as { key: string }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0)
    )
  })
  await fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ subscription: sub.toJSON() })
  })
  return { ok: true }
}

export function installBridge(): void {
  const api: Record<string, unknown> = {}

  for (const [name, channel] of Object.entries(METHODS)) {
    api[name] = (...args: unknown[]) => rpc(channel, args)
  }
  for (const [name, channel] of Object.entries(EVENTS)) {
    api[name] = (cb: Listener) => subscribe(channel, cb)
  }
  for (const name of [
    'clearGraph', 'clearHistory', 'exportHistory', 'exportUsage',
    'clearErrors', 'exportErrors', 'openVoiceSettings'
  ]) {
    api[name] = async () => {
      throw new Error(`${name} is available on the workstation only`)
    }
  }

  ;(window as unknown as { jarvis: unknown }).jarvis = api

  try {
    setConnection({ deviceName: localStorage.getItem(DEVICE_KEY) })
  } catch {
    /* private mode */
  }
  if (isPaired()) connect()
}

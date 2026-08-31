import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { networkInterfaces } from 'node:os'
import { app } from 'electron'
import { log } from '../log.js'
import { ensureCertificate } from './certs.js'
import { resolveForHttp } from '../media/proxy.js'
import { toDataUri } from './qr.js'
import { vapidKeys, send as pushSend, type Subscription } from './push.js'
import { meshStatus, issueMeshCertificate, type MeshStatus } from './tailscale.js'

/**
 * The mobile bridge.
 *
 * The phone is not a separate application with its own copy of the data; it is
 * another window onto this process. It loads the same renderer bundle, runs the
 * same components against the same design tokens, and reads the same SQLite —
 * so there is exactly one canonical state and "continuity" needs no syncing
 * because there is nothing to sync.
 *
 * Transport is Server-Sent Events downstream and POST upstream, rather than a
 * WebSocket. SSE is part of Node's HTTP server and the browser's EventSource,
 * so it adds no dependency, reconnects on its own when a phone's radio drops,
 * and survives iOS suspending a background tab — all of which a raw socket
 * would have to reimplement.
 *
 * SECURITY. This listens on the local network with the full authority of the
 * desktop, so it is off unless switched on, bound to private addresses only,
 * and every request must carry a token issued through a pairing code the user
 * reads off the desktop screen. None of that is negotiable: an open port here
 * would be an unauthenticated remote control of the user's Mac.
 */

const PORT = Number(process.env.JARVIS_MOBILE_PORT ?? 8787)

/** Requests per minute per address, so a wrong guess cannot be brute-forced. */
const PAIR_ATTEMPT_LIMIT = 8

export interface MobileState {
  running: boolean
  port: number
  /** URLs the phone can use, in preference order. */
  urls: string[]
  /** Six digits, valid briefly, shown on the desktop during pairing. */
  pairingCode: string | null
  pairingExpiresAt: number | null
  fingerprint: string | null
  /** True when at least one advertised address works away from this network. */
  reachable: boolean
  /** How things stand for reaching JARVIS from outside this network. */
  mesh: MeshStatus
  /**
   * The best address as a scannable code.
   *
   * Typing `https://192.168.1.251:8787` into a phone keyboard without a typo is
   * the kind of small friction that stops a feature being used.
   */
  qr: string | null
  /** Devices that have completed pairing. */
  devices: { id: string; name: string; pairedAt: number; lastSeen: number }[]
  clients: number
}

interface Device {
  id: string
  name: string
  tokenHash: string
  pairedAt: number
  lastSeen: number
  /** Where to reach this device when the app is closed (§18). */
  push?: Subscription
}

interface Client {
  id: string
  res: ServerResponse
  deviceId: string
}

type Handler = (method: string, args: unknown[]) => Promise<unknown>

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
}

/**
 * Addresses the phone can reach this machine on.
 *
 * Two kinds, and the distinction matters:
 *
 *  - `lan`: private ranges, reachable only from the same network.
 *  - `mesh`: the CGNAT range Tailscale (and similar WireGuard meshes) assign.
 *    These are reachable from anywhere the device is signed in to the same
 *    tailnet, over an encrypted peer-to-peer link, without a port ever being
 *    exposed to the public internet.
 *
 * A public address is never advertised. Reaching JARVIS from outside the home
 * should mean joining its private network, not publishing the workstation to
 * the internet and defending it with a six-digit code.
 */
export interface Address {
  host: string
  kind: 'lan' | 'mesh'
}

function addresses(): Address[] {
  const out: Address[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      const a = ni.address
      // 100.64.0.0/10 — the carrier-grade NAT range a mesh VPN hands out.
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) {
        out.push({ host: a, kind: 'mesh' })
      } else if (
        /^10\./.test(a) ||
        /^192\.168\./.test(a) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(a)
      ) {
        out.push({ host: a, kind: 'lan' })
      }
    }
  }
  // A mesh address works everywhere the LAN one does, so it is offered first.
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'mesh' ? -1 : 1))
}

/**
 * A hostname to advertise instead of a bare address.
 *
 * Set this to a MagicDNS name (`mac.tailnet-name.ts.net`) together with a
 * certificate issued for it, and the phone gets a properly trusted HTTPS origin
 * from anywhere — which removes the one genuinely awkward step in the setup.
 */
function configuredHost(): string | null {
  const h = process.env.JARVIS_MOBILE_HOST?.trim()
  if (h && h.length > 0) return h
  // Otherwise use the mesh name, which works from anywhere and can carry a
  // genuinely trusted certificate.
  const mesh = meshStatus()
  return mesh.running && mesh.hostname ? mesh.hostname : null
}

function lanAddresses(): string[] {
  return addresses().map((a) => a.host)
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Whether an address belongs to a network JARVIS is willing to serve.
 *
 * Used as a second check on every accepted connection, because the set of
 * addresses on a machine changes while it is running — joining a network, a VPN
 * coming up — and a socket bound at start-up cannot know about that.
 */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '')
  if (a === '127.0.0.1' || a === '::1') return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return true // mesh
  if (/^10\./.test(a)) return true
  if (/^192\.168\./.test(a)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true
  if (/^fe80:/i.test(a)) return true // link-local
  if (/^f[cd]/i.test(a)) return true // unique local
  return false
}

export class MobileServer {
  private servers: Server[] = []
  private server: Server | null = null
  private clients = new Map<string, Client>()
  private devices = new Map<string, Device>()
  private pairingCode: string | null = null
  private pairingExpiresAt = 0
  private attempts = new Map<string, { n: number; at: number }>()
  private fingerprint: string | null = null
  private handler: Handler | null = null
  private webRoot: string

  constructor(webRoot: string) {
    this.webRoot = webRoot
    this.load()
  }

  /** Where paired devices are remembered between runs. */
  private storePath(): string {
    const d = join(app.getPath('userData'), 'mobile')
    mkdirSync(d, { recursive: true, mode: 0o700 })
    return join(d, 'devices.json')
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.storePath(), 'utf8')) as Device[]
      for (const d of raw) this.devices.set(d.id, d)
    } catch {
      /* first run */
    }
  }

  private persist(): void {
    try {
      // Token hashes and push endpoints. Not readable by anything else.
      writeFileSync(this.storePath(), JSON.stringify([...this.devices.values()]), { mode: 0o600 })
    } catch {
      /* not fatal */
    }
  }

  /** Routes an RPC name to the same code the desktop's IPC calls. */
  setHandler(h: Handler): void {
    this.handler = h
  }

  /** Every address worth showing the user, best first. */
  private urls(): string[] {
    const host = configuredHost()
    const out = host ? [`https://${host}:${PORT}`] : []
    for (const a of addresses()) out.push(`https://${a.host}:${PORT}`)
    return out
  }

  /**
   * The URL to put in the code.
   *
   * While pairing is open the code travels in the fragment, so scanning lands
   * on a screen with the digits already filled in. A fragment is never sent to
   * the server, so the code stays out of request logs and off the wire.
   */
  private pairingUrl(): string {
    const base = this.urls()[0] ?? `https://localhost:${PORT}`
    const open = this.pairingCode && Date.now() < this.pairingExpiresAt
    return open ? `${base}/#c=${this.pairingCode}` : base
  }

  state(): MobileState {
    return {
      running: this.servers.length > 0,
      port: PORT,
      urls: this.urls(),
      reachable: configuredHost() !== null || addresses().some((a) => a.kind === 'mesh'),
      mesh: meshStatus(),
      pairingCode: Date.now() < this.pairingExpiresAt ? this.pairingCode : null,
      pairingExpiresAt: Date.now() < this.pairingExpiresAt ? this.pairingExpiresAt : null,
      fingerprint: this.fingerprint,
      qr: this.servers.length > 0 ? toDataUri(this.pairingUrl()) : null,
      devices: [...this.devices.values()].map((d) => ({
        id: d.id,
        name: d.name,
        pairedAt: d.pairedAt,
        lastSeen: d.lastSeen
      })),
      clients: this.clients.size
    }
  }

  /**
   * Opens a pairing window.
   *
   * Six digits is enough because the window is two minutes long, attempts are
   * rate-limited per address, and the attacker has to already be on the user's
   * network to try at all.
   */
  startPairing(minutes = 2): { code: string; expiresAt: number } {
    this.pairingCode = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0')
    this.pairingExpiresAt = Date.now() + minutes * 60_000
    log(`mobile: pairing open for ${minutes} minutes`)
    return { code: this.pairingCode, expiresAt: this.pairingExpiresAt }
  }

  stopPairing(): void {
    this.pairingCode = null
    this.pairingExpiresAt = 0
  }

  revoke(deviceId: string): boolean {
    const had = this.devices.delete(deviceId)
    for (const [id, c] of this.clients) {
      if (c.deviceId === deviceId) {
        try {
          c.res.end()
        } catch {
          /* already gone */
        }
        this.clients.delete(id)
      }
    }
    if (had) this.persist()
    return had
  }

  /**
   * Notifies every subscribed device, whether or not the app is open (§18).
   *
   * Deliberately thin on detail: a notification is delivered by a third-party
   * push service and shown on a lock screen, so it says that something happened
   * and which investigation, never what was found.
   */
  async notify(title: string, body: string, data: Record<string, unknown> = {}): Promise<void> {
    for (const device of this.devices.values()) {
      if (!device.push) continue
      const result = await pushSend(device.push, { title, body, data })
      if (result.gone) {
        // The browser threw the subscription away; stop trying.
        log(`push: subscription for "${device.name}" is gone, forgetting it`)
        device.push = undefined
        this.persist()
      }
    }
  }

  /** Pushes an event to every connected phone. */
  broadcast(channel: string, payload: unknown): void {
    if (this.clients.size === 0) return
    const frame = `event: ${channel}\ndata: ${JSON.stringify(payload ?? null)}\n\n`
    for (const [id, c] of this.clients) {
      try {
        c.res.write(frame)
      } catch {
        this.clients.delete(id)
      }
    }
  }

  /**
   * The paired device behind a request, or null.
   *
   * `EventSource` cannot send an Authorization header, so the stream endpoint
   * carries its token in the query string instead. That is accepted only
   * there — every other route requires the header — so a token cannot end up
   * in a referrer or a link from an ordinary API call.
   */
  private deviceFor(req: IncomingMessage, queryToken?: string | null): Device | null {
    const auth = req.headers.authorization
    const raw = auth?.startsWith('Bearer ') ? auth.slice(7) : queryToken
    if (!raw) return null
    const hash = sha256(raw)
    for (const d of this.devices.values()) {
      if (safeEqual(d.tokenHash, hash)) {
        d.lastSeen = Date.now()
        return d
      }
    }
    return null
  }

  private rateLimited(ip: string): boolean {
    const now = Date.now()
    const rec = this.attempts.get(ip)
    if (!rec || now - rec.at > 60_000) {
      this.attempts.set(ip, { n: 1, at: now })
      return false
    }
    rec.n += 1
    return rec.n > PAIR_ATTEMPT_LIMIT
  }

  private async readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > limit) throw new Error('body too large')
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    // Everything unknown falls through to the shell, so client-side routing
    // works on a deep link.
    // The phone's shell is its own entry point: `index.html` is the desktop
    // window, which expects an Electron preload bridge that does not exist here.
    const rel = pathname === '/' ? '/mobile.html' : pathname
    const full = join(this.webRoot, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
    // Path traversal guard: the resolved file must remain inside the web root.
    if (!full.startsWith(this.webRoot)) {
      res.writeHead(403).end()
      return
    }
    const target = existsSync(full) ? full : join(this.webRoot, 'mobile.html')
    try {
      const body = readFileSync(target)
      res.writeHead(200, {
        'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
        // The shell must never be cached: a stale one would keep an old
        // transport contract alive after an update.
        'Cache-Control': extname(target) === '.html' ? 'no-store' : 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `https://localhost:${PORT}`)
    const ip = req.socket.remoteAddress ?? 'unknown'

    // ---- pairing: the only unauthenticated endpoint --------------------
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      if (this.rateLimited(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'too many attempts' }))
        return
      }
      let body: { code?: string; name?: string }
      try {
        body = JSON.parse(await this.readBody(req, 4096)) as typeof body
      } catch {
        res.writeHead(400).end()
        return
      }
      const open = this.pairingCode && Date.now() < this.pairingExpiresAt
      if (!open || !body.code || !safeEqual(String(body.code), this.pairingCode as string)) {
        log(`mobile: pairing rejected from ${ip}`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'pairing closed or code incorrect' }))
        return
      }
      const token = randomBytes(32).toString('base64url')
      const device: Device = {
        id: randomBytes(8).toString('hex'),
        name: String(body.name ?? 'iPhone').slice(0, 40),
        tokenHash: sha256(token),
        pairedAt: Date.now(),
        lastSeen: Date.now()
      }
      this.devices.set(device.id, device)
      this.persist()
      // One code pairs one device.
      this.stopPairing()
      log(`mobile: paired "${device.name}" from ${ip}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ token, deviceId: device.id, name: device.name }))
      return
    }

    // ---- everything else past this point requires a token --------------
    const isApi = url.pathname.startsWith('/api/')
    if (isApi) {
      // `EventSource` and `<img>` cannot send an Authorization header, so
      // these two routes — and only these two — accept the token as a query
      // parameter instead.
      const streamToken =
        url.pathname === '/api/events' || url.pathname.startsWith('/api/media/')
          ? url.searchParams.get('token')
          : null
      const device = this.deviceFor(req, streamToken)
      if (!device) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unpaired' }))
        return
      }

      // ---- event stream ------------------------------------------------
      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        })
        // Reconnection delay, and an immediate frame so the client knows the
        // stream is live rather than merely accepted.
        res.write('retry: 3000\n\n')
        res.write(`event: hello\ndata: ${JSON.stringify({ device: device.name })}\n\n`)
        const id = randomBytes(6).toString('hex')
        this.clients.set(id, { id, res, deviceId: device.id })
        log(`mobile: "${device.name}" connected (${this.clients.size} client(s))`)

        // iOS drops an idle connection; a comment frame keeps it open without
        // being delivered as an event.
        const beat = setInterval(() => {
          try {
            res.write(': keepalive\n\n')
          } catch {
            clearInterval(beat)
          }
        }, 20_000)

        req.on('close', () => {
          clearInterval(beat)
          this.clients.delete(id)
          log(`mobile: "${device.name}" disconnected`)
        })
        return
      }

      // ---- imagery -------------------------------------------------------
      // Served from the desktop's own cache, so the phone never contacts a
      // publisher and a photograph already fetched for the workstation is
      // reused rather than downloaded a second time.
      if (url.pathname.startsWith('/api/media/') && req.method === 'GET') {
        const payload = url.pathname.slice('/api/media/'.length)
        const hit = await resolveForHttp(payload)
        if (!hit) {
          res.writeHead(404).end()
          return
        }
        try {
          res.writeHead(200, {
            'Content-Type': hit.type,
            'Cache-Control': 'private, max-age=86400',
            'X-Content-Type-Options': 'nosniff'
          })
          res.end(readFileSync(hit.path))
        } catch {
          res.writeHead(404).end()
        }
        return
      }

      // ---- push subscription (§18) ---------------------------------------
      if (url.pathname === '/api/push' && req.method === 'POST') {
        try {
          const body = JSON.parse(await this.readBody(req, 8192)) as {
            subscription?: Subscription
          }
          device.push = body.subscription
          this.persist()
          log(
            body.subscription
              ? `mobile: "${device.name}" subscribed to notifications`
              : `mobile: "${device.name}" unsubscribed from notifications`
          )
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch {
          res.writeHead(400).end()
        }
        return
      }

      if (url.pathname === '/api/push/key' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ key: vapidKeys().publicKey }))
        return
      }

      // ---- a capture from the phone's camera (§21) -----------------------
      // The image is written to disk and its path handed to the RPC layer, so
      // the workstation reads it the same way it reads a screenshot of its own
      // screen. Uploads are capped and always JPEG — this endpoint accepts a
      // photograph, not arbitrary bytes.
      if (url.pathname === '/api/capture' && req.method === 'POST') {
        let body: { image?: string; note?: string }
        try {
          body = JSON.parse(await this.readBody(req, 12 * 1024 * 1024)) as typeof body
        } catch {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'capture too large' }))
          return
        }
        if (!body.image) {
          res.writeHead(400).end()
          return
        }
        try {
          const bytes = Buffer.from(body.image, 'base64')
          // A JPEG starts FF D8 FF. Checking is cheap and means a mislabelled
          // upload cannot become a file of another type on the user's disk.
          if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
            res.writeHead(415, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'not a JPEG' }))
            return
          }
          // Photographs of whatever the user pointed a camera at — as
          // sensitive as a screenshot, and treated the same way.
          const dir = join(app.getPath('userData'), 'captures')
          mkdirSync(dir, { recursive: true, mode: 0o700 })
          const path = join(dir, `capture-${Date.now()}.jpg`)
          writeFileSync(path, bytes, { mode: 0o600 })
          log(`mobile: capture from "${device.name}" (${Math.round(bytes.length / 1024)}KB)`)

          const result = this.handler
            ? await this.handler('capture:investigate', [path, body.note ?? ''])
            : null
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, result: result ?? null }))
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'failed' })
          )
        }
        return
      }

      // ---- RPC ----------------------------------------------------------
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        let call: { method?: string; args?: unknown[] }
        try {
          call = JSON.parse(await this.readBody(req)) as typeof call
        } catch {
          res.writeHead(400).end()
          return
        }
        if (!call.method || !this.handler) {
          res.writeHead(400).end()
          return
        }
        try {
          const result = await this.handler(call.method, call.args ?? [])
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, result: result ?? null }))
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
          )
        }
        return
      }

      res.writeHead(404).end()
      return
    }

    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    this.serveStatic(url.pathname, res)
  }

  start(): MobileState {
    if (this.servers.length > 0) return this.state()
    const hosts = lanAddresses()

    // A trusted certificate, when the mesh can issue one. This is what removes
    // the "not private" warning on the phone rather than merely making it
    // dismissible.
    const mesh = meshStatus()
    if (mesh.running && mesh.hostname && !process.env.JARVIS_TLS_CERT) {
      const dir = join(app.getPath('userData'), 'tls')
      mkdirSync(dir, { recursive: true })
      const certFile = join(dir, 'mesh.crt')
      const keyFile = join(dir, 'mesh.key')
      if (issueMeshCertificate(mesh.hostname, certFile, keyFile)) {
        process.env.JARVIS_TLS_CERT = certFile
        process.env.JARVIS_TLS_KEY = keyFile
      }
    }

    const cert = ensureCertificate(hosts)
    if (!cert) {
      log('mobile: refusing to start without TLS — the phone needs a secure context')
      return this.state()
    }
    this.fingerprint = cert.fingerprint

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      // No cross-origin access at all: the client is served from this origin.
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Referrer-Policy', 'no-referrer')

      // Belt and braces: refuse anything that did not come from a private or
      // mesh address, whatever socket it arrived on.
      const from = req.socket.remoteAddress ?? ''
      if (!isPrivateAddress(from)) {
        log(`mobile: refused a connection from ${from} — not a private address`)
        res.writeHead(403).end()
        return
      }

      this.route(req, res).catch((err) => {
        log(`mobile: request failed — ${err instanceof Error ? err.message : err}`)
        try {
          res.writeHead(500).end()
        } catch {
          /* already sent */
        }
      })
    }

    /*
     * One listener per private address, rather than one on every interface.
     *
     * `listen(PORT)` with no host binds to 0.0.0.0, which is fine behind a home
     * router and exactly wrong anywhere the machine has a public address — a
     * café, a hotel, a phone hotspot, a university network. Advertising only
     * private URLs limits what the user is told, not who can connect. Binding
     * the sockets themselves is what actually limits that.
     */
    const bindTo = ['127.0.0.1', ...addresses().map((a) => a.host)]
    for (const host of bindTo) {
      const server = createServer({ key: cert.key, cert: cert.cert }, handler)
      server.on('error', (err) => log(`mobile server error on ${host}: ${err.message}`))
      server.listen(PORT, host)
      this.servers.push(server)
    }
    this.server = this.servers[0] ?? null
    setTimeout(() => {
      const mesh = addresses().filter((a) => a.kind === 'mesh')
      log(`mobile: listening on ${bindTo.join(', ')} — private addresses only`)
      log(
        mesh.length > 0 || configuredHost()
          ? 'mobile: reachable from outside this network over the mesh'
          : 'mobile: reachable on this network only — install Tailscale for remote access'
      )
    }, 0)
    return this.state()
  }

  stop(): void {
    for (const c of this.clients.values()) {
      try {
        c.res.end()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
    for (const s of this.servers) s.close()
    this.servers = []
    this.server = null
    this.stopPairing()
    log('mobile: stopped')
  }
}

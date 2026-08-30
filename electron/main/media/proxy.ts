import { app, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log.js'

/**
 * Media proxy.
 *
 * The renderer runs under a strict Content-Security-Policy, which is why no
 * photograph has ever appeared: `img-src 'self' data:` silently refuses every
 * remote URL the research pipeline produces.
 *
 * Loosening the policy to `https:` would work and is the wrong fix — it lets
 * any page-supplied URL reach out from the renderer, exposing the user's
 * address to every publisher whose imagery we display, and it still fails
 * against the hotlink protection most news sites run.
 *
 * Instead every image is fetched here, in the main process, with a plausible
 * referrer, cached on disk, and handed back over a private scheme. The
 * renderer only ever loads `jarvis-media://…`, so the policy stays closed and
 * the second view of a story paints from disk instantly.
 */

const SCHEME = 'jarvis-media'

/** Must run before `app.whenReady()`; Chromium locks the scheme table after. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: false,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: false,
        stream: true
      }
    }
  ])
}

let cacheDir = ''
function dir(): string {
  if (!cacheDir) {
    cacheDir = join(app.getPath('userData'), 'media')
    mkdirSync(cacheDir, { recursive: true })
  }
  return cacheDir
}

const MAX_BYTES = 12 * 1024 * 1024
const MAX_CACHE_BYTES = 600 * 1024 * 1024
const TIMEOUT_MS = 15_000

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36'

/**
 * Wikimedia rate-limits generic browser user agents and asks clients to
 * identify themselves instead. Sending the Chrome string earned a steady
 * stream of 429s on exactly the portraits that matter most.
 */
const WIKIMEDIA_UA = 'JARVIS/0.1 (desktop research assistant; contact: local user) Electron/43'

function uaFor(url: string): string {
  try {
    return /wikimedia\.org$|wikipedia\.org$/.test(new URL(url).hostname)
      ? WIKIMEDIA_UA
      : CHROME_UA
  } catch {
    return CHROME_UA
  }
}

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm'
}

function extFor(url: string, contentType: string): string {
  const fromType = Object.entries(TYPES).find(([, t]) => t === contentType.split(';')[0].trim())
  if (fromType) return fromType[0]
  const m = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|mp4|webm)(?:$|\?)/i.exec(url)
  return m ? `.${m[1].toLowerCase()}` : '.jpg'
}

function keyFor(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
}

/**
 * Turns a remote image URL into one the renderer is allowed to load.
 * `pageUrl` is carried through so the fetch can present a referrer from the
 * page the image was actually found on, which is what hotlink checks want.
 */
export function mediaUrl(remote: string, pageUrl?: string): string {
  if (!remote) return remote
  if (remote.startsWith(`${SCHEME}://`)) return remote
  if (remote.startsWith('data:')) return remote
  if (!/^https?:\/\//i.test(remote)) return remote
  const payload = Buffer.from(JSON.stringify({ u: remote, r: pageUrl ?? null }), 'utf8')
    .toString('base64url')
  return `${SCHEME}://i/${payload}`
}

/** Recovers the original URL, for "open source" links and for logging. */
export function originalUrl(proxied: string): string {
  if (!proxied.startsWith(`${SCHEME}://`)) return proxied
  try {
    const payload = proxied.slice(`${SCHEME}://i/`.length)
    return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u: string }).u
  } catch {
    return proxied
  }
}

interface Cached {
  path: string
  type: string
}

/** Requests already running, so a repeated frame does not refetch. */
const inFlight = new Map<string, Promise<Cached | null>>()

async function fetchAndCache(remote: string, referrer: string | null): Promise<Cached | null> {
  const key = keyFor(remote)

  // Cache hit: any file whose stem matches, whatever the extension.
  try {
    for (const f of readdirSync(dir())) {
      if (f.startsWith(key)) {
        const ext = f.slice(key.length)
        return { path: join(dir(), f), type: TYPES[ext] ?? 'application/octet-stream' }
      }
    }
  } catch { /* first run */ }

  let origin: string | undefined
  try { origin = new URL(referrer ?? remote).origin } catch { /* ignore */ }

  const headers: Record<string, string> = {
    'User-Agent': uaFor(remote),
    Accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(referrer ? { Referer: referrer } : {}),
    ...(origin ? { Origin: origin } : {})
  }

  try {
    let res: Response | null = null
    // One retry: 429 and 503 are transient throttling, and the image being
    // throttled is usually the portrait the whole frame depends on.
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        res = await fetch(remote, { signal: controller.signal, redirect: 'follow', headers })
      } finally {
        clearTimeout(timer)
      }
      if (res.ok) break
      if (res.status !== 429 && res.status !== 503) break
      await new Promise((r) => setTimeout(r, 900 + attempt * 900))
    }

    if (!res || !res.ok) {
      log(`media: ${res?.status ?? 'no response'} for ${remote.slice(0, 110)}`)
      return null
    }

    const type = res.headers.get('content-type') ?? ''
    if (!/^(image|video)\//i.test(type) && !/\.(jpe?g|png|gif|webp|avif|svg)/i.test(remote)) {
      log(`media: refused non-image type "${type}" for ${remote.slice(0, 90)}`)
      return null
    }

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
      log(`media: size ${buf.byteLength} out of range for ${remote.slice(0, 90)}`)
      return null
    }

    const ext = extFor(remote, type)
    const path = join(dir(), key + ext)
    writeFileSync(path, buf)
    return { path, type: TYPES[ext] ?? type.split(';')[0] ?? 'image/jpeg' }
  } catch (err) {
    log(`media: failed ${remote.slice(0, 90)} — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** A 1×1 transparent PNG, so a failed image degrades to blank rather than broken. */
const BLANK = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

/** Must run after `app.whenReady()`. */
export function installMediaProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    let remote = ''
    let referrer: string | null = null
    try {
      const payload = request.url.slice(`${SCHEME}://i/`.length).replace(/[?#].*$/, '')
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        u: string
        r: string | null
      }
      remote = parsed.u
      referrer = parsed.r
    } catch {
      return new Response(BLANK, { status: 400, headers: { 'Content-Type': 'image/png' } })
    }

    if (!/^https?:\/\//i.test(remote)) {
      return new Response(BLANK, { status: 400, headers: { 'Content-Type': 'image/png' } })
    }

    let job = inFlight.get(remote)
    if (!job) {
      job = fetchAndCache(remote, referrer).finally(() => inFlight.delete(remote))
      inFlight.set(remote, job)
    }
    const hit = await job

    if (!hit) {
      // 200 with a blank pixel: a 404 makes Chromium log a console error for
      // every frame, which drowns out real diagnostics.
      return new Response(BLANK, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }
      })
    }

    try {
      return new Response(readFileSync(hit.path), {
        status: 200,
        headers: {
          'Content-Type': hit.type,
          'Cache-Control': 'public, max-age=604800'
        }
      })
    } catch {
      return new Response(BLANK, { status: 200, headers: { 'Content-Type': 'image/png' } })
    }
  })

  log('media: jarvis-media:// ready')
  setTimeout(prune, 30_000)
}

/** Keeps the cache bounded, oldest first. Cheap enough to run at startup. */
export function prune(): void {
  try {
    const files = readdirSync(dir())
      .map((f) => {
        const p = join(dir(), f)
        const s = statSync(p)
        return { p, size: s.size, at: s.mtimeMs }
      })
      .sort((a, b) => b.at - a.at)

    let total = 0
    for (const f of files) {
      total += f.size
      if (total > MAX_CACHE_BYTES) {
        try { unlinkSync(f.p) } catch { /* ignore */ }
      }
    }
  } catch { /* nothing cached yet */ }
}

/** Warms the cache for URLs the UI is about to ask for. */
export async function prefetch(urls: { url: string; pageUrl?: string }[]): Promise<void> {
  await Promise.all(
    urls.slice(0, 24).map(async ({ url, pageUrl }) => {
      if (!/^https?:\/\//i.test(url)) return
      let job = inFlight.get(url)
      if (!job) {
        job = fetchAndCache(url, pageUrl ?? null).finally(() => inFlight.delete(url))
        inFlight.set(url, job)
      }
      await job
    })
  )
}

export { SCHEME as MEDIA_SCHEME }

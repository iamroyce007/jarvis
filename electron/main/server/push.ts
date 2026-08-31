import {
  createECDH, createHmac, createCipheriv, createSign,
  generateKeyPairSync, randomBytes, createPublicKey, createPrivateKey
} from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { log } from '../log.js'

/**
 * Web Push.
 *
 * A phone with the app closed still needs to hear that something happened, and
 * the event stream only exists while the app is open. Push is the only channel
 * iOS offers a web app for that, and it works from 16.4 onward once the app has
 * been added to the Home Screen.
 *
 * Implemented here rather than pulled in, like everything else in this project.
 * Two specifications are involved and both are exacting: RFC 8291 for the
 * payload encryption and RFC 8292 for the voluntary identification that lets a
 * push service accept a message from this machine at all. Getting either subtly
 * wrong produces a notification that silently never arrives, so the encryption
 * is checked against the test vector in RFC 8291 itself.
 */

const b64 = (b: Buffer): string => b.toString('base64url')

// ── VAPID identity ──────────────────────────────────────────────────────────

export interface Vapid {
  publicKey: string
  privateKeyPem: string
}

let vapid: Vapid | null = null

/**
 * The server's identity, generated once and kept.
 *
 * Push subscriptions are bound to the key that created them, so regenerating
 * this invalidates every device already subscribed.
 */
export function vapidKeys(): Vapid {
  if (vapid) return vapid
  const dir = join(app.getPath('userData'), 'push')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'vapid.json')
  if (existsSync(file)) {
    try {
      vapid = JSON.parse(readFileSync(file, 'utf8')) as Vapid
      return vapid
    } catch {
      /* regenerate below */
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  // The application server key the browser expects is the raw uncompressed
  // point, not the DER wrapper Node hands back.
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)
  vapid = {
    publicKey: b64(raw),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  }
  writeFileSync(file, JSON.stringify(vapid))
  log('push: generated a new VAPID identity')
  return vapid
}

/** ES256 over the JWT, with the signature converted from DER to raw r‖s. */
function signJwt(header: object, payload: object, pem: string): string {
  const unsigned = `${b64(Buffer.from(JSON.stringify(header)))}.${b64(
    Buffer.from(JSON.stringify(payload))
  )}`
  const der = createSign('SHA256')
    .update(unsigned)
    .sign(createPrivateKey(pem))

  // DER: 30 len 02 rlen r 02 slen s — JOSE wants the two integers, fixed width.
  let i = 2
  if (der[1] & 0x80) i += der[1] & 0x7f
  const rLen = der[i + 1]
  const r = der.subarray(i + 2, i + 2 + rLen)
  const sLen = der[i + 2 + rLen + 1]
  const s = der.subarray(i + 2 + rLen + 2, i + 2 + rLen + 2 + sLen)
  const fixed = (x: Buffer): Buffer => {
    const out = Buffer.alloc(32)
    // Strip a leading zero DER adds to keep the integer positive; left-pad short.
    const trimmed = x.length > 32 ? x.subarray(x.length - 32) : x
    trimmed.copy(out, 32 - trimmed.length)
    return out
  }
  return `${unsigned}.${b64(Buffer.concat([fixed(r), fixed(s)]))}`
}

function authorization(endpoint: string, subject: string): string {
  const { publicKey, privateKeyPem } = vapidKeys()
  const aud = new URL(endpoint).origin
  const jwt = signJwt(
    { typ: 'JWT', alg: 'ES256' },
    // Twelve hours: push services reject anything much longer.
    { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject },
    privateKeyPem
  )
  return `vapid t=${jwt}, k=${publicKey}`
}

// ── RFC 8291 payload encryption ─────────────────────────────────────────────

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest()
  return createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length)
}

export interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/**
 * Encrypts a payload for one subscription, in `aes128gcm`.
 *
 * `salt` and `ephemeral` are parameters only so the RFC's test vector can be
 * reproduced exactly; in use they are random, as they must be.
 */
export function encrypt(
  payload: Buffer,
  sub: Subscription,
  salt = randomBytes(16),
  ephemeral?: Buffer
): Buffer {
  const clientPublic = Buffer.from(sub.keys.p256dh, 'base64url')
  const authSecret = Buffer.from(sub.keys.auth, 'base64url')

  const ecdh = createECDH('prime256v1')
  if (ephemeral) ecdh.setPrivateKey(ephemeral)
  else ecdh.generateKeys()
  const serverPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(clientPublic)

  // The key derivation is bound to both public keys, so a shared secret alone
  // cannot be replayed against a different subscription.
  const prk = hkdf(
    authSecret,
    shared,
    Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, serverPublic]),
    32
  )
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12)

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 is the final-record delimiter; there is only ever one record here.
  const body = Buffer.concat([payload, Buffer.from([0x02])])
  const encrypted = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(serverPublic.length, 20)
  return Buffer.concat([header, serverPublic, encrypted])
}

export interface PushResult {
  ok: boolean
  status: number
  /** True when the subscription is dead and should be forgotten. */
  gone: boolean
}

/** Delivers one notification. */
export async function send(
  sub: Subscription,
  payload: unknown,
  opts: { subject?: string; ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {}
): Promise<PushResult> {
  const body = encrypt(Buffer.from(JSON.stringify(payload), 'utf8'), sub)
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization(sub.endpoint, opts.subject ?? 'mailto:jarvis@localhost'),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttl ?? 3600),
        Urgency: opts.urgency ?? 'normal'
      },
      body
    })
    // 404 and 410 mean the browser threw the subscription away.
    const gone = res.status === 404 || res.status === 410
    if (!res.ok) log(`push: ${res.status} from ${new URL(sub.endpoint).host}`)
    return { ok: res.ok, status: res.status, gone }
  } catch (err) {
    log(`push failed: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, status: 0, gone: false }
  }
}

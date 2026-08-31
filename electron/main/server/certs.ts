import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { log } from '../log.js'

/**
 * A TLS certificate for the LAN server.
 *
 * This is not optional decoration. Safari treats a plain `http://` origin on a
 * private address as an insecure context, and an insecure context has no
 * microphone, no camera and no service worker — which is to say no voice, no
 * camera sensor and no installable app. The entire mobile experience depends on
 * the connection being HTTPS.
 *
 * The certificate is self-signed and generated locally, so it must be trusted
 * once on the phone. It is issued for this machine's LAN addresses with a long
 * life, so that trust is granted once rather than every time the app starts.
 */

export interface Certificate {
  key: Buffer
  cert: Buffer
  /** SHA-256 fingerprint, shown during pairing so the phone can be verified. */
  fingerprint: string
  path: string
}

function dir(): string {
  const d = join(app.getPath('userData'), 'tls')
  mkdirSync(d, { recursive: true, mode: 0o700 })
  try {
    chmodSync(d, 0o700)
  } catch {
    /* best effort */
  }
  return d
}

/**
 * Builds the OpenSSL config.
 *
 * Every address the phone might use has to be in subjectAltName: modern TLS
 * clients ignore the common name entirely, so a certificate without a matching
 * SAN entry fails even when it is trusted.
 */
function opensslConfig(hosts: string[]): string {
  const alts = hosts
    .map((h, i) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP.${i} = ${h}` : `DNS.${i} = ${h}`))
    .join('\n')
  return `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = JARVIS

[ext]
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, keyCertSign
extendedKeyUsage = serverAuth
subjectAltName = @alt

[alt]
${alts}
`
}

/**
 * Whether an existing certificate is worth keeping.
 *
 * Matching hostnames is not sufficient on its own. Two things make a stored
 * certificate useless regardless of what it was issued for:
 *
 *  - It is about to expire, and a 397-day certificate certainly will. Without
 *    this the phone simply stops connecting one day for no visible reason.
 *  - It is valid for longer than Apple accepts. Certificates issued by earlier
 *    builds of JARVIS ran for ten years, which iOS rejects outright — and
 *    because they matched on hostname they would have been reused forever,
 *    leaving the fix that shortened them with nothing to do.
 */
function stillUsable(certPath: string): boolean {
  try {
    const out = execFileSync(
      '/usr/bin/openssl',
      ['x509', '-in', certPath, '-noout', '-dates'],
      { encoding: 'utf8' }
    )
    const from = Date.parse(out.match(/notBefore=(.+)/)?.[1] ?? '')
    const until = Date.parse(out.match(/notAfter=(.+)/)?.[1] ?? '')
    if (Number.isNaN(from) || Number.isNaN(until)) return false

    const days = (until - from) / 86_400_000
    if (days > 825) {
      log('tls: stored certificate outlives what iOS accepts; reissuing')
      return false
    }
    // Renew ahead of expiry rather than on the day it breaks.
    if (until - Date.now() < 30 * 86_400_000) {
      log('tls: stored certificate expires soon; reissuing')
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Returns the certificate, generating it if the set of addresses has changed.
 *
 * A laptop's LAN address changes between networks, and a certificate issued for
 * the old one fails on the new. The address list is stored alongside the
 * certificate so a move regenerates rather than silently breaking.
 */
export function ensureCertificate(hosts: string[]): Certificate | null {
  // A real certificate, if one has been supplied.
  //
  // `tailscale cert <machine>.<tailnet>.ts.net` issues a genuine Let's Encrypt
  // certificate for the mesh hostname. Pointing JARVIS at it removes the
  // one-time trust step on the phone entirely, because the phone already
  // trusts the issuer.
  const suppliedCert = process.env.JARVIS_TLS_CERT
  const suppliedKey = process.env.JARVIS_TLS_KEY
  if (suppliedCert && suppliedKey) {
    try {
      const cert = readFileSync(suppliedCert)
      const key = readFileSync(suppliedKey)
      const fingerprint = execFileSync(
        '/usr/bin/openssl',
        ['x509', '-in', suppliedCert, '-noout', '-fingerprint', '-sha256'],
        { encoding: 'utf8' }
      )
        .replace(/^.*=/, '')
        .trim()
      log(`tls: using the supplied certificate at ${suppliedCert}`)
      return { key, cert, fingerprint, path: suppliedCert }
    } catch (err) {
      log(
        `tls: supplied certificate unusable (${err instanceof Error ? err.message : err}); ` +
          'falling back to the self-signed one'
      )
    }
  }

  const d = dir()
  const keyPath = join(d, 'jarvis.key')
  const certPath = join(d, 'jarvis.crt')
  const hostsPath = join(d, 'hosts.json')
  const wanted = [...new Set(['localhost', '127.0.0.1', ...hosts])].sort()

  let reuse = false
  try {
    reuse =
      existsSync(keyPath) &&
      existsSync(certPath) &&
      JSON.stringify(JSON.parse(readFileSync(hostsPath, 'utf8'))) === JSON.stringify(wanted) &&
      stillUsable(certPath)
  } catch {
    reuse = false
  }

  if (!reuse) {
    const cfgPath = join(d, 'openssl.cnf')
    writeFileSync(cfgPath, opensslConfig(wanted))
    try {
      execFileSync(
        '/usr/bin/openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', keyPath,
          '-out', certPath,
          // 397 days, and not a day more.
          //
          // iOS and macOS reject any TLS server certificate whose validity
          // exceeds 825 days — outright, with no "visit anyway" escape hatch.
          // This was originally issued for ten years on the reasoning that
          // re-trusting it annually would be a nuisance; the result was that
          // Safari on the iPhone refused the connection and the site could not
          // be opened at all. An annual prompt is the cost of the thing working.
          '-days', '397',
          '-config', cfgPath
        ],
        { stdio: 'ignore' }
      )
      log(`tls: issued certificate for ${wanted.join(', ')}`)
      writeFileSync(hostsPath, JSON.stringify(wanted))
      // openssl writes the key world-readable. It is the server's identity:
      // anyone who can read it can impersonate JARVIS to the phone.
      try {
        chmodSync(keyPath, 0o600)
      } catch {
        /* best effort */
      }
    } catch (err) {
      log(`tls: could not generate certificate — ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  try {
    const cert = readFileSync(certPath)
    const fingerprint = execFileSync(
      '/usr/bin/openssl',
      ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'],
      { encoding: 'utf8' }
    )
      .replace(/^.*=/, '')
      .trim()
    return { key: readFileSync(keyPath), cert, fingerprint, path: certPath }
  } catch (err) {
    log(`tls: certificate unreadable — ${err instanceof Error ? err.message : err}`)
    return null
  }
}

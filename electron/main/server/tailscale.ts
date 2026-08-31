import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { log } from '../log.js'

/**
 * Reaching JARVIS from outside the home.
 *
 * The requirement is "anywhere in the world, as long as the computer is on",
 * and there are two ways to meet it. One is to forward a port and publish the
 * workstation to the internet, defended by a six-digit code. The other is to
 * put the phone and the Mac on the same private network wherever they happen to
 * be, so nothing is exposed at all.
 *
 * This project takes the second. JARVIS can run commands on this machine and
 * read its files; an open port would be a remote control of it, and no pairing
 * code is a good enough answer to the whole internet finding it.
 *
 * Tailscale is the practical form of that: a WireGuard mesh where both devices
 * authenticate to the same account, traffic is end-to-end encrypted, and the
 * connection is peer-to-peer. Nothing here installs or configures it — that
 * needs the user's own consent and password — but JARVIS detects it, uses it
 * when present, and says plainly what is missing when it is not.
 */

const CLI_PATHS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale'
]

export interface MeshStatus {
  installed: boolean
  running: boolean
  /** MagicDNS name of this machine, when the tailnet provides one. */
  hostname: string | null
  /** The mesh address, if connected. */
  address: string | null
  /** What the user needs to do next, in one sentence. Null when nothing. */
  advice: string | null
}

function cli(): string | null {
  return CLI_PATHS.find((p) => existsSync(p)) ?? null
}

export function meshStatus(): MeshStatus {
  const bin = cli()
  if (!bin) {
    return {
      installed: false,
      running: false,
      hostname: null,
      address: null,
      advice:
        'Install Tailscale on this Mac and on the iPhone, and sign both in to the same ' +
        'account. JARVIS is then reachable from anywhere, over an encrypted link, with ' +
        'no port exposed to the internet.'
    }
  }

  try {
    const raw = execFileSync(bin, ['status', '--json'], {
      encoding: 'utf8',
      timeout: 4000
    })
    const status = JSON.parse(raw) as {
      BackendState?: string
      Self?: { DNSName?: string; TailscaleIPs?: string[] }
      MagicDNSSuffix?: string
    }
    const running = status.BackendState === 'Running'
    const dns = status.Self?.DNSName?.replace(/\.$/, '') ?? null
    const address = status.Self?.TailscaleIPs?.find((a) => a.includes('.')) ?? null

    return {
      installed: true,
      running,
      hostname: dns,
      address,
      advice: running
        ? null
        : 'Tailscale is installed but not connected. Open it and sign in, then reopen this panel.'
    }
  } catch (err) {
    log(`tailscale: ${err instanceof Error ? err.message : String(err)}`)
    return {
      installed: true,
      running: false,
      hostname: null,
      address: null,
      advice: 'Tailscale is installed but did not respond. Open it and sign in.'
    }
  }
}

/**
 * Issues a real certificate for the mesh hostname, if Tailscale can.
 *
 * This is what removes the "not private" warning on the phone entirely: the
 * certificate is a genuine Let's Encrypt one for a name the device already
 * trusts, rather than something self-signed that has to be trusted by hand.
 *
 * It requires HTTPS to be enabled for the tailnet, which is a setting in the
 * Tailscale admin console, so a failure here is expected and not an error —
 * JARVIS simply carries on with the self-signed certificate.
 */
export function issueMeshCertificate(
  hostname: string,
  certPath: string,
  keyPath: string
): boolean {
  const bin = cli()
  if (!bin) return false
  try {
    execFileSync(bin, ['cert', '--cert-file', certPath, '--key-file', keyPath, hostname], {
      timeout: 30_000,
      stdio: 'ignore'
    })
    log(`tailscale: issued a trusted certificate for ${hostname}`)
    return true
  } catch {
    log(
      `tailscale: could not issue a certificate for ${hostname} — ` +
        'enable HTTPS for the tailnet in the admin console to remove the ' +
        'certificate warning on the phone'
    )
    return false
  }
}

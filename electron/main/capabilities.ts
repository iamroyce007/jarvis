import { systemPreferences, desktopCapturer, shell, dialog } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './log.js'

const execFileAsync = promisify(execFile)

/**
 * macOS capability bootstrap.
 *
 * Everything JARVIS does to the computer runs through Claude Code, which is a
 * child process and therefore inherits JARVIS's TCC grants. Granting the app
 * Screen Recording and Accessibility is what lets Claude see the screen and
 * drive the mouse and keyboard — neither can be granted programmatically, so
 * the job here is to trigger the system prompts and point the user at the
 * right settings pane.
 */

export interface Capabilities {
  screenRecording: boolean
  accessibility: boolean
  automation: boolean
}

const PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
}

/** True when a screen frame can actually be captured, not merely claimed. */
async function canCaptureScreen(): Promise<boolean> {
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') return false
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 8, height: 8 }
    })
    // Without the grant macOS returns sources whose thumbnails are empty.
    return sources.length > 0 && !sources[0].thumbnail.isEmpty()
  } catch {
    return false
  }
}

/** Accessibility drives clicks and keystrokes; prompt only when asked to. */
export function hasAccessibility(prompt = false): boolean {
  return systemPreferences.isTrustedAccessibilityClient(prompt)
}

/** Apple Events let Claude script other apps (Safari, Finder, Music, …). */
async function canSendAppleEvents(): Promise<boolean> {
  try {
    await execFileAsync('osascript', ['-e', 'tell application "System Events" to return name of it'], {
      timeout: 8_000
    })
    return true
  } catch {
    return false
  }
}

export async function checkCapabilities(): Promise<Capabilities> {
  const [screenRecording, automation] = await Promise.all([
    canCaptureScreen(),
    canSendAppleEvents()
  ])
  return { screenRecording, accessibility: hasAccessibility(false), automation }
}

/**
 * Requests anything missing. Each grant needs a manual toggle plus, for Screen
 * Recording, a relaunch — so the user is told exactly what is outstanding
 * rather than being left with a silently half-working assistant.
 */
export async function requestCapabilities(): Promise<Capabilities> {
  const before = await checkCapabilities()
  log('capabilities before:', JSON.stringify(before))

  if (!before.screenRecording) {
    // Triggers the system prompt the first time; harmless afterwards.
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    } catch {
      /* prompt shown or already denied */
    }
  }
  if (!before.accessibility) hasAccessibility(true)
  if (!before.automation) {
    try {
      await execFileAsync('osascript', ['-e', 'tell application "System Events" to return name of it'])
    } catch {
      /* prompt shown or denied */
    }
  }

  const after = await checkCapabilities()
  log('capabilities after:', JSON.stringify(after))
  return after
}

/** Opens the exact settings pane for a capability the user still needs to grant. */
export function openCapabilityPane(which: keyof typeof PANES): void {
  void shell.openExternal(PANES[which])
}

/**
 * Shown once when a capability is missing, because the Screen Recording grant
 * does not take effect until the app is relaunched.
 */
export async function explainMissing(caps: Capabilities): Promise<void> {
  const missing: string[] = []
  if (!caps.screenRecording) missing.push('Screen Recording — so JARVIS can see your screen')
  if (!caps.accessibility) missing.push('Accessibility — so JARVIS can click and type')
  if (!caps.automation) missing.push('Automation — so JARVIS can control other apps')
  if (missing.length === 0) return

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'JARVIS needs a few permissions',
    message: 'To see your screen and control your Mac, JARVIS needs:',
    detail:
      missing.map((m) => `•  ${m}`).join('\n') +
      '\n\nTurn these on for JARVIS in System Settings › Privacy & Security, then restart JARVIS.',
    buttons: ['Open Screen Recording', 'Open Accessibility', 'Later'],
    defaultId: 0,
    cancelId: 2
  })

  if (response === 0) openCapabilityPane('screen')
  if (response === 1) openCapabilityPane('accessibility')
}

import {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  shell,
  systemPreferences
} from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { ClaudeSessionManager } from './claude/session.js'
import { resolveClaudeBinary, enrichedPath } from './claude/resolve.js'
import { VoiceController } from './voice/voice.js'
import { Orchestrator } from './orchestrator.js'
import { buildSystemPrompt, type Personality } from './persona.js'
import { DENYLIST } from './permissions.js'
import { log, LOG_PATH } from './log.js'
import {
  recordError,
  recentErrors,
  clearErrors,
  pruneErrors,
  exportErrors,
  type ErrorSource
} from './store/errors.js'
import {
  recordTurn,
  recentTurns,
  searchTurns,
  clearTurns,
  exportTurns
} from './store/conversations.js'
import type { SessionInfo, JarvisState } from '../../shared/types.js'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

const isDev = !app.isPackaged

/** The Swift helper lives beside the app in production, in native/bin during dev. */
function nativeBinary(): string {
  const rel = 'JarvisVoice.app/Contents/MacOS/jarvis-voice'
  const devPath = join(__dirname, '../../native/bin', rel)
  const prodPath = join(process.resourcesPath, 'native', rel)
  return existsSync(devPath) ? devPath : prodPath
}

let win: BrowserWindow | null = null
let tray: Tray | null = null

const workspaceRoot = homedir()

const claude = new ClaudeSessionManager({
  cwd: workspaceRoot,
  model: 'claude-sonnet-5',
  // `-p` mode has no interactive approval channel — a tool awaiting approval is
  // auto-rejected and the turn dead-ends. JARVIS therefore gates risk itself
  // (see permissions.ts) and hard-blocks destructive commands via the denylist.
  permissionMode: 'bypassPermissions',
  disallowedTools: DENYLIST,
  systemPromptAppend: buildSystemPrompt('JARVIS')
})

const voice = new VoiceController(nativeBinary())

const orchestrator = new Orchestrator(claude, voice, {
  wakeWord: 'jarvis',
  conversationTimeoutMs: 45_000,
  alwaysListening: true
})

let authStatus: string | null = null
let subscription: string | null = null
/** Set once macOS has granted speech recognition, gating the listen watchdog. */
let speechAuthorized = false
let lastListenAttempt = 0

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function sessionInfo(): SessionInfo {
  return {
    connected: claude.connected,
    sessionId: claude.sessionId,
    model: claude.model,
    cwd: workspaceRoot,
    authMethod: authStatus,
    subscription,
    lastLatencyMs: claude.lastLatencyMs,
    turns: claude.turns
  }
}

async function detectAuth(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(resolveClaudeBinary(), ['auth', 'status'], {
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: enrichedPath(),
        ANTHROPIC_API_KEY: undefined
      } as NodeJS.ProcessEnv
    })
    const parsed = JSON.parse(stdout) as {
      loggedIn?: boolean
      authMethod?: string
      subscriptionType?: string
    }
    authStatus = parsed.loggedIn ? (parsed.authMethod ?? 'unknown') : 'logged out'
    subscription = parsed.subscriptionType ?? null
  } catch {
    authStatus = 'unavailable'
  }
  send('session', sessionInfo())
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win?.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    win = null
  })
}

function trayIcon(state: JarvisState): Electron.NativeImage {
  // A simple template dot; macOS tints it for light/dark automatically.
  const filled = state !== 'IDLE'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="${filled ? 5 : 4}" fill="black" opacity="${filled ? 1 : 0.55}"/>
  </svg>`
  const img = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
  img.setTemplateImage(true)
  return img
}

function buildTray(state: JarvisState): void {
  if (!tray) tray = new Tray(trayIcon(state))
  tray.setImage(trayIcon(state))

  const menu = Menu.buildFromTemplate([
    { label: `JARVIS — ${state}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Conversation Mode',
      type: 'checkbox',
      checked: orchestrator.isConversing(),
      click: (item) => (item.checked ? orchestrator.enterConversation() : orchestrator.exitConversation())
    },
    {
      label: voice.muted ? 'Unmute Voice' : 'Silent Mode',
      click: () => {
        voice.muted = !voice.muted
        if (voice.muted) voice.shutUp()
      }
    },
    { type: 'separator' },
    { label: 'Open Command Center', click: () => (win ? win.show() : createWindow()) },
    { type: 'separator' },
    { label: 'Quit JARVIS', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(`JARVIS — ${state}`)
}

function registerShortcuts(): void {
  // Option+Space wakes JARVIS into conversation mode.
  const ok = globalShortcut.register('Alt+Space', () => {
    if (orchestrator.isConversing()) {
      orchestrator.bargeIn()
    } else {
      orchestrator.enterConversation()
      win?.show()
    }
  })
  if (!ok) console.warn('[jarvis] could not register Alt+Space')
}

function wireEvents(): void {
  orchestrator.on('state', (s) => {
    send('state', s)
    buildTray(s)
  })
  orchestrator.on('transcript', (t) => {
    send('transcript', t)
    // Partials churn several times a second; only settled turns are kept.
    if (!t.partial) {
      recordTurn(t.speaker, t.text, {
        session: claude.sessionId,
        source: 'voice',
        latencyMs: t.speaker === 'jarvis' ? claude.lastLatencyMs : null
      })
      log(`turn ${t.speaker}:`, t.text.slice(0, 200))
    }
  })
  orchestrator.on('activity', (a) => send('activity', a))
  orchestrator.on('level', (l) => send('level', l))
  orchestrator.on('session', () => send('session', sessionInfo()))
  orchestrator.on('error', (m) => send('jarvis-error', m))

  claude.on('init', (i) => {
    log('claude INIT session=', i.sessionId, 'model=', i.model)
    send('session', sessionInfo())
  })
  claude.on('exit', (e) => {
    log('claude EXIT', e)
    send('session', sessionInfo())
  })
  claude.on('result', (r) =>
    log(
      'claude result turns=',
      r.turns,
      'ms=',
      r.latencyMs,
      'err=',
      r.isError,
      r.isError ? `text=${r.text.slice(0, 300)}` : ''
    )
  )
  claude.on('result', (r) => {
    // Empty-text errors are barge-in cancellations, not faults worth recording.
    if (r.isError && r.text.trim()) {
      recordError('claude', r.text, {
        context: { turns: r.turns, latencyMs: r.latencyMs },
        session: claude.sessionId
      })
    }
  })
  claude.on('stderr', (s) => log('claude stderr:', s.trim().slice(0, 300)))
  claude.on('error', (m) => {
    log('claude ERROR:', m)
    recordError('claude', m, { severity: 'error', session: claude.sessionId })
    send('jarvis-error', m)
  })

  voice.on('error', (m) => {
    log('voice ERROR:', m)
    const source: ErrorSource = /^stt:/.test(m)
      ? 'stt'
      : /^audio:/.test(m)
        ? 'audio'
        : 'voice'
    recordError(source, m, { session: claude.sessionId })
    // SFSpeechRecognizer silently refuses to work unless macOS Dictation is on,
    // and its own message doesn't say where to turn it on.
    if (/Siri and Dictation are disabled/i.test(m)) {
      send(
        'voice-error',
        'Speech recognition needs macOS Dictation turned on: System Settings › Keyboard › Dictation. Turn it on, then restart JARVIS.'
      )
      return
    }
    send('voice-error', m)
  })
  voice.on('inputDevice', (n) => log('MIC input device:', n))
  voice.on('listening', (on) => log('listening =', on))
  // A periodic peak reading is the only reliable way to tell "no audio arriving"
  // apart from "audio arriving but too quiet to trip the VAD".
  let peak = 0
  let frames = 0
  voice.on('level', (l) => {
    peak = Math.max(peak, l)
    frames++
  })
  setInterval(() => {
    if (!voice.listening) return
    log(`mic heartbeat: frames=${frames} peak=${peak.toFixed(4)}`)
    peak = 0
    frames = 0
  }, 5_000)
  voice.on('ttsStart', (id) => log('tts start', id))
  voice.on('ttsEnd', (e) => log('tts end', e))
  voice.on('partial', (t) => log('stt partial:', t))
  voice.on('final', (t) => log('stt FINAL:', t))
  voice.on('speechStart', () => log('speech start'))
  voice.on('speechEnd', () => log('speech end'))

  voice.on('auth', (a) => {
    log('speech auth:', a.status, 'ok=', a.ok)
    send('voice-auth', a)
    // Start listening as soon as we're allowed; no button press required.
    if (a.ok) {
      speechAuthorized = true
      // Recognition accuracy depends heavily on matching the speaker's variety
      // of English; this machine's Siri locale is en-IN.
      voice.listen(process.env.JARVIS_LOCALE || 'en-IN')
      orchestrator.enterConversation()
      send('listening', true)
      // Confirms end to end that synthesis reaches the speakers.
      voice.speak('Systems online.')
      log('listening started + greeting queued')
    }
  })
  voice.on('ready', () => {
    // Downloading a Premium voice (Settings › Accessibility › Spoken Content ›
    // Manage Voices) is a large quality jump; it is picked up here by name.
    voice.configure({
      voice: process.env.JARVIS_VOICE || 'Daniel',
      rate: 0.54,
      volume: 1.0,
      vadSilenceMs: 550,
      // Apple's server model handles accents, slang and proper nouns far better
      // than the on-device one. Set JARVIS_ON_DEVICE=1 to keep audio local at
      // the cost of noticeably worse recognition.
      onDevice: process.env.JARVIS_ON_DEVICE === '1',
      contextualStrings: recognitionHints()
    })
    void requestVoicePermissions()
  })
}

/**
 * Microphone and speech recognition are two separate TCC grants. Both prompts
 * are attributed to this app, and neither can appear unless it is frontmost.
 */
async function requestVoicePermissions(): Promise<void> {
  win?.show()
  app.focus({ steal: true })

  const micStatus = systemPreferences.getMediaAccessStatus('microphone')
  log('microphone status:', micStatus)
  if (micStatus !== 'granted') {
    const granted = await systemPreferences.askForMediaAccess('microphone')
    log('microphone granted:', granted)
    if (!granted) {
      send('voice-auth', { ok: false, status: 'denied' })
      return
    }
  }
  voice.requestAuth()
}

function openPrivacySettings(pane: 'SpeechRecognition' | 'Microphone' | 'Dictation'): void {
  const url =
    pane === 'Dictation'
      ? 'x-apple.systempreferences:com.apple.preference.keyboard?Dictation'
      : `x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`
  void shell.openExternal(url)
}

/**
 * Words the recognizer should lean toward. Installed app names matter most —
 * "WhatsApp", "Xcode" and the like are otherwise transcribed phonetically.
 */
function recognitionHints(): string[] {
  const verbs = [
    'JARVIS', 'open', 'close', 'quit', 'switch to', 'play', 'pause', 'skip',
    'volume', 'search', 'run the tests', 'commit', 'push', 'deploy', 'screenshot',
    'send a message', 'reply', 'remind me', 'take a note', 'go to sleep', 'stop'
  ]
  const apps: string[] = []
  for (const dir of ['/Applications', '/System/Applications', join(homedir(), 'Applications')]) {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith('.app')) apps.push(entry.slice(0, -4))
      }
    } catch {
      /* directory may not exist */
    }
  }
  return [...verbs, ...apps].slice(0, 100)
}

function registerIpc(): void {
  ipcMain.handle('voice:open-settings', (_e, pane: 'SpeechRecognition' | 'Microphone' | 'Dictation') =>
    openPrivacySettings(pane)
  )
  ipcMain.handle('history:recent', (_e, limit?: number) => recentTurns(limit ?? 200))
  ipcMain.handle('history:search', (_e, q: string, limit?: number) => searchTurns(q, limit ?? 50))
  ipcMain.handle('history:clear', () => clearTurns())
  ipcMain.handle('history:export', async () => {
    const { writeFile } = await import('node:fs/promises')
    const out = join(homedir(), 'Desktop', `jarvis-conversations-${Date.now()}.txt`)
    await writeFile(out, exportTurns(), 'utf8')
    void shell.showItemInFolder(out)
    return out
  })

  ipcMain.handle('errors:recent', (_e, limit?: number) => recentErrors(limit ?? 200))
  ipcMain.handle('errors:clear', () => clearErrors())
  ipcMain.handle('errors:export', async () => {
    const { writeFile } = await import('node:fs/promises')
    const out = join(homedir(), 'Desktop', `jarvis-errors-${Date.now()}.txt`)
    await writeFile(out, exportErrors(), 'utf8')
    void shell.showItemInFolder(out)
    return out
  })

  ipcMain.handle('session:info', () => sessionInfo())
  ipcMain.handle('jarvis:state', () => orchestrator.getState())

  ipcMain.handle('jarvis:ask', async (_e, text: string) => {
    // Typed input bypasses the transcript event, so it is recorded here.
    recordTurn('user', text, { session: claude.sessionId, source: 'text' })
    await orchestrator.ask(text)
  })

  ipcMain.handle('jarvis:interrupt', () => orchestrator.bargeIn())
  ipcMain.handle('jarvis:conversation', (_e, on: boolean) =>
    on ? orchestrator.enterConversation() : orchestrator.exitConversation()
  )

  ipcMain.handle('voice:listen', (_e, on: boolean) => (on ? voice.listen() : voice.stopListening()))
  ipcMain.handle('voice:mute', (_e, on: boolean) => {
    voice.muted = on
    if (on) voice.shutUp()
  })
  ipcMain.handle('voice:auth', () => voice.requestAuth())

  ipcMain.handle('claude:new-session', async () => {
    await claude.newSession()
    return sessionInfo()
  })
  ipcMain.handle('claude:set-personality', async (_e, p: Personality) => {
    // Personality is part of the system prompt, so the session must restart.
    ;(claude as unknown as { opts: { systemPromptAppend: string } }).opts.systemPromptAppend =
      buildSystemPrompt(p)
    await claude.newSession()
    return sessionInfo()
  })
}

app.whenReady().then(async () => {
  app.setName('JARVIS')

  wireEvents()
  registerIpc()
  createWindow()
  buildTray('IDLE')
  registerShortcuts()

  log('log file:', LOG_PATH)
  log('pruned old error rows:', pruneErrors())
  log('voice helper path:', nativeBinary())
  voice.start()
  await claude.start(false)
  await detectAuth()
  log('claude running:', claude.isRunning, 'connected:', claude.connected, 'auth:', authStatus)
  send('session', sessionInfo())

  // JARVIS is meant to be listening whenever it is running. If the helper dies
  // or recognition stalls, bring it back without the user having to notice.
  setInterval(() => {
    if (voice.muted || !speechAuthorized) return
    if (!voice.isAlive) {
      log('watchdog: voice helper gone, restarting')
      voice.start()
      return
    }
    if (!voice.listening) {
      // With no microphone attached, retrying every few seconds just spams the
      // log; back off and let the device-change path pick it up instead.
      if (Date.now() - lastListenAttempt < 30_000) return
      lastListenAttempt = Date.now()
      log('watchdog: not listening, restarting capture')
      voice.listen(process.env.JARVIS_LOCALE || 'en-IN')
    }
  }, 5_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win?.show()
  })
})

app.on('window-all-closed', () => {
  // JARVIS keeps running in the menu bar with voice and Claude session alive.
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  voice.stop()
  claude.stop()
})

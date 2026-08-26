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
import { homedir, tmpdir } from 'node:os'
import { existsSync, readdirSync, statSync } from 'node:fs'
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
  checkCapabilities,
  requestCapabilities,
  explainMissing,
  openCapabilityPane,
  type Capabilities
} from './capabilities.js'
import {
  recordError,
  recentErrors,
  clearErrors,
  pruneErrors,
  exportErrors,
  type ErrorSource
} from './store/errors.js'
import { recordUsage, lifetimeUsage, usageSince, exportUsage } from './store/usage.js'
import {
  graphSnapshot,
  entityProfile,
  searchEntities,
  changesSince,
  graphStats,
  clearGraph
} from './store/graph.js'
import { extractFromExchange } from './intelligence/extract.js'
import { research, recentBriefings, getBriefing, isBriefingRunning } from './intelligence/briefing.js'
import { explain, isExplaining, recentExplanations, getExplanation, warmWorkers } from './intelligence/explain.js'
import { showMeSubject, spotlight } from './intelligence/spotlight.js'
import { routeIntent, needsResearch, type ViewIntent } from './intelligence/intent.js'
import { project, isProjecting } from './intelligence/scenarios.js'
import { setSessionTools, setNativeAvailability, toolRegistry } from './intelligence/tools.js'
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
let capabilities: Capabilities | null = null

/**
 * Cache-read ceiling before the session is recycled.
 *
 * Every turn re-reads the whole conversation, so cost grows with session length
 * rather than with what is said. Around 400k the context is mostly stale detail
 * from earlier turns and old screenshots.
 */
const CONTEXT_RESET_TOKENS = 400_000

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
    turns: claude.turns,
    lastUsage: claude.lastUsage,
    totalUsage: claude.totalUsage,
    lifetimeUsage: lifetimeUsage()
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
  // Each completed exchange feeds the World Graph. Extraction runs in a
  // separate cheap call so it never enlarges the conversation context.
  orchestrator.on('exchange', ({ user, assistant }) => {
    void extractFromExchange(user, assistant, { cwd: workspaceRoot }).then((r) => {
      if (r.entities || r.relations) {
        send('graph-updated', { ...graphStats(), added: r })
        // Newly learned names become recognisable in the next utterance.
        voice.configure({ contextualStrings: recognitionHints() })
      }
    })
  })

  // Research intent starts a briefing in parallel with the spoken answer, so
  // JARVIS replies immediately while the visual briefing assembles behind it.
  // ------------------------------------------------------------------ router
  // "Tony asks, JARVIS shows": the view is chosen from the meaning of the
  // question, not from a mode the user has to pick. Everything runs alongside
  // the spoken answer so speech is never blocked by assembly.
  orchestrator.on('request', (text) => {
    const intent = routeIntent(text)
    if (intent.view === 'none' || !intent.subject) return

    log(
      `intent: ${intent.view} · "${intent.subject}"` +
        (intent.inherited ? ' (inherited from context)' : '')
    )
    send('intent', intent)

    const subject = intent.subject
    const progress = (stage: string): void => send('brief-progress', { subject, stage })

    // Every visual intent runs the same fast pipeline: one research pass that
    // emits the story as soon as it parses, then streams imagery in behind it.
    const runExplain = (): void => {
      if (isExplaining()) return
      void explain(subject, {
        cwd: workspaceRoot,
        onProgress: (stage) => send('brief-progress', { subject, stage }),
        onStory: (story) => send('story', story),
        onMedia: (frameId, media) => send('story-media', { frameId, media })
      })
    }

    switch (intent.view) {
      // A bare "show me" only needs the picture, so it takes the cheap path.
      case 'spotlight':
        progress('Searching')
        void spotlight(subject, { cwd: workspaceRoot, onProgress: progress }).then((s) =>
          send('spotlight', s)
        )
        break

      case 'scenario':
        if (isProjecting()) break
        progress('Projecting')
        void project(subject, { cwd: workspaceRoot, onProgress: progress }).then((p) =>
          send('projection', p)
        )
        break

      case 'changes':
        send('changes', changesSince(24 * 60 * 60 * 1000))
        break

      // Views that read from whatever story is already on screen.
      case 'evidence':
      case 'timeline':
      case 'map':
        send('focus-view', { view: intent.view, subject })
        break

      // Everything else assembles a full storyboard.
      case 'portrait':
      case 'event':
      case 'briefing':
      case 'presentation':
        runExplain()
        break
    }
  })

  orchestrator.on('activity', (a) => send('activity', a))
  orchestrator.on('level', (l) => send('level', l))
  orchestrator.on('session', () => send('session', sessionInfo()))
  orchestrator.on('error', (m) => send('jarvis-error', m))

  claude.on('init', (i) => {
    log('claude INIT session=', i.sessionId, 'model=', i.model)
    if (Array.isArray(i.tools)) setSessionTools(i.tools)
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
    recordUsage(r.usage, { session: claude.sessionId, latencyMs: r.latencyMs })

    const u = r.usage
    const billed = u.input + u.cacheWrite + u.cacheRead
    const hit = billed ? Math.round((u.cacheRead / billed) * 100) : 0
    const s = claude.totalUsage
    // Claude Pro's limit resets on a rolling five-hour window, so that total is
    // the one that predicts being throttled.
    const win = usageSince(5 * 60 * 60 * 1000)
    const life = lifetimeUsage()

    log(
      `TOKENS turn#${r.turns} in=${u.input} out=${u.output} ` +
        `cacheR=${u.cacheRead} cacheW=${u.cacheWrite} hit=${hit}% ${r.latencyMs}ms`
    )
    log(
      `TOKENS session in=${s.input} out=${s.output} cacheR=${s.cacheRead} | ` +
        `5h-window ${win.input + win.cacheRead + win.output} over ${win.turns} turns | ` +
        `lifetime ${life.input + life.cacheRead + life.output} over ${life.turns} turns`
    )
    send('session', sessionInfo())

    // Cache reads scale with the conversation, so a long session costs more per
    // turn regardless of what is said. Past a threshold the context is worth
    // more than it costs; a fresh session resets it. Claude Code keeps its own
    // transcript, and JARVIS keeps history in SQLite, so little is truly lost.
    if (u.cacheRead > CONTEXT_RESET_TOKENS && !claude.isBusy) {
      log(`context reset: cacheRead=${u.cacheRead} exceeded ${CONTEXT_RESET_TOKENS}`)
      void claude
        .newSession()
        .then(() => {
          log('started a fresh session to shed context')
          send('session', sessionInfo())
        })
        .catch((e: unknown) => log('context reset failed:', String(e)))
    }
  })
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
    'send a message', 'reply', 'remind me', 'take a note', 'go to sleep', 'stop',
    // Phrases that start a briefing, so the recogniser locks onto them.
    'tell me everything about', 'brief me on', 'pull me information about',
    'what happened at', 'who was', 'research'
  ]

  // Names JARVIS already knows are the ones most likely to be said again, and
  // proper nouns are exactly what a 16 kHz Bluetooth mic gets wrong.
  let known: string[] = []
  try {
    known = graphSnapshot(200)
      .entities.filter((e) => e.name.length > 2 && e.name.length < 40)
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 40)
      .map((e) => e.name)
  } catch {
    /* graph may be empty on first run */
  }
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
  return [...new Set([...verbs, ...known, ...apps])].slice(0, 100)
}

/**
 * Requests that refer to something on screen rather than naming it.
 * These are exactly the cases where asking "what am I looking at?" is useless.
 */
const VISUAL_REQUEST = new RegExp(
  [
    // Explicitly about the screen.
    "\\b(screen|screenshot|display|window|showing|on\\s+screen)\\b",
    // Asking JARVIS to look.
    "\\b(look\\s+at|take\\s+a\\s+look|can\\s+you\\s+see|do\\s+you\\s+see|read\\s+(this|that|it))\\b",
    // Deictic questions that are meaningless without sight.
    "\\bwhat(\\s+is|'?s)?\\s+(this|that|it|going\\s+on|wrong|happening)\\b",
    "\\b(fix|explain|check|debug)\\s+(this|that|it)\\b",
    // Pointing at UI to act on.
    "\\b(click|press|tap|select)\\s+(this|that|it|the|on)\\b",
    "\\b(this|that)\\s+(error|button|window|tab|field|box|menu|dialog)\\b"
  ].join("|"),
  "i"
)

/**
 * Captures the screen up front for visual requests.
 *
 * Leaving the decision to Claude does not work reliably at low effort — it
 * takes the cheaper path and asks the user what they mean instead of looking.
 * Capturing here makes sight unconditional: the image is already on disk and
 * named in the prompt before Claude starts reasoning.
 */
async function captureScreen(): Promise<string | null> {
  if (!capabilities?.screenRecording) return null
  const out = join(tmpdir(), 'jarvis-screen.png')
  try {
    // -x silent, -o no shadow, -C include cursor for "click that" requests.
    await execFileAsync('screencapture', ['-x', '-o', '-C', out], { timeout: 8_000 })
    let { size } = statSync(out)
    if (size < 1024) return null

    // A retina capture is ~5120px wide and costs a great many image tokens,
    // which then sit in the conversation for every subsequent turn. 1600px is
    // still legible for UI text while being dramatically cheaper.
    try {
      await execFileAsync('sips', ['-Z', '1600', out], { timeout: 8_000 })
      size = statSync(out).size
    } catch {
      /* resizing is an optimisation, not a requirement */
    }
    log('captured screen:', out, size, 'bytes')
    return out
  } catch (err) {
    log('screen capture failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Frontmost app and window, so "fix this" has something to refer to. */
async function screenContext(utterance: string): Promise<string | null> {
  try {
    const script = `
      tell application "System Events"
        set procName to name of first process whose frontmost is true
        try
          set winName to name of front window of (first process whose frontmost is true)
        on error
          set winName to ""
        end try
      end tell
      return procName & "|" & winName`
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 4_000 })
    const [appName, windowName] = stdout.trim().split('|')
    if (!appName) return null
    const lines = [`[Context] Frontmost app: ${appName}`]
    if (windowName) lines.push(`[Context] Window: ${windowName}`)

    if (VISUAL_REQUEST.test(utterance)) {
      const shot = await captureScreen()
      if (shot) {
        lines.push(
          `[Context] A screenshot of the current screen was just saved to ${shot}.`,
          '[Context] READ THAT IMAGE FILE NOW before answering. It shows exactly what the user',
          '[Context] is looking at, so never ask them to describe their screen.'
        )
      } else if (!capabilities?.screenRecording) {
        lines.push(
          '[Context] Screen Recording permission is off, so you cannot see the screen.',
          '[Context] Say so plainly and name the setting: Privacy & Security › Screen Recording.'
        )
      }
    }
    return lines.join('\n')
  } catch {
    return null
  }
}

/** Mirrors macOS grants into the capability registry the UI displays. */
function syncNativeTools(caps: Capabilities): void {
  setNativeAvailability({
    ScreenCapture: caps.screenRecording,
    UIControl: caps.accessibility,
    AppleEvents: caps.automation,
    Voice: speechAuthorized,
    WorldGraph: true,
    History: true
  })
}

/**
 * Detects a request for a briefing and returns its subject.
 *
 * Deliberately narrow: a briefing costs a full research pass, so it fires only
 * on phrasing that is unambiguously a request to be told about something,
 * never on ordinary conversation or commands about this machine.
 */
function researchSubject(text: string): string | null {
  const t = text.trim().replace(/[?.!]+$/, '')
  const patterns: RegExp[] = [
    // "brief me on X", "give me a rundown on X", "full dossier about X"
    /^(?:jarvis[,\s]+)?(?:give me |get me |i want |show me |pull (?:me |up )?)?(?:a |an |the )?(?:full |detailed |complete |quick |all (?:the )?)?(?:brief|briefing|breakdown|rundown|profile|dossier|report|information|info|details|background)(?: me)?(?: on| about| of| regarding)\s+(.+)$/i,
    // "research X", "look into X", "dig into X"
    /^(?:jarvis[,\s]+)?(?:research|investigate|look into|dig into|find out about|read up on|brief me on)\s+(.+)$/i,
    // "tell me about X", "tell me everything about X"
    /^(?:jarvis[,\s]+)?(?:tell me|what do you know|explain)\s+(?:everything\s+|all\s+|more\s+)?about\s+(.+)$/i,
    // "who is X", "what was the X disaster"
    /^(?:jarvis[,\s]+)?who (?:is|was|are|were)\s+(.+)$/i,
    /^(?:jarvis[,\s]+)?what (?:is|was|were)\s+(?:the\s+)?(.+?(?:disaster|incident|attack|crisis|scandal|war|case|event|accident))$/i,
    /^(?:jarvis[,\s]+)?what (?:is|was) the story (?:behind|of)\s+(.+)$/i,
    // "what happened with/at/to X"
    /^(?:jarvis[,\s]+)?what happened (?:with|at|to|in|during)\s+(.+)$/i
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (m?.[1]) {
      const subject = m[1].trim()
      // Questions about this machine are handled by the normal turn, not research.
      if (/\b(my|this) (mac|computer|screen|file|project|code)\b/i.test(subject)) return null
      return subject.length >= 2 && subject.length <= 120 ? subject : null
    }
  }
  return null
}

function registerIpc(): void {
  ipcMain.handle('voice:open-settings', (_e, pane: 'SpeechRecognition' | 'Microphone' | 'Dictation') =>
    openPrivacySettings(pane)
  )
  ipcMain.handle('explain', async (_e, subject: string) => {
    return explain(subject, {
      cwd: workspaceRoot,
      onProgress: (stage) => send('brief-progress', { subject, stage }),
      onStory: (story) => send('story', story),
      onMedia: (frameId, media) => send('story-media', { frameId, media })
    })
  })
  ipcMain.handle('explain:recent', (_e, limit?: number) => recentExplanations(limit ?? 20))
  ipcMain.handle('explain:get', (_e, id: string) => getExplanation(id))

  ipcMain.handle('project', async (_e, subject: string) => {
    const p = await project(subject, {
      cwd: workspaceRoot,
      onProgress: (stage) => send('brief-progress', { subject, stage })
    })
    send('projection', p)
    return p
  })

  ipcMain.handle('spotlight', async (_e, subject: string) => {
    const s = await spotlight(subject, {
      cwd: workspaceRoot,
      onProgress: (stage) => send('brief-progress', { subject, stage })
    })
    send('spotlight', s)
    return s
  })

  ipcMain.handle('brief:research', async (_e, subject: string) => {
    const b = await research(subject, {
      cwd: workspaceRoot,
      onProgress: (stage) => send('brief-progress', { subject, stage })
    })
    send('brief-done', b)
    return b
  })
  ipcMain.handle('brief:recent', (_e, limit?: number) => recentBriefings(limit ?? 20))
  ipcMain.handle('brief:get', (_e, id: string) => getBriefing(id))
  ipcMain.handle('brief:running', () => isBriefingRunning())

  ipcMain.handle('graph:snapshot', (_e, limit?: number) => graphSnapshot(limit ?? 120))
  ipcMain.handle('graph:profile', (_e, id: string) => entityProfile(id))
  ipcMain.handle('graph:search', (_e, q: string) => searchEntities(q))
  ipcMain.handle('graph:changes', (_e, sinceMs?: number) =>
    changesSince(sinceMs ?? 24 * 60 * 60 * 1000)
  )
  ipcMain.handle('graph:stats', () => graphStats())
  ipcMain.handle('graph:clear', () => clearGraph())

  ipcMain.handle('tools:registry', () => toolRegistry())

  // Emergency stop: cancels speech, the in-flight turn and any queued work.
  ipcMain.handle('jarvis:halt', () => {
    const halted = orchestrator.halt()
    log('EMERGENCY HALT:', JSON.stringify(halted))
    send('halted', halted)
    return halted
  })

  ipcMain.handle('usage:export', async () => {
    const { writeFile } = await import('node:fs/promises')
    const out = join(homedir(), 'Desktop', `jarvis-tokens-${Date.now()}.csv`)
    await writeFile(out, exportUsage(), 'utf8')
    void shell.showItemInFolder(out)
    return out
  })

  ipcMain.handle('caps:get', async () => capabilities ?? (await checkCapabilities()))
  ipcMain.handle('caps:request', async () => {
    capabilities = await requestCapabilities()
    return capabilities
  })
  ipcMain.handle('caps:open', (_e, which: 'screen' | 'accessibility' | 'automation') =>
    openCapabilityPane(which)
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

  // Structured workers start now so the first question does not pay the CLI
  // start-up cost, which was the bulk of the old time-to-first-paint.
  void warmWorkers(workspaceRoot)

  // Sight and control. Claude Code inherits these grants as a child process.
  orchestrator.setContextProvider(screenContext)
  capabilities = await requestCapabilities()
  syncNativeTools(capabilities)
  send('capabilities', capabilities)
  if (!capabilities.screenRecording || !capabilities.accessibility) {
    void explainMissing(capabilities)
  }
  // Screen Recording only takes effect after a relaunch, so re-check as we run.
  setInterval(async () => {
    const next = await checkCapabilities()
    if (JSON.stringify(next) !== JSON.stringify(capabilities)) {
      capabilities = next
      syncNativeTools(next)
      log('capabilities changed:', JSON.stringify(next))
      send('capabilities', next)
    }
  }, 20_000)

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

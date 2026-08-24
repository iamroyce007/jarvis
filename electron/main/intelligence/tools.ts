import { DENYLIST } from '../permissions.js'

/**
 * Capability registry.
 *
 * These are the tools the Claude Code session genuinely has, populated from its
 * `init` message at runtime — not an aspirational list. Anything JARVIS cannot
 * actually do is marked unavailable rather than displayed as if it worked.
 */

export type ToolCategory =
  | 'WEB' | 'RESEARCH' | 'FILES' | 'CODE' | 'GIT' | 'DATABASE' | 'VISION'
  | 'MEMORY' | 'SYSTEM' | 'NETWORK' | 'AUTOMATION' | 'SIMULATION'
  | 'COMMUNICATION' | 'DOCUMENTS' | 'MEDIA' | 'AI'

export type RiskLevel = 'safe' | 'caution' | 'dangerous'

export interface ToolSpec {
  name: string
  category: ToolCategory
  purpose: string
  risk: RiskLevel
  /** Reported by Claude Code's init message; false means it is not loaded. */
  available: boolean
  requiresPermission?: string
}

/** Static knowledge about Claude Code's built-in tools. */
const KNOWN: Omit<ToolSpec, 'available'>[] = [
  { name: 'Bash', category: 'SYSTEM', purpose: 'Run shell commands', risk: 'dangerous' },
  { name: 'Read', category: 'FILES', purpose: 'Read files and images', risk: 'safe' },
  { name: 'Write', category: 'FILES', purpose: 'Create or overwrite files', risk: 'caution' },
  { name: 'Edit', category: 'CODE', purpose: 'Modify code in place', risk: 'caution' },
  { name: 'Glob', category: 'FILES', purpose: 'Find files by pattern', risk: 'safe' },
  { name: 'Grep', category: 'FILES', purpose: 'Search file contents', risk: 'safe' },
  { name: 'WebSearch', category: 'RESEARCH', purpose: 'Search the web', risk: 'safe' },
  { name: 'WebFetch', category: 'WEB', purpose: 'Fetch and read a page', risk: 'safe' },
  { name: 'Task', category: 'AI', purpose: 'Delegate work to a sub-agent', risk: 'caution' },
  { name: 'TodoWrite', category: 'MEMORY', purpose: 'Track multi-step plans', risk: 'safe' },
  { name: 'NotebookEdit', category: 'CODE', purpose: 'Edit Jupyter notebooks', risk: 'caution' }
]

/** Capabilities JARVIS itself provides, outside Claude Code's tool list. */
const NATIVE: Omit<ToolSpec, 'available'>[] = [
  {
    name: 'ScreenCapture',
    category: 'VISION',
    purpose: 'See what is on screen',
    risk: 'caution',
    requiresPermission: 'Screen Recording'
  },
  {
    name: 'UIControl',
    category: 'AUTOMATION',
    purpose: 'Click, type and drive applications',
    risk: 'dangerous',
    requiresPermission: 'Accessibility'
  },
  {
    name: 'AppleEvents',
    category: 'AUTOMATION',
    purpose: 'Script other applications',
    risk: 'caution',
    requiresPermission: 'Automation'
  },
  { name: 'Voice', category: 'COMMUNICATION', purpose: 'Listen and speak', risk: 'safe', requiresPermission: 'Microphone' },
  { name: 'WorldGraph', category: 'MEMORY', purpose: 'Entities, relationships and evidence', risk: 'safe' },
  { name: 'History', category: 'MEMORY', purpose: 'Durable conversation record', risk: 'safe' }
]

let sessionTools: string[] = []
let nativeAvailability: Record<string, boolean> = {}

/** Called with the tool list from Claude Code's `init` message. */
export function setSessionTools(tools: string[]): void {
  sessionTools = tools
}

/** Called when macOS capability checks change. */
export function setNativeAvailability(map: Record<string, boolean>): void {
  nativeAvailability = map
}

function isDenied(name: string): boolean {
  return DENYLIST.some((d) => d === name || d.startsWith(`${name}(`))
}

export function toolRegistry(): ToolSpec[] {
  const fromSession = KNOWN.map((t) => ({
    ...t,
    // Before the first turn Claude Code has not reported its tools yet; assume
    // the documented built-ins rather than showing everything as offline.
    available: sessionTools.length === 0 ? true : sessionTools.includes(t.name)
  }))

  const native = NATIVE.map((t) => ({
    ...t,
    available: nativeAvailability[t.name] ?? false
  }))

  // Anything on the denylist is genuinely blocked, whatever the session says.
  return [...fromSession, ...native].map((t) =>
    isDenied(t.name) ? { ...t, available: false } : t
  )
}

export function toolsByCategory(): Record<string, ToolSpec[]> {
  const out: Record<string, ToolSpec[]> = {}
  for (const t of toolRegistry()) {
    ;(out[t.category] ??= []).push(t)
  }
  return out
}

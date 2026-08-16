/**
 * JARVIS permission policy.
 *
 * Claude Code's `-p` mode has no interactive approval channel: a tool needing
 * approval is auto-rejected, which strands the conversation. So JARVIS runs the
 * session with permissions bypassed and enforces safety here instead, via a
 * denylist Claude Code applies itself plus a pre-flight check on what the user
 * asked for.
 */

/**
 * Patterns Claude Code refuses outright. These are irreversible, machine-wide,
 * or credential-exposing operations that no voice command should trigger.
 */
export const DENYLIST: string[] = [
  'Bash(rm -rf /*)',
  'Bash(rm -rf ~*)',
  'Bash(sudo rm*)',
  'Bash(mkfs*)',
  'Bash(diskutil eraseDisk*)',
  'Bash(diskutil eraseVolume*)',
  'Bash(dd if=*of=/dev/*)',
  'Bash(:(){*)',
  'Bash(shutdown*)',
  'Bash(reboot*)',
  'Bash(csrutil*)',
  'Bash(spctl --master-disable*)',
  'Bash(security dump-keychain*)',
  'Bash(security find-generic-password*)',
  'Bash(security find-internet-password*)',
  'Bash(defaults write com.apple.loginwindow*)',
  'Bash(launchctl unload -w /System*)',
  'Bash(chmod -R 777 /*)',
  'Bash(chown -R * /)',
  'Bash(curl * | sh)',
  'Bash(curl * | bash)',
  'Bash(wget * | sh)',
  'Bash(wget * | bash)'
]

export type Risk = 'SAFE' | 'CONFIRM' | 'DANGEROUS'

/** Phrases in a spoken request that warrant explicit confirmation first. */
const DANGEROUS_INTENT = [
  /\b(delete|remove|erase|wipe|destroy|nuke)\b.*\b(everything|all|disk|drive|home|system)\b/i,
  /\bformat\b.*\b(disk|drive|volume)\b/i,
  /\bfactory reset\b/i,
  /\buninstall\b.*\b(everything|all)\b/i
]

/**
 * Deliberately narrow. Ordinary engineering work — editing, deleting files,
 * installing packages, running tests, committing — must flow without
 * interruption, or conversational coding stops being conversational. Only
 * actions that reach outside the machine, spend money, or cannot be undone
 * are held back.
 */
const CONFIRM_INTENT = [
  /\b(send|email|post|publish|tweet|dm)\b.*\b(email|message|tweet|post|slack|to)\b/i,
  /\b(pay|purchase|buy|order|checkout|subscribe)\b/i,
  /\bforce.?push\b/i,
  /\b(shutdown|reboot|restart)\b.*\b(mac|computer|machine|system)\b/i
]

/** Classifies a spoken request before it reaches Claude. */
export function classify(request: string): Risk {
  if (DANGEROUS_INTENT.some((r) => r.test(request))) return 'DANGEROUS'
  if (CONFIRM_INTENT.some((r) => r.test(request))) return 'CONFIRM'
  return 'SAFE'
}

/** A short spoken question for a request that needs the user's go-ahead. */
export function confirmationPrompt(request: string, risk: Risk): string {
  return risk === 'DANGEROUS'
    ? `That would be destructive and I can't undo it. Say "confirm" if you're certain.`
    : `That will make a change I can't take back. Want me to go ahead?`
}

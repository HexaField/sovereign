/** A single entry in the slash-command registry. */
export interface SlashCommand {
  /** The command token (no leading slash) e.g. "ad4m". */
  command: string
  /** One-line description shown in the picker list. */
  description: string
  /** Optional usage hint shown as a sub-line e.g. "/ad4m watch|unwatch <url>". */
  usage?: string
}

/**
 * The canonical list of client-side slash commands — two kinds:
 *
 * LOCAL — intercepted and handled in the browser before the text reaches the
 * agent. Currently only /ad4m. These require a matching handler in InputArea.
 *
 * SKILL — forwarded to the agent as plain text. The agent reads the
 * corresponding `~/.claude/commands/<name>.md` skill file and executes it.
 * List these here so they appear in the picker for discoverability.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  // ── Local commands (handled in browser) ─────────────────────────────────
  {
    command: 'ad4m',
    description: 'Connect or disconnect an AD4M neighbourhood',
    usage: '/ad4m watch|unwatch <neighbourhood://url>'
  },

  // ── Skill commands (forwarded to agent) ─────────────────────────────────
  {
    command: 'asd-ste100',
    description: 'Rewrite text into ASD-STE100 Simplified Technical English',
    usage: '/asd-ste100 <text to rewrite>'
  },
  {
    command: 'plain-writing',
    description: 'De-AI-ify prose — remove AI tells and restore a human voice',
    usage: '/plain-writing <draft to rewrite>'
  },
  {
    command: 'word-roots',
    description: 'Query the Greek/Latin word roots database — etymology and root meanings',
    usage: '/word-roots <root, word, or concept>'
  },
  {
    command: 'electron-cdp',
    description: 'Control an Electron app (VS Code, Cursor, Discord…) via Chrome DevTools Protocol',
    usage: '/electron-cdp <app and what to do>'
  },
  {
    command: 'svg-infographic',
    description: 'Create a minimal SVG infographic for a GitHub README',
    usage: '/svg-infographic <description of what to show>'
  },
  {
    command: 'cozempic',
    description: 'Diagnose and prune bloated Claude Code context',
    usage: '/cozempic <treat|reload|guard|doctor>'
  }
]

/**
 * Return true when the current input value represents an active slash-command
 * query — i.e. it starts with "/" and the user has not yet entered argument
 * territory (no space after the command token).
 *
 * Examples:
 *   "/"        → true   (bare slash, show all commands)
 *   "/ad4m"    → true   (partial/complete token, no space yet)
 *   "/ad4m "   → false  (user started typing arguments)
 *   "hello"    → false  (not a slash command)
 */
export function isSlashQuery(value: string): boolean {
  if (!value.startsWith('/')) return false
  return !value.slice(1).includes(' ')
}

/**
 * Filter the command registry against the current input value.
 *
 * Returns all registered commands when the value is exactly "/".
 * Returns an empty array when isSlashQuery returns false.
 * Matching is case-insensitive prefix search on the command token.
 */
export function filterCommands(value: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  if (!isSlashQuery(value)) return []
  const query = value.slice(1).toLowerCase()
  if (query === '') return [...commands]
  return commands.filter((c) => c.command.toLowerCase().startsWith(query))
}

/**
 * Build the text to insert when the user selects a command from the picker.
 * The trailing space places the cursor ready for argument entry.
 */
export function buildCommandText(command: SlashCommand): string {
  return `/${command.command} `
}

/**
 * Clamp a selection index to a valid position inside a list.
 * Returns -1 (no selection) when the list is empty.
 */
export function clampIndex(index: number, listLength: number): number {
  if (listLength === 0) return -1
  return Math.max(0, Math.min(index, listLength - 1))
}

/**
 * Advance the selection index in the given direction, wrapping at both ends.
 * A current index of -1 (no selection) moves to the first or last item.
 * Returns -1 when the list is empty.
 */
export function moveIndex(current: number, direction: 'up' | 'down', listLength: number): number {
  if (listLength === 0) return -1
  if (current === -1) return direction === 'down' ? 0 : listLength - 1
  if (direction === 'down') return (current + 1) % listLength
  return (current - 1 + listLength) % listLength
}

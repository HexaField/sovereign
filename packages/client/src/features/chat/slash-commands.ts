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
 * The canonical list of client-side slash commands.
 * Only commands that the UI handles locally belong here — commands forwarded
 * to the agent as plain text should NOT be listed.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    command: 'ad4m',
    description: 'Connect or disconnect an AD4M neighbourhood',
    usage: '/ad4m watch|unwatch <neighbourhood://url>'
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

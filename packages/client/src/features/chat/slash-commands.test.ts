import { describe, it, expect } from 'vitest'
import {
  SLASH_COMMANDS,
  isSlashQuery,
  filterCommands,
  buildCommandText,
  clampIndex,
  moveIndex,
  type SlashCommand
} from './slash-commands.js'

// Fixture: predictable set of commands for tests that should not depend on
// the live SLASH_COMMANDS registry. Keeps tests stable when new commands are added.
const FIXTURE: SlashCommand[] = [
  { command: 'alpha', description: 'First command' },
  { command: 'alpha2', description: 'Prefix sibling', usage: '/alpha2 <arg>' },
  { command: 'beta', description: 'Unrelated command' }
]

// ─────────────────────────────────────────────────────────────────────────────
describe('§UI.SlashCommands', () => {
  // ── isSlashQuery ────────────────────────────────────────────────────────────
  describe('isSlashQuery', () => {
    it('returns true for a bare slash', () => {
      expect(isSlashQuery('/')).toBe(true)
    })

    it('returns true for a partial command token', () => {
      expect(isSlashQuery('/ad')).toBe(true)
    })

    it('returns true for a fully typed command with no space', () => {
      expect(isSlashQuery('/ad4m')).toBe(true)
    })

    it('returns false when a space follows the command (argument territory)', () => {
      expect(isSlashQuery('/ad4m ')).toBe(false)
    })

    it('returns false when the user has typed arguments', () => {
      expect(isSlashQuery('/ad4m watch')).toBe(false)
      expect(isSlashQuery('/ad4m watch http://example.com')).toBe(false)
    })

    it('returns false for an empty string', () => {
      expect(isSlashQuery('')).toBe(false)
    })

    it('returns false for a non-slash string', () => {
      expect(isSlashQuery('hello')).toBe(false)
    })

    it('returns false for a string starting with a space then a slash', () => {
      expect(isSlashQuery(' /ad4m')).toBe(false)
    })
  })

  // ── filterCommands ──────────────────────────────────────────────────────────
  describe('filterCommands', () => {
    it('returns all commands when value is exactly "/"', () => {
      expect(filterCommands('/', FIXTURE)).toEqual(FIXTURE)
    })

    it('filters by prefix — matches the start of the command token', () => {
      const result = filterCommands('/alpha', FIXTURE)
      expect(result.map((c) => c.command)).toEqual(['alpha', 'alpha2'])
    })

    it('returns only an exact match when there is one', () => {
      const result = filterCommands('/beta', FIXTURE)
      expect(result).toHaveLength(1)
      expect(result[0].command).toBe('beta')
    })

    it('returns empty array when no command matches the prefix', () => {
      expect(filterCommands('/xyz', FIXTURE)).toEqual([])
    })

    it('returns empty array for an empty string', () => {
      expect(filterCommands('', FIXTURE)).toEqual([])
    })

    it('returns empty array for a non-slash string', () => {
      expect(filterCommands('hello', FIXTURE)).toEqual([])
    })

    it('returns empty array when a space follows (not a slash query any more)', () => {
      expect(filterCommands('/alpha ', FIXTURE)).toEqual([])
      expect(filterCommands('/alpha2 arg', FIXTURE)).toEqual([])
    })

    it('matches case-insensitively (query lowercased, command lowercased)', () => {
      expect(filterCommands('/ALPHA', FIXTURE)).toHaveLength(2)
      expect(filterCommands('/Alpha2', FIXTURE)).toHaveLength(1)
      expect(filterCommands('/Alpha2', FIXTURE)[0].command).toBe('alpha2')
    })

    it('uses SLASH_COMMANDS as default when no commands argument is supplied', () => {
      const result = filterCommands('/')
      expect(result).toEqual([...SLASH_COMMANDS])
    })

    it('returns a new array — does not mutate the registry', () => {
      const before = SLASH_COMMANDS.length
      filterCommands('/')
      expect(SLASH_COMMANDS.length).toBe(before)
    })
  })

  // ── buildCommandText ────────────────────────────────────────────────────────
  describe('buildCommandText', () => {
    it('prepends a slash to the command name', () => {
      const cmd: SlashCommand = { command: 'ad4m', description: 'test' }
      expect(buildCommandText(cmd).startsWith('/')).toBe(true)
    })

    it('appends a trailing space to place the cursor before arguments', () => {
      const cmd: SlashCommand = { command: 'ad4m', description: 'test' }
      expect(buildCommandText(cmd).endsWith(' ')).toBe(true)
    })

    it('produces the expected insertion string', () => {
      expect(buildCommandText({ command: 'ad4m', description: '' })).toBe('/ad4m ')
    })

    it('works for any command token', () => {
      expect(buildCommandText({ command: 'foo', description: '' })).toBe('/foo ')
      expect(buildCommandText({ command: 'bar-baz', description: '' })).toBe('/bar-baz ')
    })
  })

  // ── clampIndex ──────────────────────────────────────────────────────────────
  describe('clampIndex', () => {
    it('returns -1 when the list is empty', () => {
      expect(clampIndex(0, 0)).toBe(-1)
      expect(clampIndex(5, 0)).toBe(-1)
      expect(clampIndex(-1, 0)).toBe(-1)
    })

    it('clamps negative indices to 0', () => {
      expect(clampIndex(-1, 3)).toBe(0)
      expect(clampIndex(-100, 3)).toBe(0)
    })

    it('clamps out-of-range indices to the last valid index', () => {
      expect(clampIndex(3, 3)).toBe(2)
      expect(clampIndex(10, 3)).toBe(2)
    })

    it('passes through a valid in-range index unchanged', () => {
      expect(clampIndex(0, 3)).toBe(0)
      expect(clampIndex(1, 3)).toBe(1)
      expect(clampIndex(2, 3)).toBe(2)
    })
  })

  // ── moveIndex ───────────────────────────────────────────────────────────────
  describe('moveIndex', () => {
    it('returns -1 for any direction when the list is empty', () => {
      expect(moveIndex(-1, 'down', 0)).toBe(-1)
      expect(moveIndex(-1, 'up', 0)).toBe(-1)
      expect(moveIndex(0, 'down', 0)).toBe(-1)
    })

    it('moves from -1 (no selection) to the first item on down', () => {
      expect(moveIndex(-1, 'down', 3)).toBe(0)
    })

    it('moves from -1 (no selection) to the last item on up', () => {
      expect(moveIndex(-1, 'up', 3)).toBe(2)
    })

    it('advances forward on down', () => {
      expect(moveIndex(0, 'down', 3)).toBe(1)
      expect(moveIndex(1, 'down', 3)).toBe(2)
    })

    it('retreats backward on up', () => {
      expect(moveIndex(2, 'up', 3)).toBe(1)
      expect(moveIndex(1, 'up', 3)).toBe(0)
    })

    it('wraps from the last item back to the first on down', () => {
      expect(moveIndex(2, 'down', 3)).toBe(0)
    })

    it('wraps from the first item to the last on up', () => {
      expect(moveIndex(0, 'up', 3)).toBe(2)
    })

    it('single-item list wraps to itself', () => {
      expect(moveIndex(0, 'down', 1)).toBe(0)
      expect(moveIndex(0, 'up', 1)).toBe(0)
    })
  })

  // ── SLASH_COMMANDS registry ─────────────────────────────────────────────────
  describe('SLASH_COMMANDS registry', () => {
    it('contains at least one command', () => {
      expect(SLASH_COMMANDS.length).toBeGreaterThan(0)
    })

    it('every command has a non-empty command field', () => {
      for (const cmd of SLASH_COMMANDS) {
        expect(typeof cmd.command).toBe('string')
        expect(cmd.command.length).toBeGreaterThan(0)
      }
    })

    it('every command has a description field', () => {
      for (const cmd of SLASH_COMMANDS) {
        expect(typeof cmd.description).toBe('string')
      }
    })

    it('no command token starts with a slash (slash is the trigger, not part of the name)', () => {
      for (const cmd of SLASH_COMMANDS) {
        expect(cmd.command.startsWith('/')).toBe(false)
      }
    })

    it('no two commands share the same token', () => {
      const tokens = SLASH_COMMANDS.map((c) => c.command)
      const unique = new Set(tokens)
      expect(unique.size).toBe(tokens.length)
    })

    it('ad4m command is registered', () => {
      const ad4m = SLASH_COMMANDS.find((c) => c.command === 'ad4m')
      expect(ad4m).toBeDefined()
    })

    it('ad4m command includes a usage hint', () => {
      const ad4m = SLASH_COMMANDS.find((c) => c.command === 'ad4m')
      expect(ad4m?.usage).toBeTruthy()
    })

    it('skill commands are registered in the picker', () => {
      const tokens = SLASH_COMMANDS.map((c) => c.command)
      expect(tokens).toContain('asd-ste100')
      expect(tokens).toContain('plain-writing')
      expect(tokens).toContain('word-roots')
      expect(tokens).toContain('electron-cdp')
      expect(tokens).toContain('svg-infographic')
      expect(tokens).toContain('cozempic')
    })

    it('all skill commands include a usage hint', () => {
      const skillCommands = ['asd-ste100', 'plain-writing', 'word-roots', 'electron-cdp', 'svg-infographic', 'cozempic']
      for (const token of skillCommands) {
        const cmd = SLASH_COMMANDS.find((c) => c.command === token)
        expect(cmd?.usage, `${token} should have a usage hint`).toBeTruthy()
      }
    })
  })
})

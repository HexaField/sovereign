import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerCommand, getCommands, executeCommand, searchCommands, clearCommands } from './commands.js'

describe('commands', () => {
  beforeEach(() => {
    clearCommands()
  })

  it('should register and list commands', () => {
    registerCommand({ id: 'a', label: 'Do A', action: () => {} })
    registerCommand({ id: 'b', label: 'Do B', action: () => {} })
    expect(getCommands().length).toBe(2)
  })

  it('should execute a command', () => {
    const fn = vi.fn()
    registerCommand({ id: 'test', label: 'Test', action: fn })
    expect(executeCommand('test')).toBe(true)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('should return false for unknown command', () => {
    expect(executeCommand('nope')).toBe(false)
  })

  it('should fuzzy search commands', () => {
    registerCommand({ id: 'a', label: 'Toggle Sidebar', action: () => {}, category: 'View' })
    registerCommand({ id: 'b', label: 'Toggle Terminal', action: () => {}, category: 'View' })
    registerCommand({ id: 'c', label: 'Open File', action: () => {}, category: 'File' })

    const results = searchCommands('tog')
    expect(results.length).toBe(2)
    expect(results[0].id === 'a' || results[0].id === 'b').toBe(true)
  })

  it('should return all commands for empty query', () => {
    registerCommand({ id: 'a', label: 'A', action: () => {} })
    registerCommand({ id: 'b', label: 'B', action: () => {} })
    expect(searchCommands('').length).toBe(2)
  })

  it('should return empty for non-matching query', () => {
    registerCommand({ id: 'a', label: 'Toggle', action: () => {} })
    expect(searchCommands('zzz').length).toBe(0)
  })
})

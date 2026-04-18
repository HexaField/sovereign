import { describe, it, expect } from 'vitest'
import type { ParsedTurn } from '@sovereign/core'
import { isSubagentComplete } from './SubagentView.js'

/** Shorthand to build a minimal ParsedTurn for testing */
function turn(overrides: Partial<ParsedTurn> & Pick<ParsedTurn, 'role'>): ParsedTurn {
  return {
    content: '',
    timestamp: Date.now(),
    workItems: [],
    thinkingBlocks: [],
    ...overrides
  }
}

describe('isSubagentComplete', () => {
  it('returns false for an empty turn list', () => {
    expect(isSubagentComplete([])).toBe(false)
  })

  // --- Terminal assistant turns ---

  it('returns true when last turn is a terminal assistant turn with content', () => {
    const turns: ParsedTurn[] = [
      turn({ role: 'user', content: 'do a thing' }),
      turn({ role: 'assistant', content: 'Done!' })
    ]
    expect(isSubagentComplete(turns)).toBe(true)
  })

  it('returns false when last assistant turn is still streaming', () => {
    const turns: ParsedTurn[] = [
      turn({ role: 'user', content: 'go' }),
      turn({ role: 'assistant', content: 'Working on it...', streaming: true })
    ]
    expect(isSubagentComplete(turns)).toBe(false)
  })

  it('returns false when last assistant turn is pending', () => {
    const turns: ParsedTurn[] = [
      turn({ role: 'user', content: 'go' }),
      turn({ role: 'assistant', content: 'Working on it...', pending: true })
    ]
    expect(isSubagentComplete(turns)).toBe(false)
  })

  it('returns false when last assistant turn has active work items', () => {
    const turns: ParsedTurn[] = [
      turn({ role: 'user', content: 'go' }),
      turn({
        role: 'assistant',
        content: 'Calling tool...',
        workItems: [{ type: 'tool_call', name: 'bash', timestamp: Date.now() }]
      })
    ]
    expect(isSubagentComplete(turns)).toBe(false)
  })

  it('returns false when last assistant turn has no content', () => {
    const turns: ParsedTurn[] = [turn({ role: 'user', content: 'go' }), turn({ role: 'assistant', content: '' })]
    expect(isSubagentComplete(turns)).toBe(false)
  })

  it('returns false when only user turns exist', () => {
    const turns: ParsedTurn[] = [turn({ role: 'user', content: 'hello' })]
    expect(isSubagentComplete(turns)).toBe(false)
  })

  // --- System completion/result turns ---

  it('detects system turn containing "completed"', () => {
    const turns: ParsedTurn[] = [
      turn({ role: 'user', content: 'go' }),
      turn({ role: 'system', content: 'subagent task abc123 completed' })
    ]
    expect(isSubagentComplete(turns)).toBe(true)
  })

  it('detects system turn containing "result"', () => {
    const turns: ParsedTurn[] = [
      turn({ role: 'user', content: 'go' }),
      turn({ role: 'system', content: 'Task result: success' })
    ]
    expect(isSubagentComplete(turns)).toBe(true)
  })

  it('detects system turn containing "finished"', () => {
    const turns: ParsedTurn[] = [turn({ role: 'system', content: 'Agent finished execution' })]
    expect(isSubagentComplete(turns)).toBe(true)
  })

  it('detects system turn containing "done" (case-insensitive)', () => {
    const turns: ParsedTurn[] = [turn({ role: 'system', content: 'Internal task Done' })]
    expect(isSubagentComplete(turns)).toBe(true)
  })

  it('does not match partial words in system turns (e.g. "donee")', () => {
    const turns: ParsedTurn[] = [
      turn({ role: 'system', content: 'A donee received the gift' }),
      turn({ role: 'user', content: 'waiting' })
    ]
    expect(isSubagentComplete(turns)).toBe(false)
  })

  it('detects system completion even when last turn is not the system turn', () => {
    const turns: ParsedTurn[] = [
      turn({ role: 'user', content: 'do a thing' }),
      turn({ role: 'system', content: 'subagent task completed' }),
      turn({ role: 'user', content: 'what happened?' })
    ]
    // The system turn in the middle still signals completion
    expect(isSubagentComplete(turns)).toBe(true)
  })

  it('returns false for a system turn without completion keywords', () => {
    const turns: ParsedTurn[] = [
      turn({ role: 'system', content: 'Context window compacted' }),
      turn({ role: 'user', content: 'hello' })
    ]
    expect(isSubagentComplete(turns)).toBe(false)
  })
})

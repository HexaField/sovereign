// Tests for chat streaming, turn completion, and work item handling
// Run: cd packages/server && npx vitest run src/chat/streaming.test.ts

import { describe, it, expect } from 'vitest'
import type { WorkItem, ParsedTurn } from '@sovereign/core'

// ── Test: thinking accumulation ────────────────────────────────────────

describe('thinking accumulation', () => {
  it('should accumulate thinking deltas into a single block', () => {
    const accum = new Map<string, string>()
    const emitted: WorkItem[] = []

    // Simulate 3 thinking deltas
    const deltas = ['I need to', ' check the', ' file first.']
    for (const delta of deltas) {
      const prev = accum.get('session1') ?? ''
      const accumulated = prev + delta
      accum.set('session1', accumulated)
      emitted.push({ type: 'thinking', output: accumulated, timestamp: Date.now() })
    }

    // Should have 3 emissions but the last one has the full text
    expect(emitted.length).toBe(3)
    expect(emitted[2].output).toBe('I need to check the file first.')
  })

  it('should flush thinking before tool call', () => {
    const accum = new Map<string, string>()
    accum.set('session1', 'Let me read the file')

    // On tool call, flush thinking
    const flushed = accum.get('session1')
    accum.delete('session1')

    expect(flushed).toBe('Let me read the file')
    expect(accum.has('session1')).toBe(false)
  })

  it('should flush remaining thinking on lifecycle end', () => {
    const accum = new Map<string, string>()
    accum.set('session1', 'Final thoughts')

    // On lifecycle end, flush remaining
    const flushed = accum.get('session1')
    accum.delete('session1')

    expect(flushed).toBe('Final thoughts')
  })

  it('should reset thinking on lifecycle start', () => {
    const accum = new Map<string, string>()
    accum.set('session1', 'old thinking')

    // On lifecycle start, reset
    accum.delete('session1')

    expect(accum.has('session1')).toBe(false)
  })
})

// ── Test: work item merging on turn completion ─────────────────────────

describe('work item merging', () => {
  it('should merge streaming work items into final turn', () => {
    const streamingWork: WorkItem[] = [
      { type: 'thinking', output: 'Let me check...', timestamp: 1 },
      { type: 'tool_call', name: 'exec', input: '{"command":"ls"}', toolCallId: 'tc1', timestamp: 2 },
      { type: 'tool_result', name: 'exec', output: 'file.txt', toolCallId: 'tc1', timestamp: 3 }
    ]

    const finalTurn: ParsedTurn = {
      role: 'assistant',
      content: 'Here are the files.',
      timestamp: 4,
      workItems: [],
      thinkingBlocks: []
    }

    // Merge: use streaming work items if final turn has none
    const merged: ParsedTurn = {
      ...finalTurn,
      workItems: streamingWork.length > 0 ? streamingWork : finalTurn.workItems
    }

    expect(merged.workItems.length).toBe(3)
    expect(merged.workItems[0].type).toBe('thinking')
    expect(merged.workItems[1].type).toBe('tool_call')
    expect(merged.workItems[2].type).toBe('tool_result')
    expect(merged.content).toBe('Here are the files.')
  })

  it('should prefer final turn work items if they exist', () => {
    const streamingWork: WorkItem[] = []
    const finalWork: WorkItem[] = [
      { type: 'tool_call', name: 'read', input: '{"path":"test.md"}', toolCallId: 'tc1', timestamp: 1 },
      { type: 'tool_result', name: 'read', output: '# Hello', toolCallId: 'tc1', timestamp: 2 }
    ]

    const finalTurn: ParsedTurn = {
      role: 'assistant',
      content: 'Done.',
      timestamp: 3,
      workItems: finalWork,
      thinkingBlocks: []
    }

    const merged: ParsedTurn = {
      ...finalTurn,
      workItems: streamingWork.length > 0 ? streamingWork : finalTurn.workItems
    }

    expect(merged.workItems.length).toBe(2)
    expect(merged.workItems[0].name).toBe('read')
  })
})

// ── Test: thinking replacement (not duplication) ──────────────────────

describe('thinking work item replacement', () => {
  it('should replace last thinking item instead of appending', () => {
    const workItems: WorkItem[] = [
      { type: 'tool_call', name: 'exec', input: '{}', timestamp: 1 },
      { type: 'thinking', output: 'First thought', timestamp: 2 }
    ]

    // New thinking arrives (accumulated text)
    const newThinking: WorkItem = { type: 'thinking', output: 'First thought, extended', timestamp: 3 }

    // Replace logic
    const items = [...workItems]
    let lastThinkIdx = -1
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type === 'thinking') {
        lastThinkIdx = i
        break
      }
    }
    if (lastThinkIdx >= 0) {
      items[lastThinkIdx] = newThinking
    } else {
      items.push(newThinking)
    }

    expect(items.length).toBe(2) // NOT 3
    expect(items[1].output).toBe('First thought, extended')
  })

  it('should append thinking if none exists yet', () => {
    const workItems: WorkItem[] = [{ type: 'tool_call', name: 'exec', input: '{}', timestamp: 1 }]

    const newThinking: WorkItem = { type: 'thinking', output: 'New thought', timestamp: 2 }

    const items = [...workItems]
    let lastThinkIdx = -1
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type === 'thinking') {
        lastThinkIdx = i
        break
      }
    }
    if (lastThinkIdx >= 0) {
      items[lastThinkIdx] = newThinking
    } else {
      items.push(newThinking)
    }

    expect(items.length).toBe(2)
    expect(items[1].type).toBe('thinking')
  })
})

// ── Test: idle fallback history reload ─────────────────────────────────

describe('idle → history reload fallback', () => {
  it('should reload history if no final turn arrived within timeout', async () => {
    let historyReloaded = false
    const mockReload = () => {
      historyReloaded = true
    }

    // Simulate: idle fires, no chat.turn within 800ms
    const hasFinalTurn = false

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!hasFinalTurn) {
          mockReload()
        }
        resolve()
      }, 100) // shortened for test
    })

    expect(historyReloaded).toBe(true)
  })

  it('should NOT reload history if final turn arrived', async () => {
    let historyReloaded = false
    const mockReload = () => {
      historyReloaded = true
    }

    const hasFinalTurn = true

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!hasFinalTurn) {
          mockReload()
        }
        resolve()
      }, 100)
    })

    expect(historyReloaded).toBe(false)
  })
})

// ── Test: JSONL polling for tool calls ─────────────────────────────────

describe('JSONL polling deduplication', () => {
  it('should not re-emit already-seen tool call IDs', () => {
    const seen = new Set<string>()
    const emitted: WorkItem[] = []

    const toolCalls = [
      { id: 'tc1', name: 'exec', type: 'toolCall', arguments: { command: 'ls' } },
      { id: 'tc1', name: 'exec', type: 'toolCall', arguments: { command: 'ls' } }, // duplicate
      { id: 'tc2', name: 'read', type: 'toolCall', arguments: { path: 'test.md' } }
    ]

    for (const tc of toolCalls) {
      if (tc.id && !seen.has(tc.id)) {
        seen.add(tc.id)
        emitted.push({
          type: 'tool_call',
          name: tc.name,
          input: JSON.stringify(tc.arguments),
          toolCallId: tc.id,
          timestamp: Date.now()
        })
      }
    }

    expect(emitted.length).toBe(2)
    expect(emitted[0].toolCallId).toBe('tc1')
    expect(emitted[1].toolCallId).toBe('tc2')
  })
})

// ── Test: input/output normalization ───────────────────────────────────

describe('input/output normalization', () => {
  it('should stringify object inputs', () => {
    const rawInput = { command: 'ls -la', workdir: '/tmp' }
    const normalized = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
    expect(normalized).toBe('{"command":"ls -la","workdir":"/tmp"}')
  })

  it('should pass through string inputs', () => {
    const rawInput = '{"command":"ls"}'
    const normalized = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
    expect(normalized).toBe('{"command":"ls"}')
  })

  it('should handle undefined inputs', () => {
    const rawInput = undefined
    const normalized = typeof rawInput === 'string' ? rawInput : rawInput ? JSON.stringify(rawInput) : undefined
    expect(normalized).toBeUndefined()
  })
})

// ── Test: session key derivation ───────────────────────────────────────

describe('session key derivation', () => {
  // Inline the function for testing
  function deriveSessionKey(threadKey: string): string {
    if (!threadKey) return ''
    if (threadKey.startsWith('agent:')) return threadKey
    if (threadKey === 'main') return 'agent:main:main'
    return `agent:main:thread:${threadKey.toLowerCase()}`
  }

  it('should lowercase thread key', () => {
    expect(deriveSessionKey('Companion')).toBe('agent:main:thread:companion')
  })

  it('should pass through agent: prefixed keys', () => {
    expect(deriveSessionKey('agent:main:subagent:abc')).toBe('agent:main:subagent:abc')
  })

  it('should handle main thread', () => {
    expect(deriveSessionKey('main')).toBe('agent:main:main')
  })

  it('should handle empty key', () => {
    expect(deriveSessionKey('')).toBe('')
  })
})

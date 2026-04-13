import { describe, it, expect } from 'vitest'
import { parseTurns } from './parse-turns.js'

describe('parseTurns — thinking blocks', () => {
  it('should emit separate thinking entries for interleaved text + toolCall blocks', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First thought' },
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.ts' } },
          { type: 'text', text: 'Second thought' },
          { type: 'toolCall', id: 'tc2', name: 'write', arguments: { path: 'b.ts', content: 'x' } }
        ],
        timestamp: 1000
      },
      {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'read',
        content: 'file contents',
        timestamp: 1001
      },
      {
        role: 'toolResult',
        toolCallId: 'tc2',
        toolName: 'write',
        content: 'ok',
        timestamp: 1002
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done!' }],
        timestamp: 1003
      }
    ]

    const turns = parseTurns(messages)
    const assistantTurn = turns.find((t) => t.role === 'assistant' && t.content === 'Done!')
    expect(assistantTurn).toBeDefined()

    // The work items from the mid-turn messages should have TWO separate thinking entries
    const thinkingItems = assistantTurn!.workItems.filter((w) => w.type === 'thinking')
    expect(thinkingItems).toHaveLength(2)
    expect(thinkingItems[0].output).toBe('First thought')
    expect(thinkingItems[1].output).toBe('Second thought')
  })

  it('should not concatenate text blocks into a single thinking entry', () => {
    const messages = [
      { role: 'user', content: 'do stuff' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Analysis A' },
          { type: 'toolCall', id: 'tc1', name: 'exec', arguments: { command: 'ls' } },
          { type: 'text', text: 'Analysis B' },
          { type: 'toolCall', id: 'tc2', name: 'exec', arguments: { command: 'pwd' } }
        ],
        timestamp: 100
      },
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'exec', content: 'out1', timestamp: 101 },
      { role: 'toolResult', toolCallId: 'tc2', toolName: 'exec', content: 'out2', timestamp: 102 },
      { role: 'assistant', content: 'Final answer', timestamp: 103 }
    ]

    const turns = parseTurns(messages)
    const finalTurn = turns.find((t) => t.role === 'assistant' && t.content === 'Final answer')
    expect(finalTurn).toBeDefined()

    // Should NOT have "Analysis A\nAnalysis B" as a single thinking entry
    const thinkingItems = finalTurn!.workItems.filter((w) => w.type === 'thinking')
    expect(thinkingItems.some((t) => (t.output || '').includes('Analysis A\nAnalysis B'))).toBe(false)
    expect(thinkingItems).toHaveLength(2)
  })

  it('should strip thinking tags from text blocks without eating content between them', () => {
    const messages = [
      { role: 'user', content: 'test' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '<think>internal</think> visible thought' },
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }
        ],
        timestamp: 100
      },
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', content: 'data', timestamp: 101 },
      { role: 'assistant', content: 'result', timestamp: 102 }
    ]

    const turns = parseTurns(messages)
    const finalTurn = turns.find((t) => t.role === 'assistant' && t.content === 'result')
    const thinkingItems = finalTurn!.workItems.filter((w) => w.type === 'thinking')
    expect(thinkingItems).toHaveLength(1)
    expect(thinkingItems[0].output).toBe('visible thought')
  })

  it('should handle assistant messages with only tool calls (no text)', () => {
    const messages = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'exec', arguments: { command: 'ls' } }],
        timestamp: 100
      },
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'exec', content: 'files', timestamp: 101 },
      { role: 'assistant', content: 'done', timestamp: 102 }
    ]

    const turns = parseTurns(messages)
    const finalTurn = turns.find((t) => t.role === 'assistant' && t.content === 'done')
    const thinkingItems = finalTurn!.workItems.filter((w) => w.type === 'thinking')
    expect(thinkingItems).toHaveLength(0)
  })
})

describe('parseTurns — user message dedup', () => {
  it('should collapse consecutive identical user messages', () => {
    const messages = [
      { role: 'user', content: 'hello', timestamp: 1000 },
      { role: 'user', content: 'hello', timestamp: 1001 }
    ]
    const turns = parseTurns(messages)
    const userTurns = turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].content).toBe('hello')
  })

  it('should collapse identical user messages separated by a system turn within the dedup window', () => {
    const messages = [
      { role: 'user', content: 'hello', timestamp: 1000 },
      { role: 'system', content: 'some system event' },
      { role: 'user', content: 'hello', timestamp: 5000 }
    ]
    const turns = parseTurns(messages)
    const userTurns = turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(1)
  })

  it('should keep identical user messages outside the dedup window', () => {
    const messages = [
      { role: 'user', content: 'hello', timestamp: 1000 },
      { role: 'user', content: 'hello', timestamp: 20000 }
    ]
    const turns = parseTurns(messages)
    const userTurns = turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(2)
  })

  it('should keep different user messages within the dedup window', () => {
    const messages = [
      { role: 'user', content: 'hello', timestamp: 1000 },
      { role: 'user', content: 'world', timestamp: 2000 }
    ]
    const turns = parseTurns(messages)
    const userTurns = turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(2)
  })

  it('should collapse three identical user messages within the window', () => {
    const messages = [
      { role: 'user', content: 'test', timestamp: 1000 },
      { role: 'user', content: 'test', timestamp: 2000 },
      { role: 'user', content: 'test', timestamp: 3000 }
    ]
    const turns = parseTurns(messages)
    const userTurns = turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(1)
  })
})

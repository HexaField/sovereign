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

describe('parseTurns — subagent completion events', () => {
  it('should preserve task completion events as system turns', () => {
    const messages = [
      { role: 'user', content: 'do something', timestamp: 1000 },
      {
        role: 'assistant',
        content: 'Working on it',
        timestamp: 1001
      },
      {
        role: 'user',
        content:
          'OpenClaw runtime context (internal): [Internal task completion event]\ntask: investigate-bug\nstatus: completed',
        timestamp: 2000
      }
    ]
    const turns = parseTurns(messages)
    const systemTurns = turns.filter((t) => t.role === 'system')
    expect(systemTurns.length).toBeGreaterThanOrEqual(1)
    const completion = systemTurns.find((t) => /task completion event/i.test(t.content))
    expect(completion).toBeDefined()
    expect(completion!.content).toContain('task:')
  })

  it('should preserve subagent result messages as system turns', () => {
    const messages = [
      {
        role: 'user',
        content:
          '[System Message] [sessionId: agent:main:subagent:abc123] subagent task "fix-bug" completed successfully',
        timestamp: 3000
      }
    ]
    const turns = parseTurns(messages)
    const systemTurns = turns.filter((t) => t.role === 'system')
    expect(systemTurns.length).toBeGreaterThanOrEqual(1)
    const result = systemTurns.find((t) => /subagent task.*completed/i.test(t.content))
    expect(result).toBeDefined()
    expect(result!.content).toContain('fix-bug')
  })

  it('should not filter out task completion events in the final filter pass', () => {
    const messages = [
      {
        role: 'user',
        content:
          'OpenClaw runtime context (internal): [Internal task completion event]\ntask: deploy-fix\nstatus: completed',
        timestamp: 5000
      },
      {
        role: 'assistant',
        content: 'Acknowledged the result.',
        timestamp: 5001
      }
    ]
    const turns = parseTurns(messages)
    // Ensure the task completion system turn survived filtering
    const completionTurns = turns.filter((t) => t.role === 'system' && /task completion event/i.test(t.content))
    expect(completionTurns).toHaveLength(1)
  })
})

describe('parseTurns — wrapped internal completion events', () => {
  it('should parse wrapped internal completion events as system turns', () => {
    const messages = [
      {
        role: 'user',
        content:
          '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal): [Internal task completion event]\ntask: investigate-bug\nstatus: completed\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
        timestamp: 4000
      }
    ]
    const turns = parseTurns(messages)
    const systemTurns = turns.filter((t) => t.role === 'system')
    expect(systemTurns).toHaveLength(1)
    const completion = systemTurns[0]
    expect(completion.content).toContain('task completion event')
    expect(completion.content).toContain('task:')
    // Wrapper markers must not appear in parsed content
    expect(completion.content).not.toContain('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')
    expect(completion.content).not.toContain('<<<END_OPENCLAW_INTERNAL_CONTEXT>>>')
  })

  it('should not produce a user turn from a wrapped completion event', () => {
    const messages = [
      {
        role: 'user',
        content:
          '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal): [Internal task completion event]\ntask: deploy-fix\nstatus: completed\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
        timestamp: 6000
      }
    ]
    const turns = parseTurns(messages)
    const userTurns = turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(0)
  })

  it('should extract a real user message after a wrapped completion event', () => {
    const messages = [
      {
        role: 'user',
        content:
          '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal): [Internal task completion event]\ntask: scan\nstatus: completed\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nSender (untrusted metadata): ```json\n{"name":"alice"}\n```\nPlease review the results',
        timestamp: 7000
      }
    ]
    const turns = parseTurns(messages)
    const userTurns = turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].content).toContain('review the results')
  })
})

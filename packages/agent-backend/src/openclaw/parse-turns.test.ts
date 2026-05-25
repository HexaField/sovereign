import { describe, it, expect } from 'vitest'
import { parseTurns } from './parse-turns.js'

describe('parseTurns — assistant round coalescing', () => {
  it('joins interleaved text + tool_call blocks into ONE assistant turn whose content is the joined narration', () => {
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
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', content: 'file contents', timestamp: 1001 },
      { role: 'toolResult', toolCallId: 'tc2', toolName: 'write', content: 'ok', timestamp: 1002 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done!' }],
        timestamp: 1003
      }
    ]

    const turns = parseTurns(messages)
    const assistantTurns = turns.filter((t) => t.role === 'assistant')
    // One round = one assistant turn (was previously split into multiple).
    expect(assistantTurns).toHaveLength(1)
    const assistantTurn = assistantTurns[0]
    expect(assistantTurn.content).toBe('First thought\n\nSecond thought\n\nDone!')
    const toolCalls = assistantTurn.workItems.filter((w) => w.type === 'tool_call')
    const toolResults = assistantTurn.workItems.filter((w) => w.type === 'tool_result')
    expect(toolCalls).toHaveLength(2)
    expect(toolResults).toHaveLength(2)
  })

  it('text blocks become bubble content, NOT thinking work items', () => {
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
    const finalTurn = turns.find((t) => t.role === 'assistant')!
    expect(finalTurn.content).toBe('Analysis A\n\nAnalysis B\n\nFinal answer')
    // Only structured {type: 'thinking'} blocks become thinking work items.
    expect(finalTurn.workItems.filter((w) => w.type === 'thinking')).toHaveLength(0)
  })

  it('strips inline <thinking> tags from text blocks without eating surrounding content', () => {
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
    const finalTurn = turns.find((t) => t.role === 'assistant')!
    expect(finalTurn.content).toBe('visible thought\n\nresult')
  })

  it('handles assistant messages with only tool calls (no text)', () => {
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
    const finalTurn = turns.find((t) => t.role === 'assistant' && t.content === 'done')!
    expect(finalTurn.workItems.filter((w) => w.type === 'thinking')).toHaveLength(0)
    expect(finalTurn.workItems.filter((w) => w.type === 'tool_call')).toHaveLength(1)
  })

  it('preserves structured thinking blocks as thinking work items', () => {
    const messages = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning step' },
          { type: 'toolCall', id: 'tc1', name: 'exec', arguments: {} }
        ],
        timestamp: 100
      },
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'exec', content: 'out', timestamp: 101 },
      { role: 'assistant', content: 'final', timestamp: 102 }
    ]
    const turns = parseTurns(messages)
    const t = turns.find((x) => x.role === 'assistant')!
    expect(t.content).toBe('final')
    const thinking = t.workItems.filter((w) => w.type === 'thinking')
    expect(thinking).toHaveLength(1)
    expect(thinking[0].output).toBe('reasoning step')
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

describe('parseTurns — claude-cli compaction rehydration', () => {
  function rehydrationMessage(historyBody: string, nextBody: string): string {
    return `Continue this conversation using the OpenClaw transcript below as prior session history.\nTreat it as authoritative context for this fresh CLI session.\n\n<conversation_history>\n${historyBody}\n</conversation_history>\n\n<next_user_message>\n${nextBody}\n</next_user_message>`
  }

  const HISTORY_BODY = [
    'Compaction summary: ## Decisions',
    'No prior history.',
    '',
    '## Recent turns preserved verbatim',
    '- User: did some thing',
    '- Assistant: did some other thing',
    '',
    'Assistant: ⚙️ Compacted (17 before) • Context 49k/1.0m (5%)'
  ].join('\n')

  it('splits the rehydration message into a compaction system turn + a user turn', () => {
    const messages = [
      {
        role: 'user',
        content: rehydrationMessage(HISTORY_BODY, '[Sun 2026-05-24 12:41 GMT+10] Hello, this is a test message'),
        timestamp: 1000
      }
    ]
    const turns = parseTurns(messages)
    const systemTurn = turns.find((t) => t.role === 'system')
    const userTurn = turns.find((t) => t.role === 'user')

    expect(systemTurn).toBeDefined()
    // System turn starts with the compaction chip line so client `isCompactionMessage` detection still fires.
    expect(systemTurn!.content.startsWith('⚙️ Compacted (17 before) • Context 49k/1.0m (5%)')).toBe(true)
    // …and includes the summary body for the collapsible disclosure.
    expect(systemTurn!.content).toContain('## Recent turns preserved verbatim')
    expect(systemTurn!.content).toContain('did some thing')
    // The marker line is NOT duplicated inside the summary body.
    const summaryBody = systemTurn!.content.split('\n\n').slice(1).join('\n\n')
    expect(summaryBody).not.toMatch(/Assistant:\s*⚙️\s*Compacted/)

    expect(userTurn).toBeDefined()
    // Leading timestamp is stripped — user sees the real message body.
    expect(userTurn!.content).toBe('Hello, this is a test message')
  })

  it('emits a chip-only system turn when the history body has no summary content', () => {
    const messages = [
      {
        role: 'user',
        content: rehydrationMessage(
          'Assistant: ⚙️ Compacted (3 before) • Context 12k/1.0m (1%)',
          '[Sun 2026-05-24 12:41 GMT+10] hi'
        ),
        timestamp: 1000
      }
    ]
    const turns = parseTurns(messages)
    const systemTurn = turns.find((t) => t.role === 'system')
    expect(systemTurn).toBeDefined()
    expect(systemTurn!.content).toBe('⚙️ Compacted (3 before) • Context 12k/1.0m (1%)')

    const userTurn = turns.find((t) => t.role === 'user')
    expect(userTurn!.content).toBe('hi')
  })

  it('does not regress Sender (untrusted metadata) — system part is still dropped', () => {
    const messages = [
      {
        role: 'user',
        content:
          'Sender (untrusted metadata): ```json\n{"name":"alice"}\n```\n[Mon 2026-04-13 14:08 GMT+10] real message body',
        timestamp: 1000
      }
    ]
    const turns = parseTurns(messages)
    // Sender envelope has no system content to preserve — only the user turn appears.
    expect(turns.filter((t) => t.role === 'system')).toHaveLength(0)
    const userTurns = turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0].content).toContain('real message body')
  })

  it('does not match a regular user message that just happens to mention conversation_history', () => {
    const messages = [
      {
        role: 'user',
        content: 'Can you summarise the <conversation_history> tag handling for me?',
        timestamp: 1000
      }
    ]
    const turns = parseTurns(messages)
    expect(turns).toHaveLength(1)
    expect(turns[0].role).toBe('user')
    expect(turns[0].content).toContain('summarise')
  })
})

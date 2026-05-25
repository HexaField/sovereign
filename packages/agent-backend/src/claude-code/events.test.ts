import { describe, it, expect } from 'vitest'
import { createBackendEmitter } from '@sovereign/primitives'
import { dispatchSdkMessage, handleAssistantMessage, handleResult, handleSdkUserMessage } from './events.js'
import type { ClaudeSessionState } from './types.js'

function makeState(): ClaudeSessionState {
  return {
    sessionKey: 'agent:main:thread:t1',
    backendSessionId: 'sess-1',
    cwd: '/tmp',
    model: 'opus',
    agentStatus: 'idle',
    liveSubagents: new Set(),
    streamLastLength: 0,
    thinkingAccum: '',
    textAccum: []
  }
}

describe('claude-code/events', () => {
  it('streams assistant text deltas relative to last length', () => {
    const emitter = createBackendEmitter('claude-code')
    const stream: string[] = []
    const status: string[] = []
    emitter.on('chat.stream', (d) => stream.push(d.text))
    emitter.on('chat.status', (d) => status.push(d.status))
    const state = makeState()

    handleAssistantMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      state,
      emitter
    )
    handleAssistantMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello, world' }] } },
      state,
      emitter
    )

    expect(stream).toEqual(['Hello', ', world'])
    expect(status[0]).toBe('working')
  })

  it('emits tool_call work items from tool_use blocks', () => {
    const emitter = createBackendEmitter('claude-code')
    const work: any[] = []
    emitter.on('chat.work', (d) => work.push(d.work))

    handleAssistantMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Calling…' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/a' } }
          ]
        }
      },
      makeState(),
      emitter
    )

    const toolCall = work.find((w) => w.type === 'tool_call')
    expect(toolCall).toBeDefined()
    expect(toolCall.name).toBe('Read')
    expect(toolCall.toolCallId).toBe('t1')
    expect(JSON.parse(toolCall.input)).toEqual({ path: '/a' })
  })

  it('surfaces tool_result blocks from user-role SDK messages', () => {
    const emitter = createBackendEmitter('claude-code')
    const work: any[] = []
    emitter.on('chat.work', (d) => work.push(d.work))

    handleSdkUserMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }]
        }
      },
      makeState(),
      emitter
    )

    expect(work.find((w) => w.type === 'tool_result')).toEqual(
      expect.objectContaining({ toolCallId: 't1', output: 'file contents' })
    )
  })

  it('emits chat.turn + chat.status idle on result', () => {
    const emitter = createBackendEmitter('claude-code')
    const turns: any[] = []
    const status: string[] = []
    emitter.on('chat.turn', (d) => turns.push(d.turn))
    emitter.on('chat.status', (d) => status.push(d.status))

    const state = makeState()
    state.agentStatus = 'working'
    handleResult(
      {
        type: 'result',
        subtype: 'success',
        result: 'final answer',
        usage: { input_tokens: 10, output_tokens: 3 }
      },
      state,
      emitter
    )

    expect(turns[0].role).toBe('assistant')
    expect(turns[0].content).toBe('final answer')
    expect(status).toEqual(['idle'])
    expect(state.lastUsage?.inputTokens).toBe(10)
    expect(state.lastUsage?.outputTokens).toBe(3)
  })

  it('dispatches by message type', () => {
    const emitter = createBackendEmitter('claude-code')
    const events: string[] = []
    emitter.on('chat.stream', () => events.push('stream'))
    emitter.on('chat.turn', () => events.push('turn'))
    emitter.on('chat.compacting', (d) => events.push(`compact:${d.active}`))

    dispatchSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      makeState(),
      emitter
    )
    dispatchSdkMessage(
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } },
      makeState(),
      emitter
    )
    dispatchSdkMessage({ type: 'result', subtype: 'success', result: 'ok' }, makeState(), emitter)

    expect(events).toContain('stream')
    expect(events).toContain('compact:true')
    expect(events).toContain('compact:false')
    expect(events).toContain('turn')
  })
})

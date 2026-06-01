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
  it('emits each assistant text fragment as a self-contained delta', () => {
    // Sovereign runs the SDK with `includePartialMessages: false`
    // (claude-code.ts startSessionLoop). Under that mode each
    // SDKAssistantMessage carries its OWN complete text — never a
    // cumulative running buffer. Two distinct messages with different
    // texts therefore produce two distinct fragments joined by `\n\n`
    // on the wire so the live streaming view matches the final
    // chat.turn content (which is also joined from textAccum). The
    // previous behaviour (delta = text.slice(streamLastLength)) was
    // matching a cumulative-partials shape the SDK never delivers in
    // this configuration, and corrupted the stream on multi-message
    // rounds where text lengths weren't monotonically growing.
    const emitter = createBackendEmitter('claude-code')
    const stream: string[] = []
    const status: string[] = []
    emitter.on('chat.stream', (d) => stream.push(d.text))
    emitter.on('chat.status', (d) => status.push(d.status))
    const state = makeState()

    handleAssistantMessage(
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Hello' }] } },
      state,
      emitter
    )
    handleAssistantMessage(
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Hello, world' }] }
      },
      state,
      emitter
    )

    expect(stream).toEqual(['Hello', '\n\nHello, world'])
    expect(stream.join('')).toBe(state.textAccum.join('\n\n'))
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

  // ── Bug 1: subagent leak via parent_tool_use_id ───────────────────────
  // Per @anthropic-ai/claude-agent-sdk: every SDKAssistantMessage and
  // SDKUserMessage emitted from a subagent carries `parent_tool_use_id`
  // set to the spawning tool's id. Default SDK behaviour
  // (forwardSubagentText:false) still propagates subagent tool_use and
  // tool_result blocks through the parent stream; with forwardSubagentText:true
  // text and thinking propagate too. None of these belong on the parent's
  // session events — the parent UI must not show the subagent's work mixed
  // into its own work list, nor its narration mixed into its own message.
  describe('Bug 1 — subagent events MUST NOT leak onto the parent', () => {
    it('drops subagent assistant tool_use blocks (default heartbeat mode)', () => {
      const emitter = createBackendEmitter('claude-code')
      const events: Array<{ kind: string; payload: any }> = []
      emitter.on('chat.stream', (d) => events.push({ kind: 'stream', payload: d }))
      emitter.on('chat.work', (d) => events.push({ kind: 'work', payload: d }))
      emitter.on('chat.turn', (d) => events.push({ kind: 'turn', payload: d }))
      emitter.on('chat.status', (d) => events.push({ kind: 'status', payload: d }))

      const state = makeState()
      // Subagent-originated assistant message: SDK emits with parent_tool_use_id.
      dispatchSdkMessage(
        {
          type: 'assistant',
          parent_tool_use_id: 'toolu_parent_spawn_xyz',
          subagent_type: 'general-purpose',
          message: {
            content: [{ type: 'tool_use', id: 'toolu_child_read_1', name: 'Read', input: { path: '/a' } }]
          }
        },
        state,
        emitter
      )

      // No events should be emitted onto the parent's session bus.
      expect(events).toEqual([])
      // And the parent's session state must not have been touched.
      expect(state.streamLastLength).toBe(0)
      expect(state.textAccum).toEqual([])
      expect(state.thinkingAccum).toBe('')
    })

    it('drops subagent assistant text+thinking (forwardSubagentText mode)', () => {
      const emitter = createBackendEmitter('claude-code')
      const events: any[] = []
      emitter.on('chat.stream', (d) => events.push({ kind: 'stream', ...d }))
      emitter.on('chat.work', (d) => events.push({ kind: 'work', ...d }))

      const state = makeState()
      dispatchSdkMessage(
        {
          type: 'assistant',
          parent_tool_use_id: 'toolu_parent_spawn_xyz',
          subagent_type: 'general-purpose',
          message: {
            content: [
              { type: 'thinking', thinking: 'subagent thinking that must not show on parent' },
              { type: 'text', text: 'subagent narration that must not show on parent' }
            ]
          }
        },
        state,
        emitter
      )

      expect(events).toEqual([])
      expect(state.textAccum).toEqual([])
    })

    it('drops subagent tool_result blocks (user-role with parent_tool_use_id)', () => {
      const emitter = createBackendEmitter('claude-code')
      const work: any[] = []
      emitter.on('chat.work', (d) => work.push(d.work))

      dispatchSdkMessage(
        {
          type: 'user',
          parent_tool_use_id: 'toolu_parent_spawn_xyz',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_child_read_1', content: 'leaked file contents' }]
          }
        },
        makeState(),
        emitter
      )

      expect(work).toEqual([])
    })

    it('still routes the parent (parent_tool_use_id === null)', () => {
      // Sanity check: this is the SAME shape the SDK uses for the parent's
      // own assistant message — parent_tool_use_id is explicitly null on
      // the main thread. We MUST keep dispatching these.
      const emitter = createBackendEmitter('claude-code')
      const stream: string[] = []
      emitter.on('chat.stream', (d) => stream.push(d.text))

      dispatchSdkMessage(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: 'parent says hi' }] }
        },
        makeState(),
        emitter
      )

      expect(stream).toEqual(['parent says hi'])
    })
  })

  // ── Bug 2: thinking content leaking into final agent message via
  // streamLastLength bookkeeping that wasn't reset between messages ────
  // With includePartialMessages:false (Sovereign's setting), each
  // SDKAssistantMessage carries a complete, self-contained text — not a
  // cumulative running buffer. The original code tracks streamLastLength
  // across messages within a round, which produces (a) wrong-tail deltas
  // when a later text is longer than an earlier one and (b) missed
  // emissions when a later text is shorter. Either way, the live
  // streamingText diverges from the final chat.turn content (which is
  // joined from textAccum), giving the impression that thinking-like
  // narration is being absorbed silently into the final agent bubble.
  describe('Bug 2 — multi-message rounds produce coherent stream deltas', () => {
    it('emits each text fragment as a clean delta (text → tool → text)', () => {
      // This mirrors the actual SDK pattern observed in real Claude Code
      // JSONL: each assistant message carries exactly ONE content-block
      // type (text-only, thinking-only, or tool_use-only). The order
      // within a round is typically:
      //   1) thinking-only message
      //   2) text-only message ("Let me check that.")
      //   3) tool_use-only message (Read tool)
      //   4) user-role tool_result
      //   5) text-only message ("Here is the answer.")
      //   6) result message
      const emitter = createBackendEmitter('claude-code')
      const stream: string[] = []
      const work: any[] = []
      const turns: any[] = []
      emitter.on('chat.stream', (d) => stream.push(d.text))
      emitter.on('chat.work', (d) => work.push(d.work))
      emitter.on('chat.turn', (d) => turns.push(d.turn))

      const state = makeState()
      state.agentStatus = 'working'

      // 1) thinking-only
      handleAssistantMessage(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'thinking', thinking: 'pondering the request' }] }
        },
        state,
        emitter
      )
      // 2) text-only "Let me check that."
      handleAssistantMessage(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: 'Let me check that.' }] }
        },
        state,
        emitter
      )
      // 3) tool_use-only
      handleAssistantMessage(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/a' } }] }
        },
        state,
        emitter
      )
      // 4) tool_result
      handleSdkUserMessage(
        {
          type: 'user',
          parent_tool_use_id: null,
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'the answer is 42' }] }
        },
        state,
        emitter
      )
      // 5) text-only "Here is the answer."
      handleAssistantMessage(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: 'Here is the answer.' }] }
        },
        state,
        emitter
      )
      // 6) result
      handleResult(
        {
          type: 'result',
          subtype: 'success',
          result: 'Here is the answer.',
          usage: { input_tokens: 10, output_tokens: 5 }
        },
        state,
        emitter
      )

      // What the user sees streamed, when concatenated, MUST equal what
      // the final chat.turn renders. Anything else means the streaming
      // view is silently dropping or corrupting fragments that DO appear
      // in the final agent bubble (the "thinking-coalesces-into-message"
      // symptom).
      const streamConcatenated = stream.join('')
      const finalContent = turns[turns.length - 1]?.content ?? ''
      expect(finalContent).toBe('Let me check that.\n\nHere is the answer.')
      expect(streamConcatenated).toBe(finalContent)

      // And no partial-tail garbage like "swer" (text.slice past
      // streamLastLength) should leak into the stream.
      for (const piece of stream) {
        expect(piece.startsWith('swer')).toBe(false)
        // Each emitted piece is either pure text or a \n\n-prefixed
        // continuation — never a substring of a fragment.
        const cleaned = piece.replace(/^\n\n/, '')
        expect(['Let me check that.', 'Here is the answer.']).toContain(cleaned)
      }
    })

    it('does not re-emit duplicate text fragments', () => {
      // Resume/reconnect paths can redeliver the same assistant message.
      // We must not emit the same fragment twice (would appear as duplicated
      // text in the streaming view and the final bubble).
      const emitter = createBackendEmitter('claude-code')
      const stream: string[] = []
      emitter.on('chat.stream', (d) => stream.push(d.text))

      const state = makeState()
      const msg = {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Hello world' }] }
      }
      handleAssistantMessage(msg, state, emitter)
      handleAssistantMessage(msg, state, emitter)

      expect(stream).toEqual(['Hello world'])
      expect(state.textAccum).toEqual(['Hello world'])
    })

    it('thinking blocks NEVER land in textAccum or final content', () => {
      // Direct guard against thinking text leaking into the assistant
      // message bubble. Even if the SDK emits thinking and text in the
      // SAME assistant message, the thinking block must end up only on
      // chat.work (the collapsible tool list) — never in chat.stream or
      // chat.turn.content.
      const emitter = createBackendEmitter('claude-code')
      const stream: string[] = []
      const work: any[] = []
      const turns: any[] = []
      emitter.on('chat.stream', (d) => stream.push(d.text))
      emitter.on('chat.work', (d) => work.push(d.work))
      emitter.on('chat.turn', (d) => turns.push(d.turn))

      const state = makeState()
      handleAssistantMessage(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              { type: 'thinking', thinking: 'INTERNAL REASONING — must stay private to work list' },
              { type: 'text', text: 'Public answer.' }
            ]
          }
        },
        state,
        emitter
      )
      handleResult({ type: 'result', subtype: 'success', result: 'Public answer.', usage: {} }, state, emitter)

      // Stream: only the user-visible text, no thinking.
      expect(stream.join('')).toBe('Public answer.')
      // Final content: only the user-visible text.
      expect(turns[0].content).toBe('Public answer.')
      // Thinking is surfaced as a chat.work item only.
      const thinkingItems = work.filter((w) => w.type === 'thinking')
      expect(thinkingItems.length).toBeGreaterThan(0)
      expect(thinkingItems.some((w) => /INTERNAL REASONING/.test(w.output ?? ''))).toBe(true)
    })
  })
})

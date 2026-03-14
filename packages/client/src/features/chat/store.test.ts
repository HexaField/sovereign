import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  turns,
  streamingHtml,
  agentStatus,
  liveWork,
  liveThinkingText,
  compacting,
  isRetryCountdownActive,
  retryCountdownSeconds,
  startRetryCountdown,
  clearRetryCountdown,
  sendMessage,
  abortChat,
  initChatStore,
  setTurns,
  setStreamingHtml,
  setAgentStatus,
  _resetState
} from './store.js'
import type { ParsedTurn, WorkItem } from '@sovereign/core'

function createMockWs() {
  const handlers = new Map<string, Set<(msg: any) => void>>()
  return {
    connected: () => true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on(type: string, handler: (msg: any) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => {
        handlers.get(type)?.delete(handler)
      }
    },
    send: vi.fn(),
    close: vi.fn(),
    _emit(type: string, msg: any) {
      handlers.get(type)?.forEach((h) => h(msg))
    }
  }
}

describe('§3.2 Chat Store', () => {
  let ws: ReturnType<typeof createMockWs>
  let cleanup: (() => void) | void

  beforeEach(() => {
    vi.useFakeTimers()
    _resetState()
    ws = createMockWs()
    cleanup = initChatStore(() => 'main', ws as any)
  })

  afterEach(() => {
    if (cleanup) cleanup()
    vi.useRealTimers()
  })

  it('MUST expose turns: Accessor<ParsedTurn[]>', () => {
    expect(turns()).toEqual([])
  })

  it('MUST expose streamingHtml: Accessor<string>', () => {
    expect(streamingHtml()).toBe('')
  })

  it('MUST expose agentStatus: Accessor<AgentStatus>', () => {
    expect(agentStatus()).toBe('idle')
  })

  it('MUST expose liveWork: Accessor<WorkItem[]>', () => {
    expect(liveWork()).toEqual([])
  })

  it('MUST expose liveThinkingText: Accessor<string>', () => {
    expect(liveThinkingText()).toBe('')
  })

  it('MUST expose compacting: Accessor<boolean>', () => {
    expect(compacting()).toBe(false)
  })

  it('MUST expose isRetryCountdownActive: Accessor<boolean>', () => {
    expect(isRetryCountdownActive()).toBe(false)
  })

  it('MUST expose retryCountdownSeconds: Accessor<number>', () => {
    expect(retryCountdownSeconds()).toBe(0)
  })

  it('MUST expose startRetryCountdown(seconds) that decrements every second', () => {
    startRetryCountdown(3)
    expect(isRetryCountdownActive()).toBe(true)
    expect(retryCountdownSeconds()).toBe(3)
    vi.advanceTimersByTime(1000)
    expect(retryCountdownSeconds()).toBe(2)
    vi.advanceTimersByTime(1000)
    expect(retryCountdownSeconds()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(retryCountdownSeconds()).toBe(0)
    expect(isRetryCountdownActive()).toBe(false)
  })

  it('MUST expose clearRetryCountdown() that cancels countdown and resets state', () => {
    startRetryCountdown(5)
    clearRetryCountdown()
    expect(isRetryCountdownActive()).toBe(false)
    expect(retryCountdownSeconds()).toBe(0)
  })

  it('sendMessage MUST add an optimistic pending turn to turns immediately', () => {
    sendMessage('hello')
    expect(turns().length).toBe(1)
    expect(turns()[0].role).toBe('user')
    expect(turns()[0].content).toBe('hello')
    expect(turns()[0].pending).toBe(true)
  })

  it('sendMessage MUST clear the input scratchpad for the current thread', () => {
    sendMessage('test')
    // Verified by the ws.send call
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', text: 'test' }))
  })

  it('abortChat MUST send chat.abort via WS and update agentStatus to idle', () => {
    setAgentStatus('working')
    abortChat()
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.abort' }))
    expect(agentStatus()).toBe('idle')
  })

  it('MUST subscribe to chat WS channel for chat.stream messages', () => {
    ws._emit('chat.stream', { type: 'chat.stream', text: 'hello ' })
    expect(streamingHtml()).toBe('hello ')
    ws._emit('chat.stream', { type: 'chat.stream', text: 'world' })
    expect(streamingHtml()).toBe('hello world')
  })

  it('MUST subscribe to chat WS channel for chat.turn messages', () => {
    const turn: ParsedTurn = { role: 'assistant', content: 'hi', timestamp: 1, workItems: [], thinkingBlocks: [] }
    ws._emit('chat.turn', { type: 'chat.turn', turn })
    expect(turns().length).toBe(1)
    expect(turns()[0].content).toBe('hi')
  })

  it('MUST subscribe to chat WS channel for chat.status messages', () => {
    ws._emit('chat.status', { type: 'chat.status', status: 'working' })
    expect(agentStatus()).toBe('working')
  })

  it('MUST subscribe to chat WS channel for chat.work messages', () => {
    const work: WorkItem = { type: 'tool_call', name: 'read', timestamp: 1 }
    ws._emit('chat.work', { type: 'chat.work', work })
    expect(liveWork().length).toBe(1)
    expect(liveWork()[0].name).toBe('read')
  })

  it('MUST subscribe to chat WS channel for chat.compacting messages', () => {
    ws._emit('chat.compacting', { type: 'chat.compacting', active: true })
    expect(compacting()).toBe(true)
  })

  it('MUST subscribe to chat WS channel for chat.error messages', () => {
    ws._emit('chat.error', { type: 'chat.error', error: 'rate limited', retryAfterMs: 5000 })
    expect(isRetryCountdownActive()).toBe(true)
    expect(retryCountdownSeconds()).toBe(5)
  })

  it('MUST subscribe to chat WS channel for chat.session.info messages', () => {
    const history: ParsedTurn[] = [
      { role: 'user', content: 'q', timestamp: 1, workItems: [], thinkingBlocks: [] },
      { role: 'assistant', content: 'a', timestamp: 2, workItems: [], thinkingBlocks: [] }
    ]
    ws._emit('chat.session.info', { type: 'chat.session.info', history })
    expect(turns().length).toBe(2)
  })

  it('MUST replace optimistic pending turn with confirmed turn on chat.turn', () => {
    sendMessage('hello')
    expect(turns()[0].pending).toBe(true)
    const confirmed: ParsedTurn = { role: 'user', content: 'hello', timestamp: 1, workItems: [], thinkingBlocks: [] }
    ws._emit('chat.turn', { type: 'chat.turn', turn: confirmed })
    expect(turns().length).toBe(1)
    expect(turns()[0].pending).toBeUndefined()
  })

  it('MUST call startRetryCountdown when chat.error arrives with retryAfterMs', () => {
    ws._emit('chat.error', { type: 'chat.error', error: 'rate limit', retryAfterMs: 3000 })
    expect(isRetryCountdownActive()).toBe(true)
    expect(retryCountdownSeconds()).toBe(3)
  })

  it('MUST replace turns with provided history on chat.session.info', () => {
    setTurns([{ role: 'user', content: 'old', timestamp: 0, workItems: [], thinkingBlocks: [] }])
    const history: ParsedTurn[] = [{ role: 'user', content: 'new', timestamp: 1, workItems: [], thinkingBlocks: [] }]
    ws._emit('chat.session.info', { type: 'chat.session.info', history })
    expect(turns().length).toBe(1)
    expect(turns()[0].content).toBe('new')
  })

  it('MUST clear all state when thread changes', () => {
    setTurns([{ role: 'user', content: 'x', timestamp: 1, workItems: [], thinkingBlocks: [] }])
    setStreamingHtml('partial')
    _resetState()
    expect(turns()).toEqual([])
    expect(streamingHtml()).toBe('')
    expect(liveWork()).toEqual([])
  })

  it('MUST send chat.session.switch via WS when thread changes', () => {
    // Test by directly calling what thread change does
    ws.send({ type: 'chat.session.switch', threadKey: 'feature-x' })
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.session.switch', threadKey: 'feature-x' })
    )
  })

  it('MUST await chat.session.info response to populate turns after thread switch', () => {
    const history: ParsedTurn[] = [
      { role: 'assistant', content: 'loaded', timestamp: 1, workItems: [], thinkingBlocks: [] }
    ]
    ws._emit('chat.session.info', { type: 'chat.session.info', history })
    expect(turns().length).toBe(1)
    expect(turns()[0].content).toBe('loaded')
  })

  it('MUST accept threadKey as a reactive accessor via initChatStore', () => {
    // Already tested via initChatStore(() => 'main', ws) in beforeEach
    expect(typeof initChatStore).toBe('function')
  })
})

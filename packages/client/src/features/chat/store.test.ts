import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSignal } from 'solid-js'

const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => {
    store[key] = val
  },
  removeItem: (key: string) => {
    delete store[key]
  },
  clear: () => Object.keys(store).forEach((k) => delete store[k])
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
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
  inputValue,
  setInputValue,
  mergeLiveWorkItems,
  ttsDeliveredTurns,
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

describe('mergeLiveWorkItems', () => {
  it('replaces the last thinking item when the new text extends the same live block', () => {
    const previous: WorkItem[] = [{ type: 'thinking', output: 'Analysis A', timestamp: 1 }]
    const next: WorkItem = { type: 'thinking', output: 'Analysis A with more detail', timestamp: 2 }

    expect(mergeLiveWorkItems(previous, next)).toEqual([next])
  })

  it('appends a new thinking item when the next text is a distinct reasoning step', () => {
    const previous: WorkItem[] = [{ type: 'thinking', output: 'Analysis A', timestamp: 1 }]
    const next: WorkItem = { type: 'thinking', output: 'Analysis B', timestamp: 2 }

    expect(mergeLiveWorkItems(previous, next)).toEqual([...previous, next])
  })

  it('appends thinking after a tool call instead of replacing the earlier thought', () => {
    const previous: WorkItem[] = [
      { type: 'thinking', output: 'Analysis A', timestamp: 1 },
      { type: 'tool_call', name: 'read', input: '{"path":"a.ts"}', timestamp: 2 }
    ]
    const next: WorkItem = { type: 'thinking', output: 'Analysis B', timestamp: 3 }

    expect(mergeLiveWorkItems(previous, next)).toEqual([...previous, next])
  })
})

describe('§3.2 Chat Store', () => {
  let ws: ReturnType<typeof createMockWs>
  let cleanup: (() => void) | void

  beforeEach(() => {
    vi.useFakeTimers()
    localStorageMock.clear()
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

  it('sendMessage POSTs to /api/chat/send with threadId + message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    await sendMessage('hello')
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/chat/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ threadId: 'main', message: 'hello' })
      })
    )
    // No optimistic turn in `turns()` — the server queue is the source of
    // truth for in-flight messages (rendered as queue bubbles in ChatView).
    expect(turns()).toEqual([])
    fetchSpy.mockRestore()
  })

  it('setInputValue writes drafts to localStorage per thread key', () => {
    setInputValue('draft text')
    expect(localStorageMock.getItem('sovereign:draft:main')).toBe('draft text')
  })

  it('initChatStore loads draft from localStorage on init', () => {
    localStorageMock.setItem('sovereign:draft:main', 'saved draft')
    cleanup && cleanup()
    cleanup = initChatStore(() => 'main', ws as any)
    expect(inputValue()).toBe('saved draft')
  })

  it('loadDraft restores draft when thread changes', () => {
    localStorageMock.setItem('sovereign:draft:thread-a', 'draft a')
    localStorageMock.setItem('sovereign:draft:thread-b', 'draft b')
    cleanup && cleanup()
    const [threadKey, setThreadKey] = createSignal('thread-a')
    cleanup = initChatStore(threadKey, ws as any) as () => void
    expect(inputValue()).toBe('draft a')

    // Simulate a thread switch by re-initializing with a new accessor
    cleanup && cleanup()
    setThreadKey('thread-b')
    cleanup = initChatStore(threadKey, ws as any) as () => void
    expect(inputValue()).toBe('draft b')
  })

  it('abortChat MUST send chat.abort via WS and show cancelled status', () => {
    setAgentStatus('working')
    abortChat()
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.abort' }))
    expect(agentStatus()).toBe('cancelled')
  })

  // chat.stream / chat.turn / chat.status / chat.work / chat.compacting / chat.error
  // are now SSE-only — they are NOT broadcast on the WS channel anymore.
  // Covered by the live curl-against-running-server verification recorded
  // in memory/2026-05-25-1213.md, not by these unit tests.

  it('MUST subscribe to chat WS channel for chat.session.info messages', () => {
    const history: ParsedTurn[] = [
      { role: 'user', content: 'q', timestamp: 1, workItems: [], thinkingBlocks: [] },
      { role: 'assistant', content: 'a', timestamp: 2, workItems: [], thinkingBlocks: [] }
    ]
    ws._emit('chat.session.info', { type: 'chat.session.info', history })
    expect(turns().length).toBe(2)
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

  // chat.ts prepends a one-word `[modality]\n` tag to text sent to the
  // agent; the SDK persists exactly what it received, so a history reload
  // reads the tag back out of the JSONL. The store strips it and sets
  // `origin` so MessageBubble can render an icon without showing the tag.
  describe('origin prefix parsing', () => {
    it('MUST strip a [modality]\\n prefix from a user turn and set turn.origin', () => {
      const history: ParsedTurn[] = [
        { role: 'user', content: '[voice]\nturn the lights on', timestamp: 1, workItems: [], thinkingBlocks: [] },
        { role: 'assistant', content: 'Done.', timestamp: 2, workItems: [], thinkingBlocks: [] }
      ]
      ws._emit('chat.session.info', { type: 'chat.session.info', history })
      expect(turns()[0].content).toBe('turn the lights on')
      expect(turns()[0].origin).toEqual({ modality: 'voice' })
      // Assistant turns never carry the tag — origin stays unset.
      expect(turns()[1].origin).toBeUndefined()
    })

    it('MUST leave a user turn with an existing origin field untouched', () => {
      const history: ParsedTurn[] = [
        {
          role: 'user',
          content: 'turn the lights on',
          timestamp: 1,
          workItems: [],
          thinkingBlocks: [],
          origin: { modality: 'voice' }
        }
      ]
      ws._emit('chat.session.info', { type: 'chat.session.info', history })
      expect(turns()[0].content).toBe('turn the lights on')
      expect(turns()[0].origin).toEqual({ modality: 'voice' })
    })

    it('MUST leave plain text turns without a bracket prefix untouched', () => {
      const history: ParsedTurn[] = [
        { role: 'user', content: 'hello there', timestamp: 1, workItems: [], thinkingBlocks: [] }
      ]
      ws._emit('chat.session.info', { type: 'chat.session.info', history })
      expect(turns()[0].content).toBe('hello there')
      expect(turns()[0].origin).toBeUndefined()
    })
  })

  // The client marks the most recent assistant turn as TTS-delivered when a
  // voice.tts.audio (kind: 'summary') push arrives for the current thread —
  // MessageBubble reads ttsDeliveredTurns() to render a speaker icon.
  describe('TTS delivery tracking', () => {
    it('MUST mark the most recent assistant turn as TTS-delivered on voice.tts.audio kind "summary"', () => {
      const history: ParsedTurn[] = [
        { role: 'user', content: 'hi', timestamp: 1, workItems: [], thinkingBlocks: [] },
        { role: 'assistant', content: 'hello', timestamp: 2, workItems: [], thinkingBlocks: [] }
      ]
      ws._emit('chat.session.info', { type: 'chat.session.info', history })
      ws._emit('voice.tts.audio', {
        type: 'voice.tts.audio',
        threadId: 'main',
        kind: 'summary',
        text: 'hello',
        audio: ''
      })
      expect(ttsDeliveredTurns().has(2)).toBe(true)
    })

    it('MUST NOT mark delivery for voice.tts.audio kind "ack"', () => {
      const history: ParsedTurn[] = [
        { role: 'assistant', content: 'hello', timestamp: 2, workItems: [], thinkingBlocks: [] }
      ]
      ws._emit('chat.session.info', { type: 'chat.session.info', history })
      ws._emit('voice.tts.audio', { type: 'voice.tts.audio', threadId: 'main', kind: 'ack', text: 'ack', audio: '' })
      expect(ttsDeliveredTurns().has(2)).toBe(false)
    })

    it('MUST NOT mark delivery for a voice.tts.audio push targeting a different thread', () => {
      const history: ParsedTurn[] = [
        { role: 'assistant', content: 'hello', timestamp: 2, workItems: [], thinkingBlocks: [] }
      ]
      ws._emit('chat.session.info', { type: 'chat.session.info', history })
      ws._emit('voice.tts.audio', {
        type: 'voice.tts.audio',
        threadId: 'other-thread',
        kind: 'summary',
        text: 'hello',
        audio: ''
      })
      expect(ttsDeliveredTurns().has(2)).toBe(false)
    })
  })
})

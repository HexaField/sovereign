import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initSummaryStore, summary, hasSummary } from './summary-store.js'

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
    onBinary: vi.fn(() => () => {}),
    send: vi.fn(),
    close: vi.fn(),
    _emit(type: string, msg: any) {
      handlers.get(type)?.forEach((h) => h(msg))
    }
  }
}

/** Flush pending microtask chains (fetch().then().then()) deterministically. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** The store detects a thread-key change via a short poll (see POLL_MS in
 *  summary-store.ts) rather than a Solid effect — real time must pass for
 *  the poll tick to fire. */
function waitForPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 260))
}

const mockFetch = vi.fn()

describe('summary-store', () => {
  let teardown: (() => void) | undefined

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: false })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    teardown?.()
    teardown = undefined
    vi.unstubAllGlobals()
  })

  /** Wires initSummaryStore against a plain mutable-closure "thread key
   *  accessor" — no Solid signal required, since the store polls the
   *  accessor rather than tracking it reactively. */
  function setup(initialThread: string, ws: ReturnType<typeof createMockWs>) {
    let currentKey = initialThread
    const threadKey = () => currentKey
    teardown = initSummaryStore(ws as any, threadKey)
    return { setThreadKey: (key: string) => (currentKey = key) }
  }

  it('subscribes to the chat WS channel on init', () => {
    const ws = createMockWs()
    setup('thread-1', ws)
    expect(ws.subscribe).toHaveBeenCalledWith(['chat'])
  })

  it('fetches the current summary for the initial thread and exposes it via hasSummary', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ threadId: 'thread-1', summary: 'Hex builds the summary bubble.' })
    })
    const ws = createMockWs()
    setup('thread-1', ws)
    await flush()

    expect(mockFetch).toHaveBeenCalledWith('/api/threads/thread-1/summary')
    expect(summary()).toBe('Hex builds the summary bubble.')
    expect(hasSummary()).toBe(true)
  })

  it('leaves hasSummary false on a 404 (no summary generated yet)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false })
    const ws = createMockWs()
    setup('thread-1', ws)
    await flush()

    expect(summary()).toBe('')
    expect(hasSummary()).toBe(false)
  })

  it('clears the stale summary and fetches the new thread after a thread change', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ threadId: 'thread-1', summary: 'First thread summary.' })
    })
    const ws = createMockWs()
    const { setThreadKey } = setup('thread-1', ws)
    await flush()
    expect(summary()).toBe('First thread summary.')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ threadId: 'thread-2', summary: 'Second thread summary.' })
    })
    setThreadKey('thread-2')
    await waitForPoll()

    expect(mockFetch).toHaveBeenLastCalledWith('/api/threads/thread-2/summary')
    expect(summary()).toBe('Second thread summary.')
  })

  it('discards a stale REST response that resolves after a further thread change', async () => {
    const ws = createMockWs()
    let resolveFirstFetch!: (v: unknown) => void
    mockFetch.mockReturnValueOnce(new Promise((resolve) => (resolveFirstFetch = resolve)))
    const { setThreadKey } = setup('thread-1', ws)

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ threadId: 'thread-2', summary: 'Second thread summary.' })
    })
    setThreadKey('thread-2')
    await waitForPoll()
    expect(summary()).toBe('Second thread summary.')

    // The thread-1 fetch resolves late — its result must not overwrite the
    // now-current thread-2 summary.
    resolveFirstFetch({ ok: true, json: async () => ({ threadId: 'thread-1', summary: 'Late thread-1 summary.' }) })
    await flush()
    expect(summary()).toBe('Second thread summary.')
  })

  it('applies a WS chat.summary update that matches the open thread', () => {
    const ws = createMockWs()
    setup('thread-1', ws)

    ws._emit('chat.summary', { type: 'chat.summary', threadId: 'thread-1', summary: 'Live update.' })
    expect(summary()).toBe('Live update.')
    expect(hasSummary()).toBe(true)
  })

  it('ignores a WS chat.summary update for a thread other than the open one', () => {
    const ws = createMockWs()
    setup('thread-1', ws)

    ws._emit('chat.summary', { type: 'chat.summary', threadId: 'thread-2', summary: 'Wrong thread.' })
    expect(summary()).toBe('')
    expect(hasSummary()).toBe(false)
  })

  it('ignores malformed WS payloads', () => {
    const ws = createMockWs()
    setup('thread-1', ws)

    ws._emit('chat.summary', { type: 'chat.summary' })
    ws._emit('chat.summary', { type: 'chat.summary', threadId: 'thread-1', summary: 42 })
    expect(summary()).toBe('')
  })

  it('resets the summary and stops applying WS updates once torn down', () => {
    const ws = createMockWs()
    setup('thread-1', ws)
    ws._emit('chat.summary', { type: 'chat.summary', threadId: 'thread-1', summary: 'Before teardown.' })
    expect(summary()).toBe('Before teardown.')

    teardown?.()
    teardown = undefined
    expect(summary()).toBe('')

    // A handler fired after teardown must not resurrect the value.
    ws._emit('chat.summary', { type: 'chat.summary', threadId: 'thread-1', summary: 'After teardown.' })
    expect(summary()).toBe('')
  })

  it('stops polling for thread changes once torn down', async () => {
    const ws = createMockWs()
    const { setThreadKey } = setup('thread-1', ws)
    await flush()
    const callsAtTeardown = mockFetch.mock.calls.length

    teardown?.()
    teardown = undefined
    setThreadKey('thread-2')
    await waitForPoll()

    expect(mockFetch.mock.calls.length).toBe(callsAtTeardown)
  })
})

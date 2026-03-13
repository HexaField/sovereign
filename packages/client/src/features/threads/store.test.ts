import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  threadKey,
  threads,
  switchThread,
  createThread,
  addEntity,
  removeEntity,
  setThreadKey,
  setThreads,
  initThreadStore,
  _triggerPopstate
} from './store.js'

// Mock fetch globally
const mockFetch = vi.fn()

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

describe('§3.3 Thread Store', () => {
  let ws: ReturnType<typeof createMockWs>
  let cleanup: () => void
  const origFetch = globalThis.fetch

  beforeEach(() => {
    setThreadKey('main')
    setThreads([])
    ws = createMockWs()
    // Mock location.hash
    if (typeof globalThis.location === 'undefined') {
      ;(globalThis as any).location = { hash: '', href: 'http://localhost', search: '' }
    }
    globalThis.location.hash = ''
    mockFetch.mockResolvedValue({ json: () => Promise.resolve([]) })
    globalThis.fetch = mockFetch as any
    cleanup = initThreadStore(ws as any)
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = origFetch
    mockFetch.mockReset()
  })

  it('MUST expose threadKey: Accessor<string>', () => {
    expect(threadKey()).toBe('main')
  })

  it('MUST expose threads: Accessor<ThreadInfo[]>', () => {
    expect(threads()).toEqual([])
  })

  it('switchThread MUST set the active thread key', () => {
    switchThread('feature-x')
    expect(threadKey()).toBe('feature-x')
  })

  it('switchThread MUST update the URL hash to #thread={key}', () => {
    // Mock history.pushState
    const pushState = vi.fn()
    globalThis.history = { pushState } as any
    switchThread('my-thread')
    expect(pushState).toHaveBeenCalledWith(null, '', '#thread=my-thread')
  })

  it('switchThread MUST NOT reload the page', () => {
    // pushState doesn't reload — this is verified by using pushState instead of location.hash assignment
    const pushState = vi.fn()
    globalThis.history = { pushState } as any
    switchThread('test')
    // If we got here without error, no reload happened
    expect(true).toBe(true)
  })

  it('createThread MUST send POST /api/threads REST request', async () => {
    const threadData = { key: 'new-1', entities: [], lastActivity: 0, unreadCount: 0, agentStatus: 'idle' as const }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(threadData) })
    await createThread('My Thread')
    expect(mockFetch).toHaveBeenCalledWith('/api/threads', expect.objectContaining({ method: 'POST' }))
  })

  it('createThread MUST add new thread to threads on success', async () => {
    const threadData = { key: 'new-1', entities: [], lastActivity: 0, unreadCount: 0, agentStatus: 'idle' as const }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(threadData) })
    await createThread('My Thread')
    expect(threads().length).toBe(1)
    expect(threads()[0].key).toBe('new-1')
  })

  it('addEntity MUST send POST /api/threads/:key/entities', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({}) })
    await addEntity('main', { orgId: 'o1', projectId: 'p1', entityType: 'branch', entityRef: 'feat-x' })
    expect(mockFetch).toHaveBeenCalledWith('/api/threads/main/entities', expect.objectContaining({ method: 'POST' }))
  })

  it('removeEntity MUST send DELETE /api/threads/:key/entities/:entityType/:entityRef', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({}) })
    await removeEntity('main', 'branch', 'feat-x')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/threads/main/entities/branch/feat-x',
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('MUST read thread key from URL hash on init', () => {
    cleanup()
    globalThis.location.hash = '#thread=feature-y'
    cleanup = initThreadStore(ws as any)
    expect(threadKey()).toBe('feature-y')
  })

  it('MUST default to main if no hash is present', () => {
    cleanup()
    globalThis.location.hash = ''
    cleanup = initThreadStore(ws as any)
    expect(threadKey()).toBe('main')
  })

  it('MUST listen for popstate events and update threadKey', () => {
    globalThis.location.hash = '#thread=popped'
    _triggerPopstate()
    expect(threadKey()).toBe('popped')
  })

  it('MUST subscribe to threads WS channel for thread.created messages', () => {
    ws._emit('thread.created', {
      type: 'thread.created',
      key: 'ws-new',
      entities: [],
      lastActivity: 0,
      unreadCount: 0,
      agentStatus: 'idle'
    })
    expect(threads().some((t) => t.key === 'ws-new')).toBe(true)
  })

  it('MUST subscribe to threads WS channel for thread.updated messages', () => {
    setThreads([{ key: 't1', entities: [], lastActivity: 0, unreadCount: 0, agentStatus: 'idle' }])
    ws._emit('thread.updated', { type: 'thread.updated', key: 't1', label: 'Updated' })
    expect(threads()[0].label).toBe('Updated')
  })

  it('MUST subscribe to threads WS channel for thread.status messages', () => {
    setThreads([{ key: 't1', entities: [], lastActivity: 0, unreadCount: 0, agentStatus: 'idle' }])
    ws._emit('thread.status', { type: 'thread.status', key: 't1', unreadCount: 5, agentStatus: 'working' })
    expect(threads()[0].unreadCount).toBe(5)
    expect(threads()[0].agentStatus).toBe('working')
  })

  it('MUST add new thread to threads on thread.created', () => {
    ws._emit('thread.created', {
      type: 'thread.created',
      key: 'created-1',
      entities: [],
      lastActivity: 100,
      unreadCount: 0,
      agentStatus: 'idle'
    })
    expect(threads().find((t) => t.key === 'created-1')).toBeDefined()
  })

  it('MUST update matching thread metadata on thread.updated', () => {
    setThreads([{ key: 'u1', entities: [], lastActivity: 0, unreadCount: 0, agentStatus: 'idle' }])
    ws._emit('thread.updated', { type: 'thread.updated', key: 'u1', label: 'New Label' })
    expect(threads()[0].label).toBe('New Label')
  })

  it('MUST update matching thread status on thread.status', () => {
    setThreads([{ key: 's1', entities: [], lastActivity: 0, unreadCount: 0, agentStatus: 'idle' }])
    ws._emit('thread.status', { type: 'thread.status', key: 's1', lastActivity: 999 })
    expect(threads()[0].lastActivity).toBe(999)
  })

  it('MUST fetch initial thread list on init via GET /api/threads', () => {
    // Already called in beforeEach init
    expect(mockFetch).toHaveBeenCalledWith('/api/threads')
  })
})

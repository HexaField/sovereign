import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock localStorage
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear()
  },
  writable: true
})

// Mock location/history
Object.defineProperty(globalThis, 'location', {
  value: { hash: '', pathname: '/' },
  writable: true
})
Object.defineProperty(globalThis, 'history', {
  value: { pushState: vi.fn() },
  writable: true
})

// Mock fetch
const mockFetch = vi.fn()

import {
  threadKey,
  setThreadKey,
  threads,
  setThreads,
  activeOrgIdForThreads,
  setActiveOrgIdForThreads,
  fetchThreadsForOrg,
  switchWorkspaceThreads,
  switchThread,
  createThread,
  addEntity,
  removeEntity,
  initThreadStore,
  _triggerPopstate
} from './store.js'
import type { ThreadInfo } from './store.js'

function mockThread(key: string, orgId = '_global'): ThreadInfo {
  return {
    key,
    entities: [{ orgId, projectId: 'p1', entityType: 'branch', entityRef: 'main' }],
    lastActivity: Date.now(),
    unreadCount: 0,
    agentStatus: 'idle'
  }
}

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

beforeEach(() => {
  store.clear()
  mockFetch.mockReset()
  setThreadKey('main')
  setThreads([])
  ;(globalThis as any).location = { hash: '', pathname: '/' }
  vi.mocked(history.pushState).mockClear()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchThreadsForOrg', () => {
  it('fetches threads with orgId query param', async () => {
    const data = { threads: [mockThread('t1', 'org1')] }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    fetchThreadsForOrg('org1')
    await vi.waitFor(() => expect(threads().length).toBe(1))

    expect(mockFetch).toHaveBeenCalledWith('/api/threads?orgId=org1')
    expect(threads()[0].key).toBe('t1')
  })

  it('filters out threads without keys', async () => {
    const data = { threads: [{ key: '', entities: [] }, mockThread('valid')] }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    fetchThreadsForOrg('org1')
    await vi.waitFor(() => expect(threads().length).toBe(1))
    expect(threads()[0].key).toBe('valid')
  })

  it('uses activeOrgIdForThreads when no arg provided', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ threads: [] }) })
    setActiveOrgIdForThreads('myorg')
    fetchThreadsForOrg()
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/threads?orgId=myorg'))
  })

  it('handles fetch failure gracefully', () => {
    mockFetch.mockRejectedValueOnce(new Error('network'))
    expect(() => fetchThreadsForOrg('org1')).not.toThrow()
  })
})

describe('switchWorkspaceThreads', () => {
  it('sets activeOrgIdForThreads and resets to main thread', () => {
    setThreadKey('some-thread')
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ threads: [] }) })

    switchWorkspaceThreads('org2')
    expect(activeOrgIdForThreads()).toBe('org2')
    expect(threadKey()).toBe('main')
  })

  it('pushes clean URL without hash', () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ threads: [] }) })
    switchWorkspaceThreads('org2')
    expect(history.pushState).toHaveBeenCalledWith(null, '', '/')
  })
})

describe('switchThread', () => {
  it('sets thread key and updates hash', () => {
    switchThread('my-thread')
    expect(threadKey()).toBe('my-thread')
    expect(history.pushState).toHaveBeenCalledWith(null, '', '#thread=my-thread')
  })
})

describe('createThread', () => {
  it('creates thread and switches to it', async () => {
    const newThread = mockThread('new-thread')
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ thread: newThread }) })

    await createThread('My Thread')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/threads',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ label: 'My Thread' })
      })
    )
    expect(threads()).toContainEqual(expect.objectContaining({ key: 'new-thread' }))
    expect(threadKey()).toBe('new-thread')
  })
})

describe('addEntity', () => {
  it('posts entity to thread endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({}) })
    const entity = { orgId: 'o', projectId: 'p', entityType: 'branch' as const, entityRef: 'main' }
    await addEntity('t1', entity)
    expect(mockFetch).toHaveBeenCalledWith('/api/threads/t1/entities', expect.objectContaining({ method: 'POST' }))
  })
})

describe('removeEntity', () => {
  it('sends DELETE request', async () => {
    mockFetch.mockResolvedValueOnce({})
    await removeEntity('t1', 'branch', 'main')
    expect(mockFetch).toHaveBeenCalledWith('/api/threads/t1/entities/branch/main', { method: 'DELETE' })
  })
})

describe('initThreadStore', () => {
  it('reads thread from hash on init', () => {
    ;(globalThis as any).location = { hash: '#thread=from-hash', pathname: '/' }
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })

    const cleanup = initThreadStore()
    expect(threadKey()).toBe('from-hash')
    cleanup()
  })

  it('fetches threads on init', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const cleanup = initThreadStore()
    expect(mockFetch).toHaveBeenCalledWith('/api/threads?orgId=_global')
    cleanup()
  })

  it('defaults to main when no hash', () => {
    ;(globalThis as any).location = { hash: '', pathname: '/' }
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })

    const cleanup = initThreadStore()
    expect(threadKey()).toBe('main')
    cleanup()
  })

  it('subscribes to WS channels when ws provided', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)
    expect(ws.subscribe).toHaveBeenCalledWith(['threads'])
    cleanup()
  })

  it('handles thread.created WS events', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)

    ws._emit('thread.created', { payload: { thread: mockThread('ws-new') } })
    expect(threads()).toContainEqual(expect.objectContaining({ key: 'ws-new' }))

    // Duplicate should not add
    ws._emit('thread.created', { payload: { thread: mockThread('ws-new') } })
    expect(threads().filter((t) => t.key === 'ws-new')).toHaveLength(1)
    cleanup()
  })

  it('handles thread.updated WS events', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)

    setThreads([mockThread('t1')])
    ws._emit('thread.updated', { payload: { thread: { ...mockThread('t1'), unreadCount: 5 } } })
    expect(threads().find((t) => t.key === 't1')?.unreadCount).toBe(5)
    cleanup()
  })

  it('handles thread.status WS events', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)

    setThreads([mockThread('t1')])
    ws._emit('thread.status', { payload: { key: 't1', agentStatus: 'working', unreadCount: 3 } })
    const t = threads().find((t) => t.key === 't1')
    expect(t?.agentStatus).toBe('working')
    expect(t?.unreadCount).toBe(3)
    cleanup()
  })

  it('ignores malformed thread.created events', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)

    ws._emit('thread.created', { payload: { thread: { key: '' } } })
    ws._emit('thread.created', { payload: { thread: {} } })
    expect(threads()).toHaveLength(0)
    cleanup()
  })

  it('responds to popstate events', () => {
    ;(globalThis as any).location = { hash: '', pathname: '/' }
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const cleanup = initThreadStore()

    ;(globalThis as any).location = { hash: '#thread=popped', pathname: '/' }
    _triggerPopstate()
    expect(threadKey()).toBe('popped')
    cleanup()
  })
})

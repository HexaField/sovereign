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

// Mock location/history with full href
function setLocation(hash = '', pathname = '/') {
  ;(globalThis as any).location = {
    hash,
    pathname,
    href: `http://localhost${pathname}${hash}`
  }
}
setLocation()

Object.defineProperty(globalThis, 'history', {
  value: { pushState: vi.fn(), replaceState: vi.fn() },
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
  renameThread,
  pinThread,
  reorderThreads,
  deleteThread,
  initThreadStore,
  _triggerPopstate
} from './store.js'
import { makeThread } from './test-factory.js'
import { sortThreads } from './thread-order.js'
import { getPresenceGatewayThreadId } from './presence-helper.js'

function mockThread(id: string, orgId = '_global'): ReturnType<typeof makeThread> {
  return makeThread({
    id,
    entities: [{ orgId, projectId: 'p1', entityType: 'branch', entityRef: 'main' }],
    lastActivity: Date.now()
  })
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
  setActiveOrgIdForThreads('_global')
  setLocation()
  vi.mocked(history.pushState).mockClear()
  vi.mocked(history.replaceState).mockClear()
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
    expect(threads()[0].id).toBe('t1')
  })

  it('filters out threads without ids', async () => {
    const data = { threads: [{ id: '', entities: [] }, mockThread('valid')] }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    fetchThreadsForOrg('org1')
    await vi.waitFor(() => expect(threads().length).toBe(1))
    expect(threads()[0].id).toBe('valid')
  })

  // Regression: the client carried its own `key`-based ThreadInfo and filtered
  // the list on `t.key`. After the server moved to canonical `{ id, label }`,
  // every thread was filtered out → empty dropdown. Ingest a raw id-keyed
  // server record (no `key`) and assert it surfaces with its label intact.
  it('ingests canonical id-keyed server threads (no legacy `key`)', async () => {
    const data = {
      threads: [
        {
          id: 'uuid-sovereign',
          label: 'sovereign',
          entities: [],
          workspaceIds: [],
          lastActivity: 0,
          unreadCount: 0,
          agentStatus: 'idle',
          createdAt: 0,
          archived: false
        }
      ]
    }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    fetchThreadsForOrg('org1')
    await vi.waitFor(() => expect(threads().length).toBe(1))
    expect(threads()[0].id).toBe('uuid-sovereign')
    expect(threads()[0].label).toBe('sovereign')
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

describe('fetchThreadsForOrg — reconciliation', () => {
  it('keeps threadKey when it is set but not in fetched list (no override)', async () => {
    setThreadKey('custom-thread')
    const data = { threads: [mockThread('t1'), mockThread('t2')] }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    fetchThreadsForOrg('org1')
    await vi.waitFor(() => expect(threads().length).toBe(2))
    // Should NOT auto-switch — current key is non-empty
    expect(threadKey()).toBe('custom-thread')
  })

  it('auto-selects first thread when threadKey is empty', async () => {
    setThreadKey('')
    setLocation()
    const data = { threads: [mockThread('first'), mockThread('second')] }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    fetchThreadsForOrg('org1')
    await vi.waitFor(() => expect(threadKey()).toBe('first'))
  })

  it('auto-selects past the hidden internal presence thread', async () => {
    setThreadKey('')
    setLocation()
    const internal = makeThread({ id: 'internal', presence: 'internal' })
    const data = { threads: [internal, mockThread('first')] }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    fetchThreadsForOrg('org1')
    await vi.waitFor(() => expect(threadKey()).toBe('first'))
  })

  it('keeps threadKey when it matches a fetched thread', async () => {
    setThreadKey('t2')
    const data = { threads: [mockThread('t1'), mockThread('t2')] }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    fetchThreadsForOrg('org1')
    await vi.waitFor(() => expect(threads().length).toBe(2))
    expect(threadKey()).toBe('t2')
  })

  it('preserves unregistered thread keys for gateway-only threads', async () => {
    // Simulates navigating to a thread that exists in gateway but not local registry
    setThreadKey('adam')
    const data = { threads: [mockThread('main'), mockThread('upgrades')] }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    fetchThreadsForOrg('_global')
    await vi.waitFor(() => expect(threads().length).toBe(2))
    // adam is not in registry but should NOT be overridden
    expect(threadKey()).toBe('adam')
  })
})

describe('switchWorkspaceThreads', () => {
  it('sets activeOrgIdForThreads', () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ threads: [] }) })
    switchWorkspaceThreads('org2')
    expect(activeOrgIdForThreads()).toBe('org2')
  })

  it('auto-selects first thread from new workspace', async () => {
    setLocation()
    const data = { threads: [mockThread('ws2-thread', 'org2')] }
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(data) })

    switchWorkspaceThreads('org2')
    await vi.waitFor(() => expect(threadKey()).toBe('ws2-thread'))
  })

  it('clears threadKey when workspace has no threads', async () => {
    setLocation()
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ threads: [] }) })

    switchWorkspaceThreads('empty-org')
    await vi.waitFor(() => expect(threadKey()).toBe(''))
  })
})

describe('switchThread', () => {
  it('sets thread key and updates hash', () => {
    setLocation('', '/')
    switchThread('my-thread')
    expect(threadKey()).toBe('my-thread')
    expect(history.replaceState).toHaveBeenCalledWith(null, '', expect.stringContaining('#thread=my-thread'))
  })
})

describe('createThread', () => {
  it('creates thread and switches to it', async () => {
    setLocation('', '/')
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
    expect(threads()).toContainEqual(expect.objectContaining({ id: 'new-thread' }))
    expect(threadKey()).toBe('new-thread')
  })

  it('sends workspaceIds when active workspace is not _global', async () => {
    setLocation('', '/')
    setActiveOrgIdForThreads('ws1')
    const newThread = mockThread('scoped-thread')
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ thread: newThread }) })

    await createThread('Scoped')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/threads',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ label: 'Scoped', workspaceIds: ['ws1'] })
      })
    )
  })

  it('omits workspaceIds when active workspace is _global', async () => {
    setLocation('', '/')
    setActiveOrgIdForThreads('_global')
    const newThread = mockThread('global-thread')
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ thread: newThread }) })

    await createThread('Global')
    // workspaceIds key absent (undefined → dropped by JSON.stringify)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/threads',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ label: 'Global' })
      })
    )
  })
})

describe('renameThread', () => {
  it('PATCHes the label and updates the thread list', async () => {
    setThreads([makeThread({ id: 't1', label: 'old' })])
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ thread: makeThread({ id: 't1', label: 'new' }) })
    })
    await renameThread('t1', 'new')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/threads/t1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ label: 'new' }) })
    )
    expect(threads()[0].label).toBe('new')
  })

  it('throws the server error and leaves the label alone', async () => {
    setThreads([makeThread({ id: 't1', label: 'old' })])
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({ error: 'bad label' }) })
    await expect(renameThread('t1', ' ')).rejects.toThrow('bad label')
    expect(threads()[0].label).toBe('old')
  })
})

describe('reorderThreads', () => {
  const ids = () => sortThreads(threads()).map((t) => t.id)

  it('reorders at once, POSTs the plan, then keeps the server values', async () => {
    setThreads([
      makeThread({ id: 'a', lastActivity: 3 }),
      makeThread({ id: 'b', lastActivity: 2 }),
      makeThread({ id: 'c', lastActivity: 1 })
    ])
    expect(ids()).toEqual(['a', 'b', 'c'])
    let resolve!: (v: unknown) => void
    mockFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const done = reorderThreads({ ids: ['c', 'a', 'b'] })
    // Optimistic: the new order shows before the server answers.
    expect(ids()).toEqual(['c', 'a', 'b'])
    resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          threads: [
            makeThread({ id: 'c', sortOrder: 10 }),
            makeThread({ id: 'a', sortOrder: 11 }),
            makeThread({ id: 'b', sortOrder: 12 })
          ]
        })
    })
    await done
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/threads/reorder',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ ids: ['c', 'a', 'b'] }) })
    )
    expect(threads().map((t) => t.sortOrder)).toEqual([11, 12, 10])
    expect(ids()).toEqual(['c', 'a', 'b'])
  })

  it('pins a thread dragged into the pinned group at once', async () => {
    setThreads([makeThread({ id: 'p', pinnedAt: 5 }), makeThread({ id: 'x' })])
    mockFetch.mockReturnValueOnce(new Promise(() => {}))
    void reorderThreads({ ids: ['x', 'p'], pinned: true })
    expect(threads().find((t) => t.id === 'x')?.pinnedAt).toBeGreaterThan(0)
    expect(ids()).toEqual(['x', 'p'])
  })

  it('reverts the order and pins the server refuses, and throws its error', async () => {
    setThreads([
      makeThread({ id: 'p', pinnedAt: 5, sortOrder: 0 }),
      makeThread({ id: 'a', lastActivity: 2, sortOrder: 0 }),
      makeThread({ id: 'b', lastActivity: 1, sortOrder: 1 })
    ])
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Thread not found: b' })
    })
    await expect(reorderThreads({ ids: ['b', 'p', 'a'], pinned: false })).rejects.toThrow('Thread not found: b')
    expect(threads().map((t) => [t.id, t.pinnedAt, t.sortOrder])).toEqual([
      ['p', 5, 0],
      ['a', undefined, 0],
      ['b', undefined, 1]
    ])
    expect(ids()).toEqual(['p', 'a', 'b'])
  })

  it('reverts on a network error too', async () => {
    setThreads([makeThread({ id: 'a', lastActivity: 2 }), makeThread({ id: 'b', lastActivity: 1 })])
    mockFetch.mockRejectedValueOnce(new Error('offline'))
    await expect(reorderThreads({ ids: ['b', 'a'] })).rejects.toThrow('offline')
    expect(threads().every((t) => t.sortOrder === undefined)).toBe(true)
    expect(ids()).toEqual(['a', 'b'])
  })
})

describe('pinThread', () => {
  it('pins at once, PATCHes { pinned: true } and keeps the server pinnedAt', async () => {
    setThreads([makeThread({ id: 't1' })])
    let resolve!: (v: unknown) => void
    mockFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const done = pinThread('t1', true)
    // Optimistic: pinned before the server answers.
    expect(threads()[0].pinnedAt).toBeGreaterThan(0)
    resolve({ ok: true, json: () => Promise.resolve({ thread: makeThread({ id: 't1', pinnedAt: 1234 }) }) })
    await expect(done).resolves.toBe(1234)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/threads/t1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ pinned: true }) })
    )
    expect(threads()[0].pinnedAt).toBe(1234)
  })

  it('unpins at once and PATCHes { pinned: false }', async () => {
    setThreads([makeThread({ id: 't1', pinnedAt: 99 })])
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ thread: makeThread({ id: 't1' }) }) })
    const done = pinThread('t1', false)
    expect(threads()[0].pinnedAt).toBeUndefined()
    await expect(done).resolves.toBeUndefined()
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/threads/t1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ pinned: false }) })
    )
    expect(threads()[0].pinnedAt).toBeUndefined()
  })

  it('reverts a pin the server refuses and throws its error', async () => {
    setThreads([makeThread({ id: 't1' })])
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Thread not found' })
    })
    await expect(pinThread('t1', true)).rejects.toThrow('Thread not found')
    expect(threads()[0].pinnedAt).toBeUndefined()
  })

  it('reverts an unpin when the request fails, keeping the original pinnedAt', async () => {
    setThreads([makeThread({ id: 't1', pinnedAt: 42 })])
    mockFetch.mockRejectedValueOnce(new Error('offline'))
    await expect(pinThread('t1', false)).rejects.toThrow('offline')
    expect(threads()[0].pinnedAt).toBe(42)
  })
})

describe('deleteThread', () => {
  it('removes a background thread without changing the open one', async () => {
    setThreads([makeThread({ id: 'main' }), makeThread({ id: 't2' })])
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
    await deleteThread('t2')
    expect(mockFetch).toHaveBeenCalledWith('/api/threads/t2', { method: 'DELETE' })
    expect(threads().map((t) => t.id)).toEqual(['main'])
    expect(threadKey()).toBe('main')
  })

  it('opens the most recent remaining thread when the open one is deleted', async () => {
    setThreads([
      makeThread({ id: 'main', lastActivity: 300 }),
      makeThread({ id: 'older', lastActivity: 100 }),
      makeThread({ id: 'newer', lastActivity: 200 })
    ])
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
    await deleteThread('main')
    expect(threadKey()).toBe('newer')
  })

  it('clears the selection when the last thread is deleted', async () => {
    setThreads([makeThread({ id: 'main' })])
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
    await deleteThread('main')
    expect(threads()).toEqual([])
    expect(threadKey()).toBe('')
  })

  it('throws and keeps the thread when the server refuses', async () => {
    setThreads([makeThread({ id: 'main' })])
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Thread not found' })
    })
    await expect(deleteThread('main')).rejects.toThrow('Thread not found')
    expect(threads()).toHaveLength(1)
  })
  it('never opens the hidden internal presence thread in place of an archived one', async () => {
    setThreads([
      makeThread({ id: 'main', lastActivity: 300 }),
      makeThread({ id: 'internal', lastActivity: 250, presence: 'internal' }),
      makeThread({ id: 'work', lastActivity: 100 })
    ])
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
    await deleteThread('main')
    expect(threadKey()).toBe('work')
  })

  it('archiving the open main presence thread opens its replacement when it arrives', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)
    setThreads([
      makeThread({ id: 'gw', lastActivity: 300, presence: 'gateway' }),
      makeThread({ id: 'work', lastActivity: 100 })
    ])
    setThreadKey('gw')
    // The server archives, then announces the new main thread.
    ws._emit('thread.deleted', { payload: { threadId: 'gw' } })
    expect(threadKey()).toBe('work')
    ws._emit('thread.created', { payload: { thread: makeThread({ id: 'gw2', presence: 'gateway' }) } })
    expect(threadKey()).toBe('gw2')
    expect(threads().map((t) => t.id)).toEqual(['work', 'gw2'])
    // Only once: a later main thread does not pull the user away.
    ws._emit('thread.created', { payload: { thread: makeThread({ id: 'gw3', presence: 'gateway' }) } })
    expect(threadKey()).toBe('gw2')
    cleanup()
  })

  it('refreshes the cached presence thread ids when a presence thread is archived', async () => {
    const presence = (id: string) => ({ ok: true, json: () => Promise.resolve({ gateway: { id }, internal: null }) })
    const ws = createMockWs()
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const cleanup = initThreadStore(ws as any)
    mockFetch.mockReset()
    mockFetch.mockResolvedValueOnce(presence('gw'))
    // Clear whatever an earlier test left cached.
    ws._emit('thread.updated', { payload: { threadId: 'x', patch: { presence: null } } })
    expect(await getPresenceGatewayThreadId()).toBe('gw')

    setThreads([makeThread({ id: 'gw', presence: 'gateway' })])
    ws._emit('thread.deleted', { payload: { threadId: 'gw' } })
    mockFetch.mockResolvedValueOnce(presence('gw2'))
    expect(await getPresenceGatewayThreadId()).toBe('gw2')
    cleanup()
  })

  it('a new main presence thread does not pull the user away when they archived something else', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)
    setThreads([makeThread({ id: 'gw', presence: 'gateway' }), makeThread({ id: 'work' })])
    setThreadKey('work')
    ws._emit('thread.deleted', { payload: { threadId: 'gw' } })
    ws._emit('thread.created', { payload: { thread: makeThread({ id: 'gw2', presence: 'gateway' }) } })
    expect(threadKey()).toBe('work')
    cleanup()
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
    setLocation('#thread=from-hash')
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })

    const cleanup = initThreadStore()
    expect(threadKey()).toBe('from-hash')
    cleanup()
  })

  it('fetches threads on init', () => {
    setActiveOrgIdForThreads('_global')
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const cleanup = initThreadStore()
    expect(mockFetch).toHaveBeenCalledWith('/api/threads?orgId=_global')
    cleanup()
  })

  it('returns empty string when no hash present', () => {
    setLocation('')
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })

    const cleanup = initThreadStore()
    // No hash = empty threadKey (reconciliation may auto-select later)
    expect(threadKey()).toBe('')
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
    expect(threads()).toContainEqual(expect.objectContaining({ id: 'ws-new' }))

    // Duplicate should not add
    ws._emit('thread.created', { payload: { thread: mockThread('ws-new') } })
    expect(threads().filter((t) => t.id === 'ws-new')).toHaveLength(1)
    cleanup()
  })

  it('handles thread.updated WS events', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)

    setThreads([mockThread('t1')])
    ws._emit('thread.updated', { payload: { thread: { ...mockThread('t1'), unreadCount: 5 } } })
    expect(threads().find((t) => t.id === 't1')?.unreadCount).toBe(5)
    cleanup()
  })

  it('applies pin changes from thread.updated WS events (null pinnedAt = unpinned)', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)

    setThreads([mockThread('t1')])
    ws._emit('thread.updated', { payload: { threadId: 't1', patch: { pinnedAt: 500 } } })
    expect(threads()[0].pinnedAt).toBe(500)
    ws._emit('thread.updated', { payload: { threadId: 't1', patch: { pinnedAt: null } } })
    expect(threads()[0].pinnedAt).toBeUndefined()
    cleanup()
  })

  it('applies manual order from thread.updated WS events (null sortOrder = dropped)', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)

    setThreads([mockThread('t1')])
    ws._emit('thread.updated', { payload: { threadId: 't1', patch: { sortOrder: 3 } } })
    expect(threads()[0].sortOrder).toBe(3)
    ws._emit('thread.updated', { payload: { threadId: 't1', patch: { pinnedAt: 9, sortOrder: null } } })
    expect(threads()[0].sortOrder).toBeUndefined()
    expect(threads()[0].pinnedAt).toBe(9)
    cleanup()
  })

  it('handles thread.deleted WS events', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)

    setThreads([mockThread('t1'), mockThread('t2')])
    setThreadKey('t1')
    ws._emit('thread.deleted', { payload: { threadId: 't1' } })
    expect(threads().map((t) => t.id)).toEqual(['t2'])
    expect(threadKey()).toBe('t2')
    cleanup()
  })

  it('handles thread.status WS events', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const ws = createMockWs()
    const cleanup = initThreadStore(ws as any)

    setThreads([mockThread('t1')])
    ws._emit('thread.status', { payload: { threadId: 't1', agentStatus: 'working', unreadCount: 3 } })
    const t = threads().find((t) => t.id === 't1')
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
    setLocation('')
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    const cleanup = initThreadStore()

    setLocation('#thread=popped')
    _triggerPopstate()
    expect(threadKey()).toBe('popped')
    cleanup()
  })

  it('responds to hashchange events (SW notification click updates threadKey)', () => {
    setLocation('')
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ threads: [] }) })
    // Capture the hashchange handler that initThreadStore installs.
    const listeners = new Map<string, EventListener>()
    const origAdd = globalThis.addEventListener
    const origRemove = globalThis.removeEventListener
    globalThis.addEventListener = ((type: string, fn: EventListener) => {
      listeners.set(type, fn)
    }) as typeof globalThis.addEventListener
    globalThis.removeEventListener = (() => {}) as typeof globalThis.removeEventListener

    const cleanup = initThreadStore()
    setLocation('#thread=via-hash')
    const handler = listeners.get('hashchange')
    expect(handler).toBeDefined()
    handler!(new Event('hashchange'))
    expect(threadKey()).toBe('via-hash')

    cleanup()
    globalThis.addEventListener = origAdd
    globalThis.removeEventListener = origRemove
  })
})

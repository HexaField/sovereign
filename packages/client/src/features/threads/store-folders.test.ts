import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const saved = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => saved.set(k, v),
    removeItem: (k: string) => saved.delete(k),
    clear: () => saved.clear()
  },
  writable: true
})
;(globalThis as any).location = { hash: '', pathname: '/', href: 'http://localhost/' }
Object.defineProperty(globalThis, 'history', { value: { pushState: vi.fn(), replaceState: vi.fn() }, writable: true })

import {
  threads,
  setThreads,
  folders,
  setFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  moveThreadToFolder,
  isFolderOpen,
  setFolderOpen,
  toggleFolder,
  fetchFolders,
  initThreadStore
} from './store.js'
import { makeThread } from './test-factory.js'

const mockFetch = vi.fn()
const ok = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })
const refused = (status: number, error: string) => ({ ok: false, status, json: () => Promise.resolve({ error }) })
const dogs = { id: 'f1', name: 'Dogs', createdAt: 1 }

beforeEach(() => {
  saved.clear()
  mockFetch.mockReset()
  setThreads([])
  setFolders([])
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('folders in the thread store', () => {
  it('fetchFolders loads the list, and keeps none when the server has no folders', async () => {
    mockFetch.mockResolvedValueOnce(ok({ folders: [dogs] }))
    await fetchFolders()
    expect(mockFetch).toHaveBeenCalledWith('/api/thread-folders', expect.objectContaining({ method: 'GET' }))
    expect(folders()).toEqual([dogs])
    setFolders([])
    mockFetch.mockResolvedValueOnce(refused(501, 'Thread folders are not supported'))
    await fetchFolders()
    expect(folders()).toEqual([])
  })

  it('createFolder POSTs the name, adds the folder and opens it', async () => {
    mockFetch.mockResolvedValueOnce(ok({ folder: dogs }))
    const made = await createFolder('Dogs')
    expect(made).toEqual(dogs)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/thread-folders',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Dogs' }) })
    )
    expect(folders()).toEqual([dogs])
    expect(isFolderOpen('f1')).toBe(true)
  })

  it('createFolder throws the server reason (a taken name) and adds nothing', async () => {
    mockFetch.mockResolvedValueOnce(refused(409, 'A folder named "Dogs" already exists'))
    await expect(createFolder('dogs')).rejects.toThrow('already exists')
    expect(folders()).toEqual([])
  })

  it('renameFolder keeps the server name', async () => {
    setFolders([dogs])
    mockFetch.mockResolvedValueOnce(ok({ folder: { ...dogs, name: 'Dog care' } }))
    await renameFolder('f1', ' Dog care ')
    expect(folders()[0].name).toBe('Dog care')
  })

  it('deleteFolder drops the folder and unfiles its threads at once, keeping the threads', async () => {
    setFolders([dogs])
    setThreads([makeThread({ id: 'a', folderId: 'f1', sortOrder: 3 }), makeThread({ id: 'b' })])
    setFolderOpen('f1', true)
    let resolve!: (v: unknown) => void
    mockFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const done = deleteFolder('f1')
    expect(folders()).toEqual([])
    expect(threads().map((t) => [t.id, t.folderId, t.sortOrder])).toEqual([
      ['a', undefined, undefined],
      ['b', undefined, undefined]
    ])
    resolve(ok({ success: true }))
    await done
    expect(isFolderOpen('f1')).toBe(false)
  })

  it('deleteFolder puts everything back when the server refuses', async () => {
    setFolders([dogs])
    setThreads([makeThread({ id: 'a', folderId: 'f1' })])
    mockFetch.mockResolvedValueOnce(refused(500, 'disk full'))
    await expect(deleteFolder('f1')).rejects.toThrow('disk full')
    expect(folders()).toEqual([dogs])
    expect(threads()[0].folderId).toBe('f1')
  })

  it('moveThreadToFolder files at once (top of the folder) and PUTs the folder', async () => {
    setFolders([dogs])
    setThreads([makeThread({ id: 'a', sortOrder: 2, pinnedAt: 9 })])
    mockFetch.mockResolvedValueOnce(ok({ thread: {} }))
    await moveThreadToFolder('a', 'f1')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/threads/a/folder',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ folderId: 'f1' }) })
    )
    expect(threads()[0]).toMatchObject({ folderId: 'f1', pinnedAt: 9 })
    expect(threads()[0].sortOrder).toBeUndefined()
  })

  it('moveThreadToFolder takes a thread out with null, and skips a move that changes nothing', async () => {
    setThreads([makeThread({ id: 'a', folderId: 'f1' })])
    mockFetch.mockResolvedValueOnce(ok({ thread: {} }))
    await moveThreadToFolder('a', null)
    expect(threads()[0].folderId).toBeUndefined()
    await moveThreadToFolder('a', null)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('moveThreadToFolder reverts when the server refuses', async () => {
    setThreads([makeThread({ id: 'a', sortOrder: 4 })])
    mockFetch.mockResolvedValueOnce(refused(404, 'Folder not found: f9'))
    await expect(moveThreadToFolder('a', 'f9')).rejects.toThrow('Folder not found')
    expect(threads()[0]).toMatchObject({ sortOrder: 4 })
    expect(threads()[0].folderId).toBeUndefined()
  })

  it('moveThreadToFolder still asks the server for a thread this list does not hold', async () => {
    mockFetch.mockResolvedValueOnce(ok({ thread: {} }))
    await moveThreadToFolder('elsewhere', 'f1')
    expect(mockFetch).toHaveBeenCalledWith('/api/threads/elsewhere/folder', expect.anything())
  })

  it('open folders are kept per browser', () => {
    toggleFolder('f1')
    expect(isFolderOpen('f1')).toBe(true)
    expect(JSON.parse(saved.get('sovereign:openThreadFolders')!)).toEqual(['f1'])
    toggleFolder('f1')
    expect(isFolderOpen('f1')).toBe(false)
  })

  it('follows thread.folders and folder changes from thread.updated over the WS', () => {
    mockFetch.mockResolvedValue(ok({ threads: [], folders: [] }))
    const handlers = new Map<string, (msg: any) => void>()
    const ws = {
      connected: () => true,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      on: (type: string, h: (msg: any) => void) => {
        handlers.set(type, h)
        return () => handlers.delete(type)
      },
      send: vi.fn(),
      close: vi.fn()
    }
    const cleanup = initThreadStore(ws as any)
    handlers.get('thread.folders')!({ payload: { folders: [dogs, { bogus: true }] } })
    expect(folders()).toEqual([dogs])
    setThreads([makeThread({ id: 'a' })])
    handlers.get('thread.updated')!({ payload: { threadId: 'a', patch: { folderId: 'f1', sortOrder: null } } })
    expect(threads()[0].folderId).toBe('f1')
    handlers.get('thread.updated')!({ payload: { threadId: 'a', patch: { folderId: null } } })
    expect(threads()[0].folderId).toBeUndefined()
    cleanup()
  })
})

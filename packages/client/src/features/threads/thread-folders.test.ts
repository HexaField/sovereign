import { describe, it, expect, beforeEach } from 'vitest'
import { folderOf, layoutThreads, loadOpenFolders, saveOpenFolders, sortFolders } from './thread-folders.js'

type T = { id: string; folderId?: string | null; pinnedAt?: number; sortOrder?: number; lastActivity?: number }

const ids = (list: readonly T[]) => list.map((t) => t.id)

describe('sortFolders', () => {
  it('sorts by name, ignoring case and reading numbers as numbers', () => {
    const sorted = sortFolders([
      { id: '1', name: 'dogs' },
      { id: '2', name: 'Cats' },
      { id: '3', name: 'Week 10' },
      { id: '4', name: 'Week 9' }
    ])
    expect(sorted.map((f) => f.name)).toEqual(['Cats', 'dogs', 'Week 9', 'Week 10'])
  })
})

describe('folderOf', () => {
  it('is the folder when known, else the main list', () => {
    const known = new Set(['f1'])
    expect(folderOf({ id: 'a', folderId: 'f1' }, known)).toBe('f1')
    expect(folderOf({ id: 'a', folderId: 'gone' }, known)).toBeUndefined()
    expect(folderOf({ id: 'a', folderId: null }, known)).toBeUndefined()
    expect(folderOf({ id: 'a' }, known)).toBeUndefined()
  })
})

describe('layoutThreads', () => {
  const folders = [
    { id: 'dogs', name: 'Dogs' },
    { id: 'cats', name: 'Cats' },
    { id: 'empty', name: 'Birds' }
  ]
  const threads: T[] = [
    { id: 'pinned', pinnedAt: 5 },
    { id: 'loose', lastActivity: 9 },
    { id: 'old', lastActivity: 1 },
    { id: 'breeding', folderId: 'dogs', sortOrder: 2 },
    { id: 'grooming', folderId: 'dogs', sortOrder: 1 },
    { id: 'tips', folderId: 'dogs', pinnedAt: 3 },
    { id: 'naps', folderId: 'cats' },
    { id: 'orphan', folderId: 'deleted', lastActivity: 5 }
  ]

  it('splits the main list from the folders, A–Z, each in thread-list order', () => {
    const l = layoutThreads(threads, folders)
    expect(ids(l.main)).toEqual(['pinned', 'loose', 'orphan', 'old'])
    expect(l.pinnedCount).toBe(1)
    expect(l.folders.map((f) => f.name)).toEqual(['Birds', 'Cats', 'Dogs'])
    expect(ids(l.inFolder.get('dogs')!)).toEqual(['tips', 'grooming', 'breeding'])
    expect(ids(l.inFolder.get('cats')!)).toEqual(['naps'])
    expect(l.inFolder.get('empty')).toEqual([])
  })

  it('with a search: matching threads, and folders whose name or threads match', () => {
    const l = layoutThreads(threads, folders, {
      thread: (t) => t.id.includes('o'),
      folder: (f) => f.name === 'Cats'
    })
    expect(ids(l.main)).toEqual(['loose', 'orphan', 'old'])
    expect(l.pinnedCount).toBe(0)
    // Birds: neither its name nor (no) threads match. Cats: its name does, so all of its threads show.
    expect(l.folders.map((f) => f.name)).toEqual(['Cats', 'Dogs'])
    expect(ids(l.inFolder.get('cats')!)).toEqual(['naps'])
    expect(ids(l.inFolder.get('dogs')!)).toEqual(['grooming'])
  })

  it('with no folders everything is the main list', () => {
    const l = layoutThreads(threads, [])
    expect(l.main).toHaveLength(threads.length)
    expect(l.folders).toEqual([])
  })
})

describe('open folders', () => {
  const saved = new Map<string, string>()
  beforeEach(() => {
    saved.clear()
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) },
      writable: true,
      configurable: true
    })
  })

  it('round-trips through localStorage and survives junk', () => {
    saveOpenFolders(new Set(['a', 'b']))
    expect([...loadOpenFolders()]).toEqual(['a', 'b'])
    saved.set('sovereign:openThreadFolders', '{oops')
    expect(loadOpenFolders().size).toBe(0)
    saved.set('sovereign:openThreadFolders', '[1,"c"]')
    expect([...loadOpenFolders()]).toEqual(['c'])
  })
})

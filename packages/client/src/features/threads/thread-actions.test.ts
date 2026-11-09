import { describe, it, expect, vi } from 'vitest'
import { createThreadActions } from './thread-actions.js'

const contextMenuEvent = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as MouseEvent

describe('createThreadActions', () => {
  it('toggles one menu at a time', () => {
    const a = createThreadActions({ remove: vi.fn(), rename: vi.fn() })
    a.toggleMenu('t1')
    expect(a.isMenuOpen('t1')).toBe(true)
    a.toggleMenu('t2')
    expect(a.isMenuOpen('t1')).toBe(false)
    expect(a.isMenuOpen('t2')).toBe(true)
    a.toggleMenu('t2')
    expect(a.menuKey()).toBeNull()
  })

  it('opens the menu on right-click and suppresses the browser menu', () => {
    const a = createThreadActions({ remove: vi.fn(), rename: vi.fn() })
    const e = contextMenuEvent()
    a.onContextMenu('t1', e)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(a.isMenuOpen('t1')).toBe(true)
  })

  it('leaves right-click alone inside a rename field', () => {
    const a = createThreadActions({ remove: vi.fn(), rename: vi.fn() })
    a.startRename('t1')
    const e = contextMenuEvent()
    a.onContextMenu('t1', e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(a.menuKey()).toBeNull()
    expect(a.isRenaming('t1')).toBe(true)
  })

  it('Rename closes the menu and starts renaming that thread', () => {
    const a = createThreadActions({ remove: vi.fn(), rename: vi.fn() })
    a.openMenu('t1')
    a.startRename('t1')
    expect(a.menuKey()).toBeNull()
    expect(a.isRenaming('t1')).toBe(true)
    expect(a.busy()).toBe(true)
    a.stopRename()
    expect(a.busy()).toBe(false)
  })

  it('saves a rename and reports it', async () => {
    const rename = vi.fn().mockResolvedValue(undefined)
    const onRenamed = vi.fn()
    const a = createThreadActions({ remove: vi.fn(), rename, onRenamed })
    await a.saveRename('t1', 'Wedding flowers')
    expect(rename).toHaveBeenCalledWith('t1', 'Wedding flowers')
    expect(onRenamed).toHaveBeenCalledWith('t1', 'Wedding flowers')
  })

  it('a failed rename rejects (the field shows it) and reports nothing', async () => {
    const onRenamed = vi.fn()
    const a = createThreadActions({
      remove: vi.fn(),
      rename: vi.fn().mockRejectedValue(new Error('label must be a non-empty string')),
      onRenamed
    })
    await expect(a.saveRename('t1', ' ')).rejects.toThrow('non-empty')
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('Delete asks first and only deletes on confirm', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const onDeleted = vi.fn()
    const a = createThreadActions({ remove, rename: vi.fn(), onDeleted })
    a.openMenu('t1')
    a.askDelete('t1')
    expect(a.isConfirming('t1')).toBe(true)
    expect(remove).not.toHaveBeenCalled()

    expect(await a.confirmDelete('t1')).toBe(true)
    expect(remove).toHaveBeenCalledWith('t1')
    expect(onDeleted).toHaveBeenCalledWith('t1')
    expect(a.menuKey()).toBeNull()
    expect(a.confirmKey()).toBeNull()
    expect(a.deletingKey()).toBeNull()
  })

  it('Cancel closes the confirmation without deleting', () => {
    const remove = vi.fn()
    const a = createThreadActions({ remove, rename: vi.fn() })
    a.askDelete('t1')
    a.closeMenu()
    expect(a.confirmKey()).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  it('keeps the menu open with the server error when a delete fails', async () => {
    const onDeleted = vi.fn()
    const a = createThreadActions({
      remove: vi.fn().mockRejectedValue(new Error('Thread not found')),
      rename: vi.fn(),
      onDeleted
    })
    a.askDelete('t1')
    expect(await a.confirmDelete('t1')).toBe(false)
    expect(a.error()).toBe('Thread not found')
    expect(a.isConfirming('t1')).toBe(true)
    expect(onDeleted).not.toHaveBeenCalled()
    expect(a.deletingKey()).toBeNull()
  })

  it('ignores a second confirm while a delete is in flight', async () => {
    let finish!: () => void
    const remove = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const a = createThreadActions({ remove, rename: vi.fn() })
    a.askDelete('t1')
    const first = a.confirmDelete('t1')
    expect(a.isDeleting('t1')).toBe(true)
    expect(await a.confirmDelete('t1')).toBe(false)
    finish()
    expect(await first).toBe(true)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('uses the store by default, so the shared thread list updates', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('./store.js')
    store.setThreads([{ id: 'keep' } as never, { id: 'gone' } as never])
    const a = createThreadActions()
    a.askDelete('gone')
    expect(await a.confirmDelete('gone')).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/threads/gone', { method: 'DELETE' })
    expect(store.threads().map((t) => t.id)).toEqual(['keep'])
    vi.unstubAllGlobals()
  })

  it('Pin to top closes the menu, pins and reports the new pinnedAt', async () => {
    const pin = vi.fn().mockResolvedValue(777)
    const onPinned = vi.fn()
    const a = createThreadActions({ remove: vi.fn(), rename: vi.fn(), pin, onPinned })
    a.openMenu('t1')
    await expect(a.togglePin('t1', true)).resolves.toBe(true)
    expect(pin).toHaveBeenCalledWith('t1', true)
    expect(onPinned).toHaveBeenCalledWith('t1', 777)
    expect(a.menuKey()).toBeNull()
  })

  it('Unpin reports an unset pinnedAt', async () => {
    const onPinned = vi.fn()
    const a = createThreadActions({
      remove: vi.fn(),
      rename: vi.fn(),
      pin: vi.fn().mockResolvedValue(undefined),
      onPinned
    })
    await a.togglePin('t1', false)
    expect(onPinned).toHaveBeenCalledWith('t1', undefined)
  })

  it('a failed pin reopens the menu with the error and reports nothing', async () => {
    const onPinned = vi.fn()
    const a = createThreadActions({
      remove: vi.fn(),
      rename: vi.fn(),
      pin: vi.fn().mockRejectedValue(new Error('Thread not found')),
      onPinned
    })
    await expect(a.togglePin('t1', true)).resolves.toBe(false)
    expect(a.isMenuOpen('t1')).toBe(true)
    expect(a.error()).toBe('Thread not found')
    expect(onPinned).not.toHaveBeenCalled()
  })
})

describe('createThreadActions — Move to folder', () => {
  const folders = () => [
    { id: 'f2', name: 'dogs' },
    { id: 'f1', name: 'Cats' }
  ]

  it('offers the other folders A–Z', () => {
    const a = createThreadActions({ remove: vi.fn(), rename: vi.fn(), folderList: folders })
    expect(a.folderChoices().map((f) => f.name)).toEqual(['Cats', 'dogs'])
    expect(a.folderChoices('f1').map((f) => f.name)).toEqual(['dogs'])
  })

  it('"Move to folder…" shows the list; picking one closes the menu and moves', async () => {
    const move = vi.fn(() => Promise.resolve())
    const onMoved = vi.fn()
    const a = createThreadActions({ remove: vi.fn(), rename: vi.fn(), move, onMoved, folderList: folders })
    a.openMenu('t1')
    a.startPick('t1')
    expect(a.isPicking('t1')).toBe(true)
    await expect(a.moveTo('t1', 'f2')).resolves.toBe(true)
    expect(move).toHaveBeenCalledWith('t1', 'f2')
    expect(onMoved).toHaveBeenCalledWith('t1', 'f2')
    expect(a.menuKey()).toBeNull()
    expect(a.isPicking('t1')).toBe(false)
  })

  it('a refused move reopens the folder list with the reason', async () => {
    const a = createThreadActions({
      remove: vi.fn(),
      rename: vi.fn(),
      move: vi.fn().mockRejectedValue(new Error('Folder not found: f9')),
      folderList: folders
    })
    await expect(a.moveTo('t1', 'f9')).resolves.toBe(false)
    expect(a.isPicking('t1')).toBe(true)
    expect(a.error()).toBe('Folder not found: f9')
  })

  it('"New folder…" makes the folder, then files the thread in it', async () => {
    const move = vi.fn(() => Promise.resolve())
    const makeFolder = vi.fn(async (name: string) => ({ id: 'f3', name }))
    const a = createThreadActions({ remove: vi.fn(), rename: vi.fn(), move, makeFolder, folderList: folders })
    await expect(a.moveToNew('t1', 'Birds')).resolves.toBe(true)
    expect(makeFolder).toHaveBeenCalledWith('Birds')
    expect(move).toHaveBeenCalledWith('t1', 'f3')
  })

  it('a taken folder name keeps the menu open with the reason and moves nothing', async () => {
    const move = vi.fn()
    const a = createThreadActions({
      remove: vi.fn(),
      rename: vi.fn(),
      move,
      makeFolder: vi.fn().mockRejectedValue(new Error('A folder named "dogs" already exists')),
      folderList: folders
    })
    a.startPick('t1')
    await expect(a.moveToNew('t1', 'Dogs')).resolves.toBe(false)
    expect(a.error()).toContain('already exists')
    expect(a.isPicking('t1')).toBe(true)
    expect(move).not.toHaveBeenCalled()
  })
})

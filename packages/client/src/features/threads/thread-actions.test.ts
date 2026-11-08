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
})

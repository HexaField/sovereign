/**
 * File tabs + sessionStorage persistence tests.
 *
 * Validates: tab open/close lifecycle, sessionStorage persistence,
 * tab deduplication, and active-tab tracking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock sessionStorage before importing the store
const sessionStore = new Map<string, string>()
const mockSessionStorage = {
  getItem: (key: string) => sessionStore.get(key) ?? null,
  setItem: (key: string, value: string) => sessionStore.set(key, value),
  removeItem: (key: string) => sessionStore.delete(key),
  clear: () => sessionStore.clear(),
  get length() {
    return sessionStore.size
  },
  key: (_index: number) => null
}
Object.defineProperty(globalThis, 'sessionStorage', { value: mockSessionStorage, writable: true })

// Also need localStorage for the module
const localStore = new Map<string, string>()
const mockLocalStorage = {
  getItem: (key: string) => localStore.get(key) ?? null,
  setItem: (key: string, value: string) => localStore.set(key, value),
  removeItem: (key: string) => localStore.delete(key),
  clear: () => localStore.clear(),
  get length() {
    return localStore.size
  },
  key: (_index: number) => null
}
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true })

// Mock fetch for autoSelectProject
vi.stubGlobal(
  'fetch',
  vi.fn(() =>
    Promise.resolve({
      ok: false,
      json: () => Promise.resolve(null)
    })
  )
)

describe('File tab lifecycle', () => {
  beforeEach(async () => {
    sessionStore.clear()
    localStore.clear()
    vi.resetModules()
  })

  it('opens a tab and tracks it as active', async () => {
    const { openFileTab, openFileTabs, activeFileTabId } = await import('./store.js')

    openFileTab('/home/test/file.ts', '_workspace')

    const tabs = openFileTabs()
    expect(tabs.length).toBe(1)
    expect(tabs[0].path).toBe('/home/test/file.ts')
    expect(tabs[0].label).toBe('file.ts')
    expect(activeFileTabId()).toBe(tabs[0].id)
  })

  it('deduplicates tabs by id', async () => {
    const { openFileTab, openFileTabs } = await import('./store.js')

    openFileTab('/home/test/file.ts', '_workspace')
    openFileTab('/home/test/file.ts', '_workspace')

    expect(openFileTabs().length).toBe(1)
  })

  it('switches active tab on second open', async () => {
    const { openFileTab, activeFileTabId } = await import('./store.js')

    openFileTab('/home/test/a.ts', '_workspace')
    const firstId = activeFileTabId()
    openFileTab('/home/test/b.ts', '_workspace')
    const secondId = activeFileTabId()

    expect(firstId).not.toBe(secondId)
    expect(secondId).toContain('b.ts')
  })

  it('closes a tab and selects the previous one', async () => {
    const { openFileTab, closeFileTab, openFileTabs, activeFileTabId } = await import('./store.js')

    openFileTab('/home/test/a.ts', '_workspace')
    openFileTab('/home/test/b.ts', '_workspace')
    openFileTab('/home/test/c.ts', '_workspace')

    const tabs = openFileTabs()
    expect(tabs.length).toBe(3)
    expect(activeFileTabId()).toBe(tabs[2].id) // c.ts

    closeFileTab(tabs[2].id) // close c.ts

    expect(openFileTabs().length).toBe(2)
    expect(activeFileTabId()).toBe(tabs[1].id) // b.ts now active
  })

  it('persists tabs in sessionStorage', async () => {
    const { openFileTab } = await import('./store.js')

    openFileTab('/home/test/file.ts', '_workspace')

    const stored = sessionStore.get('sovereign:file:openTabs')
    expect(stored).toBeDefined()
    const parsed = JSON.parse(stored!)
    expect(parsed.length).toBe(1)
    expect(parsed[0].path).toBe('/home/test/file.ts')
  })

  it('persists active tab id in sessionStorage', async () => {
    const { openFileTab } = await import('./store.js')

    openFileTab('/home/test/file.ts', '_workspace')

    const stored = sessionStore.get('sovereign:file:activeTabId')
    expect(stored).toBeDefined()
    expect(stored).toContain('file.ts')
  })

  it('restores tabs from sessionStorage on module load', async () => {
    // Pre-populate sessionStorage
    const tab = {
      id: 'file:_workspace:/home/test/restored.ts',
      path: '/home/test/restored.ts',
      projectId: '_workspace',
      label: 'restored.ts'
    }
    sessionStore.set('sovereign:file:openTabs', JSON.stringify([tab]))
    sessionStore.set('sovereign:file:activeTabId', tab.id)

    vi.resetModules()
    const { openFileTabs, activeFileTabId } = await import('./store.js')

    expect(openFileTabs().length).toBe(1)
    expect(openFileTabs()[0].path).toBe('/home/test/restored.ts')
    expect(activeFileTabId()).toBe(tab.id)
  })
})

describe('File state isolation (sessionStorage vs localStorage)', () => {
  beforeEach(() => {
    sessionStore.clear()
    localStore.clear()
    vi.resetModules()
  })

  it('stores expanded dirs in sessionStorage, not localStorage', async () => {
    const { setPersistedExpandedDirs } = await import('./store.js')

    setPersistedExpandedDirs(['/home/test/src', '/home/test/lib'])

    expect(sessionStore.get('sovereign:file:expandedDirs')).toBeDefined()
    // Verify it went to sessionStorage, not localStorage under the old key format
    const lsKeys = [...localStore.keys()]
    expect(lsKeys.some((k) => k.includes('expandedDirs'))).toBe(false)
  })

  it('stores last open file path in sessionStorage', async () => {
    const { setLastOpenFilePath } = await import('./store.js')

    setLastOpenFilePath('/home/test/hello.ts')

    expect(sessionStore.get('sovereign:file:lastOpenFilePath')).toBeDefined()
    const lsKeys = [...localStore.keys()]
    expect(lsKeys.some((k) => k.includes('lastOpenFilePath'))).toBe(false)
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock localStorage before importing the store
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, val: string) => storage.set(key, val),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear()
})

describe('shell-store', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('should be importable and export shellState', async () => {
    const mod = await import('./shell-store.js')
    expect(mod.shellState).toBeDefined()
    expect(mod.shellState.theme).toBe('dark')
    expect(mod.shellState.sidebarCollapsed).toBe(false)
  })

  it('should toggle sidebar', async () => {
    const { shellState, toggleSidebar } = await import('./shell-store.js')
    const initial = shellState.sidebarCollapsed
    toggleSidebar()
    expect(shellState.sidebarCollapsed).toBe(!initial)
  })

  it('should open and close tabs', async () => {
    const { shellState, openTab, closeTab } = await import('./shell-store.js')
    const tab = {
      id: 'test-1',
      title: 'Test',
      component: () => null,
      closable: true,
      pinned: false
    }
    openTab(tab)
    expect(shellState.tabs.length).toBeGreaterThanOrEqual(1)
    expect(shellState.activeTabId).toBe('test-1')

    closeTab('test-1')
    expect(shellState.tabs.find((t) => t.id === 'test-1')).toBeUndefined()
  })

  it('should persist to localStorage', async () => {
    const { setTheme } = await import('./shell-store.js')
    setTheme('light')
    const stored = storage.get('sovereign-shell-state')
    expect(stored).toBeDefined()
    const parsed = JSON.parse(stored!)
    expect(parsed.theme).toBe('light')
  })

  it('should clamp sidebar width', async () => {
    const { shellState, setSidebarWidth } = await import('./shell-store.js')
    setSidebarWidth(50)
    expect(shellState.sidebarWidth).toBe(160)
    setSidebarWidth(1000)
    expect(shellState.sidebarWidth).toBe(500)
  })
})

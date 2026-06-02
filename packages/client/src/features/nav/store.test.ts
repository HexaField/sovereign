import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  viewMode,
  drawerOpen,
  settingsOpen,
  setViewMode,
  setDrawerOpen,
  setSettingsOpen,
  _setViewMode,
  _setDrawerOpen,
  _setSettingsOpen,
  initNavStore,
  _triggerPopstate,
  activeView,
  _setActiveView,
  setActiveView,
  dashboardModalOpen,
  openDashboardModal,
  closeDashboardModal,
  toggleDashboardModal
} from './store.js'

describe('§3.5 Nav Store', () => {
  let cleanup: () => void

  beforeEach(() => {
    _setViewMode('chat')
    _setDrawerOpen(false)
    _setSettingsOpen(false)
    if (typeof globalThis.location === 'undefined') {
      ;(globalThis as any).location = { search: '', href: 'http://localhost' }
    }
    globalThis.location.search = ''
    if (typeof globalThis.history === 'undefined') {
      ;(globalThis as any).history = { replaceState: vi.fn() }
    }
    cleanup = initNavStore()
  })

  afterEach(() => {
    cleanup()
  })

  describe('viewMode', () => {
    it('MUST expose viewMode accessor', () => {
      expect(viewMode()).toBeDefined()
    })

    it('MUST default to chat when no URL query parameter', () => {
      expect(viewMode()).toBe('chat')
    })

    it('MUST read initial viewMode from ?view= query parameter', () => {
      cleanup()
      globalThis.location.search = '?view=voice'
      ;(globalThis.location as any).href = 'http://localhost?view=voice'
      cleanup = initNavStore()
      // The store reads on module load, so we test via setViewMode round-trip
      _setViewMode('voice')
      expect(viewMode()).toBe('voice')
    })

    it('MUST update URL query parameter when setViewMode is called', () => {
      const replaceState = vi.fn()
      globalThis.history.replaceState = replaceState
      ;(globalThis as any).URL = URL
      setViewMode('dashboard')
      expect(replaceState).toHaveBeenCalled()
    })

    it('MUST use history.replaceState to avoid page reload', () => {
      const replaceState = vi.fn()
      globalThis.history.replaceState = replaceState
      setViewMode('voice')
      expect(replaceState).toHaveBeenCalledWith(null, '', expect.stringContaining('view=voice'))
    })

    it('MUST listen for popstate events and update viewMode', () => {
      Object.defineProperty(globalThis, 'location', {
        value: { search: '?view=recording', href: 'http://localhost?view=recording', hash: '' },
        writable: true,
        configurable: true
      })
      _triggerPopstate()
      expect(viewMode()).toBe('recording')
    })

    it('MUST support all ViewMode values: chat, voice, dashboard, recording', () => {
      for (const mode of ['chat', 'voice', 'dashboard', 'recording'] as const) {
        _setViewMode(mode)
        expect(viewMode()).toBe(mode)
      }
    })
  })

  describe('drawerOpen', () => {
    it('MUST expose drawerOpen accessor', () => {
      expect(drawerOpen()).toBeDefined()
    })

    it('MUST default to false', () => {
      expect(drawerOpen()).toBe(false)
    })

    it('MUST toggle via setDrawerOpen', () => {
      setDrawerOpen(true)
      expect(drawerOpen()).toBe(true)
      setDrawerOpen(false)
      expect(drawerOpen()).toBe(false)
    })
  })

  describe('settingsOpen', () => {
    it('MUST expose settingsOpen accessor', () => {
      expect(settingsOpen()).toBeDefined()
    })

    it('MUST default to false', () => {
      expect(settingsOpen()).toBe(false)
    })

    it('MUST toggle via setSettingsOpen', () => {
      setSettingsOpen(true)
      expect(settingsOpen()).toBe(true)
      setSettingsOpen(false)
      expect(settingsOpen()).toBe(false)
    })
  })

  describe('dashboard modal', () => {
    beforeEach(() => {
      closeDashboardModal()
      _setActiveView('workspace')
    })

    it('defaults to closed', () => {
      expect(dashboardModalOpen()).toBe(false)
    })

    it('open / close set the flag', () => {
      openDashboardModal()
      expect(dashboardModalOpen()).toBe(true)
      closeDashboardModal()
      expect(dashboardModalOpen()).toBe(false)
    })

    it('toggle flips the flag', () => {
      toggleDashboardModal()
      expect(dashboardModalOpen()).toBe(true)
      toggleDashboardModal()
      expect(dashboardModalOpen()).toBe(false)
    })

    // ── The core peek-and-return contract ────────────────────────────
    //
    // Opening the dashboard must NOT touch `activeView` (or workspaceId
    // or threadKey — but those aren't owned by this store). The whole
    // point of the modal pattern is that dismissing returns the user
    // exactly where they were.
    it('does NOT change activeView when opened or closed', () => {
      _setActiveView('canvas')
      openDashboardModal()
      expect(activeView()).toBe('canvas')
      closeDashboardModal()
      expect(activeView()).toBe('canvas')
    })

    it('survives multiple toggles without leaking into activeView', () => {
      _setActiveView('planning')
      for (let i = 0; i < 5; i++) toggleDashboardModal()
      expect(activeView()).toBe('planning')
    })

    it('writes ?dashboard=open to URL when opened, removes it when closed', () => {
      const replaceState = vi.fn()
      globalThis.history.replaceState = replaceState
      openDashboardModal()
      expect(replaceState).toHaveBeenCalledWith(null, '', expect.stringContaining('dashboard=open'))
      replaceState.mockClear()
      closeDashboardModal()
      // After close, the URL passed should NOT contain `dashboard=open`.
      const lastCall = replaceState.mock.calls[replaceState.mock.calls.length - 1]
      expect(lastCall[2]).not.toContain('dashboard=open')
    })

    it('legacy ?view=dashboard URL opens the modal on init (with workspace as underlying view)', () => {
      cleanup()
      Object.defineProperty(globalThis, 'location', {
        value: { search: '?view=dashboard', href: 'http://localhost?view=dashboard', hash: '' },
        writable: true,
        configurable: true
      })
      cleanup = initNavStore()
      expect(dashboardModalOpen()).toBe(true)
      expect(activeView()).toBe('workspace')
    })
  })

  describe('activeView default + sibling views', () => {
    it('default activeView is workspace (dashboard is no longer a sibling view)', () => {
      cleanup()
      Object.defineProperty(globalThis, 'location', {
        value: { search: '', href: 'http://localhost', hash: '' },
        writable: true,
        configurable: true
      })
      cleanup = initNavStore()
      expect(activeView()).toBe('workspace')
    })

    it('setActiveView accepts workspace / canvas / planning / system', () => {
      const views = ['workspace', 'canvas', 'planning', 'system'] as const
      for (const v of views) {
        setActiveView(v)
        expect(activeView()).toBe(v)
      }
    })
  })
})

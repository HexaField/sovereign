import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  viewMode,
  drawerOpen,
  setViewMode,
  setDrawerOpen,
  _setViewMode,
  _setDrawerOpen,
  initNavStore,
  _triggerPopstate,
  activeView,
  _setActiveView,
  setActiveView,
  activeAgentTab,
  _setActiveAgentTab,
  setActiveAgentTab,
  toggleMode,
  navigateToAgent,
  closeDashboardModal,
  type NavView,
  type AgentTab
} from './store.js'

describe('§3.5 Nav Store', () => {
  let cleanup: () => void

  beforeEach(() => {
    _setViewMode('chat')
    _setDrawerOpen(false)
    _setActiveView('workspace')
    _setActiveAgentTab('hex')
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

  describe('two-mode architecture', () => {
    beforeEach(() => {
      _setActiveView('workspace')
      _setActiveAgentTab('hex')
    })

    it('defaults to workspace view', () => {
      expect(activeView()).toBe('workspace')
    })

    it('setActiveView switches between workspace and agent', () => {
      setActiveView('agent')
      expect(activeView()).toBe('agent')
      setActiveView('workspace')
      expect(activeView()).toBe('workspace')
    })

    it('toggleMode flips between workspace and agent', () => {
      expect(toggleMode()).toBe('agent')
      expect(activeView()).toBe('agent')
      expect(toggleMode()).toBe('workspace')
      expect(activeView()).toBe('workspace')
    })

    it('agent tabs default to hex', () => {
      expect(activeAgentTab()).toBe('hex')
    })

    it('setActiveAgentTab switches tabs', () => {
      const tabs: AgentTab[] = ['hex', 'overview', 'settings', 'system']
      for (const tab of tabs) {
        setActiveAgentTab(tab)
        expect(activeAgentTab()).toBe(tab)
      }
    })

    it('navigateToAgent sets view + tab', () => {
      navigateToAgent('settings')
      expect(activeView()).toBe('agent')
      expect(activeAgentTab()).toBe('settings')
    })

    it('navigateToAgent defaults to hex tab', () => {
      navigateToAgent()
      expect(activeView()).toBe('agent')
      expect(activeAgentTab()).toBe('hex')
    })

    it('closeDashboardModal compat shim switches to workspace', () => {
      setActiveView('agent')
      closeDashboardModal()
      expect(activeView()).toBe('workspace')
    })

    it('does NOT leak agent tab state when switching views', () => {
      setActiveAgentTab('system')
      setActiveView('workspace')
      setActiveView('agent')
      // Tab should persist across view switches.
      expect(activeAgentTab()).toBe('system')
    })

    it('writes ?view=agent&tab=<tab> to URL when agent view active', () => {
      const replaceState = vi.fn()
      globalThis.history.replaceState = replaceState
      _setActiveAgentTab('settings')
      setActiveView('agent')
      const lastCall = replaceState.mock.calls[replaceState.mock.calls.length - 1]
      expect(lastCall[2]).toContain('view=agent')
      expect(lastCall[2]).toContain('tab=settings')
    })

    it('omits tab param when tab=hex (default)', () => {
      const replaceState = vi.fn()
      globalThis.history.replaceState = replaceState
      _setActiveAgentTab('hex')
      setActiveView('agent')
      const lastCall = replaceState.mock.calls[replaceState.mock.calls.length - 1]
      expect(lastCall[2]).toContain('view=agent')
      expect(lastCall[2]).not.toContain('tab=')
    })

    it('legacy ?view=dashboard URL resolves to agent/overview on init', () => {
      cleanup()
      Object.defineProperty(globalThis, 'location', {
        value: { search: '?view=dashboard', href: 'http://localhost?view=dashboard', hash: '' },
        writable: true,
        configurable: true
      })
      cleanup = initNavStore()
      expect(activeView()).toBe('agent')
      expect(activeAgentTab()).toBe('overview')
    })

    it('legacy ?view=system URL resolves to agent/system on init', () => {
      cleanup()
      Object.defineProperty(globalThis, 'location', {
        value: { search: '?view=system', href: 'http://localhost?view=system', hash: '' },
        writable: true,
        configurable: true
      })
      cleanup = initNavStore()
      expect(activeView()).toBe('agent')
      expect(activeAgentTab()).toBe('system')
    })
  })

  describe('activeView default + sibling views', () => {
    it('default activeView resolves to workspace', () => {
      cleanup()
      Object.defineProperty(globalThis, 'location', {
        value: { search: '', href: 'http://localhost', hash: '' },
        writable: true,
        configurable: true
      })
      cleanup = initNavStore()
      expect(activeView()).toBe('workspace')
    })

    it('setActiveView accepts workspace / agent', () => {
      const views: NavView[] = ['workspace', 'agent']
      for (const v of views) {
        setActiveView(v)
        expect(activeView()).toBe(v)
      }
    })
  })
})

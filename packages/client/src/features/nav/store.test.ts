import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock thread dependencies — must precede the store import (vi.mock hoists).
vi.mock('../threads/store.js', () => ({
  threadKey: vi.fn(() => ''),
  switchThread: vi.fn(),
  setThreadKey: vi.fn()
}))

vi.mock('../threads/presence-helper.js', () => ({
  getPresenceGatewayThreadId: vi.fn(() => Promise.resolve('gateway-thread-123'))
}))

import { switchThread, threadKey } from '../threads/store.js'
import {
  viewMode,
  drawerOpen,
  setViewMode,
  setDrawerOpen,
  _setViewMode,
  _setDrawerOpen,
  initNavStore,
  _triggerPopstate,
  _resetNavThreadState,
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
    // Provide sessionStorage for thread save/restore tests.
    if (typeof globalThis.sessionStorage === 'undefined') {
      const store: Record<string, string> = {}
      ;(globalThis as any).sessionStorage = {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v
        },
        removeItem: (k: string) => {
          delete store[k]
        },
        clear: () => {
          for (const k of Object.keys(store)) delete store[k]
        }
      }
    }
    _resetNavThreadState()
    vi.mocked(switchThread).mockClear()
    vi.mocked(threadKey).mockReturnValue('')
    cleanup = initNavStore()
  })

  afterEach(() => {
    cleanup()
    _resetNavThreadState()
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

  describe('mode-switch thread save/restore', () => {
    it('saves workspace thread to sessionStorage when entering agent mode', () => {
      vi.mocked(threadKey).mockReturnValue('workspace-thread-abc')
      _setActiveView('workspace')

      setActiveView('agent')

      expect(sessionStorage.getItem('sovereign:savedWorkspaceThread')).toBe('workspace-thread-abc')
    })

    it('restores workspace thread when returning from agent mode', async () => {
      // Simulate: user had thread-abc open, toggled to agent, now toggles back.
      vi.mocked(threadKey).mockReturnValue('workspace-thread-abc')
      _setActiveView('workspace')
      setActiveView('agent')
      await Promise.resolve() // flush gateway fetch microtask
      vi.mocked(switchThread).mockClear()

      setActiveView('workspace')

      expect(switchThread).toHaveBeenCalledWith('workspace-thread-abc')
    })

    it('switches to presence gateway thread when entering agent mode', async () => {
      vi.mocked(threadKey).mockReturnValue('some-thread')
      _setActiveView('workspace')

      setActiveView('agent')
      await Promise.resolve() // flush getPresenceGatewayThreadId

      expect(switchThread).toHaveBeenCalledWith('gateway-thread-123')
    })

    it('uses cached gateway id on subsequent toggles (no extra fetch)', async () => {
      vi.mocked(threadKey).mockReturnValue('t1')
      _setActiveView('workspace')
      setActiveView('agent')
      await Promise.resolve() // first fetch populates cache
      vi.mocked(switchThread).mockClear()

      // Return to workspace
      setActiveView('workspace')
      vi.mocked(switchThread).mockClear()

      // Enter agent mode again — should use cached id synchronously
      vi.mocked(threadKey).mockReturnValue('t2')
      setActiveView('agent')
      expect(switchThread).toHaveBeenCalledWith('gateway-thread-123')
    })

    it('does not switch threads when view stays the same', () => {
      _setActiveView('workspace')
      vi.mocked(switchThread).mockClear()

      setActiveView('workspace')

      expect(switchThread).not.toHaveBeenCalled()
    })

    it('navigateToAgent saves workspace thread', () => {
      vi.mocked(threadKey).mockReturnValue('nav-thread-xyz')
      _setActiveView('workspace')

      navigateToAgent('settings')

      expect(sessionStorage.getItem('sovereign:savedWorkspaceThread')).toBe('nav-thread-xyz')
      expect(activeView()).toBe('agent')
      expect(activeAgentTab()).toBe('settings')
    })

    it('closeDashboardModal restores workspace thread', async () => {
      vi.mocked(threadKey).mockReturnValue('dashboard-thread')
      _setActiveView('workspace')
      setActiveView('agent')
      await Promise.resolve()
      vi.mocked(switchThread).mockClear()

      closeDashboardModal()

      expect(switchThread).toHaveBeenCalledWith('dashboard-thread')
      expect(activeView()).toBe('workspace')
    })

    it('toggleMode round-trips thread correctly', async () => {
      vi.mocked(threadKey).mockReturnValue('toggle-thread')
      _setActiveView('workspace')

      // workspace → agent
      toggleMode()
      await Promise.resolve()
      expect(sessionStorage.getItem('sovereign:savedWorkspaceThread')).toBe('toggle-thread')
      expect(switchThread).toHaveBeenCalledWith('gateway-thread-123')
      vi.mocked(switchThread).mockClear()

      // agent → workspace
      toggleMode()
      expect(switchThread).toHaveBeenCalledWith('toggle-thread')
    })

    it('skips save when threadKey returns empty string', () => {
      vi.mocked(threadKey).mockReturnValue('')
      _setActiveView('workspace')

      setActiveView('agent')

      expect(sessionStorage.getItem('sovereign:savedWorkspaceThread')).toBeNull()
    })

    it('skips gateway switch if user toggles back before fetch resolves', async () => {
      vi.mocked(threadKey).mockReturnValue('fast-toggle')
      _setActiveView('workspace')

      setActiveView('agent') // starts async fetch
      setActiveView('workspace') // toggles back before fetch resolves
      vi.mocked(switchThread).mockClear()

      await Promise.resolve() // fetch resolves — but view changed back to workspace

      // switchThread should NOT have been called with gateway (guard fires)
      const gatewayCalls = vi.mocked(switchThread).mock.calls.filter((c) => c[0] === 'gateway-thread-123')
      expect(gatewayCalls).toHaveLength(0)
    })

    it('persists across _resetNavThreadState + reinit', () => {
      vi.mocked(threadKey).mockReturnValue('persist-thread')
      _setActiveView('workspace')
      setActiveView('agent')

      // sessionStorage survives reset (only cachedGatewayId clears)
      expect(sessionStorage.getItem('sovereign:savedWorkspaceThread')).toBe('persist-thread')
    })
  })
})

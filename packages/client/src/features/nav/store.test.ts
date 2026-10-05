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
  activeView,
  _setActiveView,
  setActiveView,
  activeAgentTab,
  _setActiveAgentTab,
  setActiveAgentTab,
  toggleMode,
  closeDashboardModal,
  type NavView,
  type AgentTab
} from './store.js'

/** Re-run initNavStore as if the page loaded at `search`. */
function loadAt(search: string, reinit: () => void): () => void {
  reinit()
  Object.defineProperty(globalThis, 'location', {
    value: { search, href: `http://localhost/${search}`, hash: '' },
    writable: true,
    configurable: true
  })
  return initNavStore()
}

describe('§3.5 Nav Store', () => {
  let cleanup: () => void

  beforeEach(() => {
    _setViewMode('chat')
    _setDrawerOpen(false)
    _setActiveView('workspace')
    _setActiveAgentTab('overview')
    if (typeof globalThis.location === 'undefined') {
      ;(globalThis as any).location = { search: '', href: 'http://localhost' }
    }
    globalThis.location.search = ''
    if (typeof globalThis.history === 'undefined') {
      ;(globalThis as any).history = { replaceState: vi.fn() }
    }
    vi.mocked(switchThread).mockClear()
    vi.mocked(threadKey).mockReturnValue('')
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

    it('agent tabs default to overview', () => {
      cleanup = loadAt('', cleanup)
      expect(activeAgentTab()).toBe('overview')
    })

    it('setActiveAgentTab switches tabs', () => {
      const tabs: AgentTab[] = ['overview', 'forest', 'tasks', 'system']
      for (const tab of tabs) {
        setActiveAgentTab(tab)
        expect(activeAgentTab()).toBe(tab)
      }
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

    it('writes ?view=agent&tab=<tab> to URL when agent view active, for every tab', () => {
      const replaceState = vi.fn()
      globalThis.history.replaceState = replaceState
      _setActiveAgentTab('overview')
      setActiveView('agent')
      const lastCall = replaceState.mock.calls[replaceState.mock.calls.length - 1]
      expect(lastCall[2]).toContain('view=agent')
      expect(lastCall[2]).toContain('tab=overview')
    })

    it('?tab=tasks URL resolves to agent/tasks on init', () => {
      cleanup = loadAt('?view=agent&tab=tasks', cleanup)
      expect(activeView()).toBe('agent')
      expect(activeAgentTab()).toBe('tasks')
    })

    it('legacy ?view=dashboard URL resolves to agent/overview on init', () => {
      cleanup = loadAt('?view=dashboard', cleanup)
      expect(activeView()).toBe('agent')
      expect(activeAgentTab()).toBe('overview')
    })

    it('legacy ?view=system URL resolves to agent/system on init', () => {
      cleanup = loadAt('?view=system', cleanup)
      expect(activeView()).toBe('agent')
      expect(activeAgentTab()).toBe('system')
    })

    it('legacy ?tab=settings resolves to agent/overview (settings moved to the health popover)', () => {
      cleanup = loadAt('?view=agent&tab=settings', cleanup)
      expect(activeView()).toBe('agent')
      expect(activeAgentTab()).toBe('overview')
    })
  })

  describe('activeView default + sibling views', () => {
    it('default activeView resolves to workspace', () => {
      cleanup = loadAt('', cleanup)
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

  // The presence thread lives in the workspace like any other thread, so
  // switching modes never changes the open thread.
  describe('presence thread in the workspace', () => {
    it('leaves the open thread alone when entering and leaving agent mode', async () => {
      vi.mocked(threadKey).mockReturnValue('workspace-thread-abc')
      toggleMode()
      toggleMode()
      setActiveAgentTab('tasks')
      setActiveView('agent')
      closeDashboardModal()
      await Promise.resolve()
      expect(switchThread).not.toHaveBeenCalled()
    })

    it.each(['?view=agent', '?view=agent&tab=hex'])(
      'opens a legacy Hex-tab URL (%s) as the presence thread in the workspace',
      async (search) => {
        const replaceState = vi.fn()
        globalThis.history.replaceState = replaceState
        cleanup = loadAt(search, cleanup)
        await Promise.resolve()

        expect(activeView()).toBe('workspace')
        expect(switchThread).toHaveBeenCalledWith('gateway-thread-123')
        const url = replaceState.mock.calls[replaceState.mock.calls.length - 1][2]
        expect(url).toContain('view=workspace')
        expect(url).not.toContain('tab=')
      }
    )

    it('does not switch to the presence thread when it is already open', async () => {
      vi.mocked(threadKey).mockReturnValue('gateway-thread-123')
      cleanup = loadAt('?view=agent', cleanup)
      await Promise.resolve()
      expect(switchThread).not.toHaveBeenCalled()
    })
  })
})

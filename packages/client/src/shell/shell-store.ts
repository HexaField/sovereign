import { createStore, produce } from 'solid-js/store'
import type { ShellState, TabData } from './types.js'

const STORAGE_KEY = 'sovereign-shell-state'

const defaultState: ShellState = {
  sidebarWidth: 260,
  sidebarCollapsed: false,
  bottomHeight: 200,
  bottomVisible: false,
  tabs: [],
  activeTabId: null,
  theme: 'dark'
}

function loadState(): ShellState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ShellState>
      // Tabs contain components (functions) which can't be serialized,
      // so we only restore layout prefs
      return {
        ...defaultState,
        sidebarWidth: parsed.sidebarWidth ?? defaultState.sidebarWidth,
        sidebarCollapsed: parsed.sidebarCollapsed ?? defaultState.sidebarCollapsed,
        bottomHeight: parsed.bottomHeight ?? defaultState.bottomHeight,
        bottomVisible: parsed.bottomVisible ?? defaultState.bottomVisible,
        theme: parsed.theme ?? defaultState.theme,
        activeTabId: parsed.activeTabId ?? defaultState.activeTabId,
        tabs: [] // tabs restored by caller if needed
      }
    }
  } catch {
    // ignore
  }
  return { ...defaultState }
}

function persistState(state: ShellState) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        bottomHeight: state.bottomHeight,
        bottomVisible: state.bottomVisible,
        theme: state.theme,
        activeTabId: state.activeTabId
      })
    )
  } catch {
    // ignore
  }
}

const [shellState, setShellState] = createStore<ShellState>(loadState())

function updateAndPersist(updater: (s: ShellState) => void) {
  setShellState(produce(updater))
  persistState(shellState)
}

export function setSidebarWidth(width: number) {
  updateAndPersist((s) => {
    s.sidebarWidth = Math.max(160, Math.min(500, width))
  })
}

export function toggleSidebar() {
  updateAndPersist((s) => {
    s.sidebarCollapsed = !s.sidebarCollapsed
  })
}

export function setSidebarCollapsed(collapsed: boolean) {
  updateAndPersist((s) => {
    s.sidebarCollapsed = collapsed
  })
}

export function setBottomHeight(height: number) {
  updateAndPersist((s) => {
    s.bottomHeight = Math.max(100, Math.min(600, height))
  })
}

export function toggleBottomPanel() {
  updateAndPersist((s) => {
    s.bottomVisible = !s.bottomVisible
  })
}

export function setBottomVisible(visible: boolean) {
  updateAndPersist((s) => {
    s.bottomVisible = visible
  })
}

export function setTheme(theme: 'dark' | 'light') {
  updateAndPersist((s) => {
    s.theme = theme
  })
}

export function openTab(tab: TabData) {
  const existing = shellState.tabs.find((t) => t.id === tab.id)
  if (existing) {
    updateAndPersist((s) => {
      s.activeTabId = tab.id
    })
    return
  }
  updateAndPersist((s) => {
    s.tabs.push(tab)
    s.activeTabId = tab.id
  })
}

export function closeTab(tabId: string) {
  updateAndPersist((s) => {
    const idx = s.tabs.findIndex((t) => t.id === tabId)
    if (idx === -1) return
    const tab = s.tabs[idx]
    if (!tab.closable) return
    s.tabs.splice(idx, 1)
    if (s.activeTabId === tabId) {
      s.activeTabId = s.tabs.length > 0 ? s.tabs[Math.max(0, idx - 1)].id : null
    }
  })
}

export function setActiveTab(tabId: string) {
  updateAndPersist((s) => {
    s.activeTabId = tabId
  })
}

export function pinTab(tabId: string) {
  updateAndPersist((s) => {
    const tab = s.tabs.find((t) => t.id === tabId)
    if (tab) tab.pinned = !tab.pinned
  })
}

export function reorderTabs(fromIndex: number, toIndex: number) {
  updateAndPersist((s) => {
    const [tab] = s.tabs.splice(fromIndex, 1)
    s.tabs.splice(toIndex, 0, tab)
  })
}

export { shellState }

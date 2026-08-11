import { createSignal } from 'solid-js'

// --- Legacy ViewMode (kept for backward compat) ---
export type ViewMode =
  | 'chat'
  | 'voice'
  | 'dashboard'
  | 'recording'
  | 'events'
  | 'logs'
  | 'architecture'
  | 'files'
  | 'plans'

// --- NavView — two top-level modes. ---
//
// `workspace` — multi-agent / multi-thread workspace with sidebar, file
// browser, and per-membrane thread picker.
//
// `agent` — single-agent context: the user's primary interface with
// Hex (or whatever the configured agent name). Contains tabs for the
// presence thread chat, overview dashboard, settings, and system status.
export type NavView = 'workspace' | 'agent'

// --- Agent-context tabs (visible when activeView === 'agent') ---
export type AgentTab = 'hex' | 'overview' | 'settings' | 'system'

const VALID_NAV_VIEWS: NavView[] = ['workspace', 'agent']
const VALID_AGENT_TABS: AgentTab[] = ['hex', 'overview', 'settings', 'system']

function readNavViewFromUrl(): NavView {
  if (typeof location === 'undefined') return 'workspace'
  const params = new URLSearchParams(location.search)
  const v = params.get('view')
  if (v && VALID_NAV_VIEWS.includes(v as NavView)) return v as NavView
  // Legacy `?view=dashboard` → resolve to agent/overview.
  if (v === 'dashboard') return 'agent'
  // Legacy `?view=system` → resolve to agent/system.
  if (v === 'system') return 'agent'
  return 'workspace'
}

function readAgentTabFromUrl(): AgentTab {
  if (typeof location === 'undefined') return 'hex'
  const params = new URLSearchParams(location.search)
  // Legacy `?view=dashboard` → overview tab.
  if (params.get('view') === 'dashboard' || params.get('dashboard') === 'open') return 'overview'
  // Legacy `?view=system` → system tab.
  if (params.get('view') === 'system') return 'system'
  const t = params.get('tab')
  if (t && VALID_AGENT_TABS.includes(t as AgentTab)) return t as AgentTab
  return 'hex'
}

function readViewModeFromUrl(): ViewMode {
  if (typeof location === 'undefined') return 'chat'
  const params = new URLSearchParams(location.search)
  const v = params.get('view')
  const valid: ViewMode[] = [
    'chat',
    'voice',
    'dashboard',
    'recording',
    'events',
    'logs',
    'architecture',
    'files',
    'plans'
  ]
  if (valid.includes(v as ViewMode)) return v as ViewMode
  return 'chat'
}

export const [viewMode, _setViewMode] = createSignal<ViewMode>(readViewModeFromUrl())
export const [activeView, _setActiveView] = createSignal<NavView>(readNavViewFromUrl())
export const [activeAgentTab, _setActiveAgentTab] = createSignal<AgentTab>(readAgentTabFromUrl())
export const [drawerOpen, _setDrawerOpen] = createSignal(false)

/** Write current view + agent tab + workspace to URL (replaceState). */
export function syncViewToUrl(view: NavView, workspaceId?: string): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return
  const url = new URL(location.href)
  url.searchParams.set('view', view)
  // Clean up legacy params.
  url.searchParams.delete('dashboard')
  if (view === 'agent') {
    const tab = activeAgentTab()
    if (tab !== 'hex') url.searchParams.set('tab', tab)
    else url.searchParams.delete('tab')
  } else {
    url.searchParams.delete('tab')
  }
  if (workspaceId !== undefined) {
    if (workspaceId && workspaceId !== '_global') url.searchParams.set('workspace', workspaceId)
    else url.searchParams.delete('workspace')
  }
  history.replaceState(null, '', url.toString())
}

export function setActiveView(view: NavView): void {
  _setActiveView(view)
  syncViewToUrl(view)
}

export function setActiveAgentTab(tab: AgentTab): void {
  _setActiveAgentTab(tab)
  if (activeView() === 'agent') syncViewToUrl('agent')
}

/**
 * Toggle between workspace and agent modes.
 * Returns the new view so callers can coordinate thread switching.
 */
export function toggleMode(): NavView {
  const next: NavView = activeView() === 'workspace' ? 'agent' : 'workspace'
  setActiveView(next)
  return next
}

/**
 * Navigate to the agent context with a specific tab.
 * Used by dashboard components that want to leave the overview and go to workspace.
 */
export function navigateToAgent(tab: AgentTab = 'hex'): void {
  _setActiveAgentTab(tab)
  setActiveView('agent')
}

/**
 * Backward-compat shim — dashboard components call this to navigate
 * away from the overview to workspace mode. Equivalent to
 * setActiveView('workspace').
 */
export function closeDashboardModal(): void {
  setActiveView('workspace')
}

export function setViewMode(mode: ViewMode): void {
  _setViewMode(mode)
  if (typeof history !== 'undefined' && typeof location !== 'undefined') {
    const url = new URL(location.href)
    url.searchParams.set('view', mode)
    history.replaceState(null, '', url.toString())
  }
}

export function setDrawerOpen(open: boolean): void {
  _setDrawerOpen(open)
}

// System view active tab (shared so Header can render it in agent/system tab)
export type SystemTabId = 'status' | 'agents' | 'activity' | 'config' | 'jobs'
export const [activeSystemTab, setActiveSystemTab] = createSignal<SystemTabId>('status')

let popstateHandler: (() => void) | null = null

export function initNavStore(): () => void {
  _setViewMode(readViewModeFromUrl())
  _setActiveView(readNavViewFromUrl())
  _setActiveAgentTab(readAgentTabFromUrl())
  popstateHandler = () => {
    _setViewMode(readViewModeFromUrl())
    _setActiveView(readNavViewFromUrl())
    _setActiveAgentTab(readAgentTabFromUrl())
  }
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('popstate', popstateHandler)
  }
  return () => {
    if (popstateHandler && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('popstate', popstateHandler)
    }
  }
}

/** @internal — for testing */
export function _triggerPopstate(): void {
  if (popstateHandler) popstateHandler()
}

import { createSignal } from 'solid-js'
import { threadKey, switchThread } from '../threads/store.js'
import { getPresenceGatewayThreadId } from '../threads/presence-helper.js'

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
// `agent` — agent-wide views: overview dashboard, knowledge forest, tasks
// and system status. The presence thread opens in the workspace like any
// other thread; settings live in the header's Service Health popover.
export type NavView = 'workspace' | 'agent'

// --- Agent-context tabs (visible when activeView === 'agent') ---
export type AgentTab = 'overview' | 'forest' | 'tasks' | 'system'

const VALID_NAV_VIEWS: NavView[] = ['workspace', 'agent']
const VALID_AGENT_TABS: AgentTab[] = ['overview', 'forest', 'tasks', 'system']
const DEFAULT_AGENT_TAB: AgentTab = 'overview'

/** A URL from before the Hex tab went away: `?view=agent` with no tab, or
 *  `tab=hex`, meant "the presence thread". It now opens in the workspace. */
function isLegacyHexUrl(): boolean {
  if (typeof location === 'undefined') return false
  const params = new URLSearchParams(location.search)
  if (params.get('view') !== 'agent') return false
  const tab = params.get('tab')
  return tab === null || tab === 'hex'
}

function readNavViewFromUrl(): NavView {
  if (typeof location === 'undefined') return 'workspace'
  if (isLegacyHexUrl()) return 'workspace'
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
  if (typeof location === 'undefined') return DEFAULT_AGENT_TAB
  const params = new URLSearchParams(location.search)
  // Legacy `?view=system` → system tab.
  if (params.get('view') === 'system') return 'system'
  const t = params.get('tab')
  if (t && VALID_AGENT_TABS.includes(t as AgentTab)) return t as AgentTab
  // Legacy `?view=dashboard`, `tab=settings`, `tab=hex`, or no tab → overview.
  return DEFAULT_AGENT_TAB
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
    url.searchParams.set('tab', activeAgentTab())
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
export type SystemTabId = 'status' | 'devices' | 'agents' | 'activity' | 'config' | 'jobs'
export const [activeSystemTab, setActiveSystemTab] = createSignal<SystemTabId>('status')

let popstateHandler: (() => void) | null = null

export function initNavStore(): () => void {
  const legacyHex = isLegacyHexUrl()
  _setViewMode(readViewModeFromUrl())
  _setActiveView(readNavViewFromUrl())
  _setActiveAgentTab(readAgentTabFromUrl())
  if (legacyHex) {
    // An old "Hex tab" link: show the presence thread in the workspace.
    syncViewToUrl('workspace')
    void getPresenceGatewayThreadId().then((id) => {
      if (id && threadKey() !== id) switchThread(id)
    })
  }
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

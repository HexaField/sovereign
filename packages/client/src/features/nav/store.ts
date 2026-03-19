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

// --- New NavView type (§1.2) ---
export type NavView = 'dashboard' | 'workspace' | 'canvas' | 'planning' | 'system'

const VALID_NAV_VIEWS: NavView[] = ['dashboard', 'workspace', 'canvas', 'planning', 'system']

function readNavViewFromUrl(): NavView {
  if (typeof location === 'undefined') return 'dashboard'
  const params = new URLSearchParams(location.search)
  const v = params.get('view')
  if (v && VALID_NAV_VIEWS.includes(v as NavView)) return v as NavView
  return 'dashboard'
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
export const [drawerOpen, _setDrawerOpen] = createSignal(false)
export const [settingsOpen, _setSettingsOpen] = createSignal(false)

/** Write current view + workspace to URL search params (replaceState, no navigation) */
export function syncViewToUrl(view: NavView, workspaceId?: string): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return
  const url = new URL(location.href)
  if (view === 'dashboard') url.searchParams.delete('view')
  else url.searchParams.set('view', view)
  // If workspaceId provided, update it; otherwise preserve existing
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

export function setSettingsOpen(open: boolean): void {
  _setSettingsOpen(open)
}

// System view active tab (shared so Header can render it)
export type SystemTabId =
  | 'overview'
  | 'architecture'
  | 'logs'
  | 'health'
  | 'config'
  | 'devices'
  | 'jobs'
  | 'events'
  | 'threads'
export const [activeSystemTab, setActiveSystemTab] = createSignal<SystemTabId>('overview')

let popstateHandler: (() => void) | null = null

export function initNavStore(): () => void {
  _setViewMode(readViewModeFromUrl())
  _setActiveView(readNavViewFromUrl())
  popstateHandler = () => {
    _setViewMode(readViewModeFromUrl())
    _setActiveView(readNavViewFromUrl())
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

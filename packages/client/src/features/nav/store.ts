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

// --- NavView — the underlying "page" the user is on. ---
//
// `dashboard` is intentionally NOT in this union. The dashboard is now
// a full-page modal overlay (see `dashboardModalOpen`), not a sibling
// page. The legacy URL pattern `?view=dashboard` is still recognised on
// load and translated to "workspace view + modal open" — see
// `readNavViewFromUrl` and `readDashboardModalFromUrl` below.
export type NavView = 'workspace' | 'canvas' | 'planning' | 'system'

const VALID_NAV_VIEWS: NavView[] = ['workspace', 'canvas', 'planning', 'system']

function readNavViewFromUrl(): NavView {
  if (typeof location === 'undefined') return 'workspace'
  const params = new URLSearchParams(location.search)
  const v = params.get('view')
  if (v && VALID_NAV_VIEWS.includes(v as NavView)) return v as NavView
  // Legacy `?view=dashboard` → resolve to workspace; modal open comes
  // from `readDashboardModalFromUrl` separately.
  return 'workspace'
}

/**
 * Whether the dashboard modal should be open at startup. Returns true
 * for either the canonical marker `?dashboard=open` or the legacy
 * `?view=dashboard` URL.
 */
function readDashboardModalFromUrl(): boolean {
  if (typeof location === 'undefined') return false
  const params = new URLSearchParams(location.search)
  return params.get('dashboard') === 'open' || params.get('view') === 'dashboard'
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
export const [dashboardModalOpen, _setDashboardModalOpen] = createSignal<boolean>(readDashboardModalFromUrl())
export const [drawerOpen, _setDrawerOpen] = createSignal(false)
export const [settingsOpen, _setSettingsOpen] = createSignal(false)

/** Write current view + workspace to URL search params (replaceState, no navigation). */
export function syncViewToUrl(view: NavView, workspaceId?: string): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return
  const url = new URL(location.href)
  // Always write the view explicitly — `workspace` is no longer the
  // implicit default (since dashboard was dropped from the union, there
  // is no "no-param means dashboard" shorthand anymore).
  url.searchParams.set('view', view)
  // If workspaceId provided, update it; otherwise preserve existing.
  if (workspaceId !== undefined) {
    if (workspaceId && workspaceId !== '_global') url.searchParams.set('workspace', workspaceId)
    else url.searchParams.delete('workspace')
  }
  history.replaceState(null, '', url.toString())
}

/**
 * Reflect modal-open state in the URL via `?dashboard=open`. Any legacy
 * `?view=dashboard` is stripped at the same time so the URL converges
 * on the new canonical form.
 */
export function syncDashboardModalToUrl(open: boolean): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return
  const url = new URL(location.href)
  // Drop legacy marker regardless of new state.
  if (url.searchParams.get('view') === 'dashboard') {
    url.searchParams.set('view', 'workspace')
  }
  if (open) url.searchParams.set('dashboard', 'open')
  else url.searchParams.delete('dashboard')
  history.replaceState(null, '', url.toString())
}

export function setActiveView(view: NavView): void {
  _setActiveView(view)
  syncViewToUrl(view)
}

/**
 * Open / close / toggle the dashboard modal.
 *
 * These do NOT touch `activeView`. The underlying view (and its workspace +
 * thread params) is preserved while the modal floats on top — so dismissing
 * the modal returns the user exactly where they were.
 */
export function openDashboardModal(): void {
  _setDashboardModalOpen(true)
  syncDashboardModalToUrl(true)
}
export function closeDashboardModal(): void {
  _setDashboardModalOpen(false)
  syncDashboardModalToUrl(false)
}
export function toggleDashboardModal(): void {
  if (dashboardModalOpen()) closeDashboardModal()
  else openDashboardModal()
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
  | 'flow'
export const [activeSystemTab, setActiveSystemTab] = createSignal<SystemTabId>('overview')

let popstateHandler: (() => void) | null = null

export function initNavStore(): () => void {
  _setViewMode(readViewModeFromUrl())
  _setActiveView(readNavViewFromUrl())
  _setDashboardModalOpen(readDashboardModalFromUrl())
  // If we landed on the legacy `?view=dashboard` URL, normalise it
  // once so the canonical `?view=workspace&dashboard=open` survives
  // refresh.
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'dashboard') {
    syncDashboardModalToUrl(true)
  }
  popstateHandler = () => {
    _setViewMode(readViewModeFromUrl())
    _setActiveView(readNavViewFromUrl())
    _setDashboardModalOpen(readDashboardModalFromUrl())
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

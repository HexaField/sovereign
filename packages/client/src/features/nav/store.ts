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

const VIEW_STORAGE_KEY = 'sovereign:active-view'

function readNavViewFromStorage(): NavView {
  if (typeof localStorage === 'undefined') return 'dashboard'
  try {
    const val = localStorage.getItem(VIEW_STORAGE_KEY)
    const valid: NavView[] = ['dashboard', 'workspace', 'canvas', 'planning', 'system']
    if (val && valid.includes(val as NavView)) return val as NavView
  } catch {
    /* ignore */
  }
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
export const [activeView, _setActiveView] = createSignal<NavView>(readNavViewFromStorage())
export const [drawerOpen, _setDrawerOpen] = createSignal(false)
export const [settingsOpen, _setSettingsOpen] = createSignal(false)

export function setActiveView(view: NavView): void {
  _setActiveView(view)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, view)
    } catch {
      /* ignore */
    }
  }
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

let popstateHandler: (() => void) | null = null

export function initNavStore(): () => void {
  _setViewMode(readViewModeFromUrl())
  _setActiveView(readNavViewFromStorage())
  popstateHandler = () => _setViewMode(readViewModeFromUrl())
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

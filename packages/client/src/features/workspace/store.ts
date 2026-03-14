import { createSignal } from 'solid-js'

export interface WorkspaceContext {
  orgId: string
  orgName: string
  activeProjectId: string | null
  activeProjectName: string | null
}

// §3.3 — Sidebar tab types
export type SidebarTab =
  | 'files'
  | 'git'
  | 'threads'
  | 'planning'
  | 'notifications'
  | 'terminal'
  | 'recordings'
  | 'meetings'
  | 'logs'

export const SIDEBAR_TABS: { key: SidebarTab; label: string; iconKey: string }[] = [
  { key: 'files', label: 'Files', iconKey: 'files' },
  { key: 'git', label: 'Git', iconKey: 'git' },
  { key: 'threads', label: 'Threads', iconKey: 'threads' },
  { key: 'planning', label: 'Planning', iconKey: 'planning' },
  { key: 'notifications', label: 'Notifications', iconKey: 'notifications' },
  { key: 'terminal', label: 'Terminal', iconKey: 'terminal' },
  { key: 'recordings', label: 'Recordings', iconKey: 'recordings' },
  { key: 'meetings', label: 'Meetings', iconKey: 'meetings' },
  { key: 'logs', label: 'Logs', iconKey: 'logs' }
]

// §3.3 — Active sidebar tab
export const [activeSidebarTab, setActiveSidebarTab] = createSignal<SidebarTab>('files')

// §7.3 — Mobile workspace tab types
export type MobileTab =
  | 'files'
  | 'file-viewer'
  | 'chat'
  | 'git'
  | 'threads'
  | 'planning'
  | 'notifications'
  | 'terminal'
  | 'recordings'
  | 'meetings'
  | 'logs'

export const MOBILE_TAB_ORDER: { key: MobileTab; label: string }[] = [
  { key: 'files', label: 'Files' },
  { key: 'file-viewer', label: 'File Viewer' },
  { key: 'chat', label: 'Chat' },
  { key: 'git', label: 'Git' },
  { key: 'threads', label: 'Threads' },
  { key: 'planning', label: 'Planning' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'recordings', label: 'Recordings' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'logs', label: 'Logs' }
]

const MOBILE_TAB_KEY = 'sovereign:mobile-tab'

function loadMobileTab(): MobileTab {
  if (typeof localStorage === 'undefined') return 'files'
  try {
    const val = localStorage.getItem(MOBILE_TAB_KEY)
    if (val && MOBILE_TAB_ORDER.some((t) => t.key === val)) return val as MobileTab
  } catch {
    /* ignore */
  }
  return 'files'
}

export const [activeMobileTab, _setActiveMobileTab] = createSignal<MobileTab>(loadMobileTab())

export function setActiveMobileTab(tab: MobileTab): void {
  _setActiveMobileTab(tab)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(MOBILE_TAB_KEY, tab)
    } catch {
      /* ignore */
    }
  }
}

/** Swipe to next/previous mobile tab. Returns the new tab key. */
export function swipeMobileTab(direction: 'left' | 'right'): MobileTab {
  const current = activeMobileTab()
  const idx = MOBILE_TAB_ORDER.findIndex((t) => t.key === current)
  const next = direction === 'left' ? Math.min(idx + 1, MOBILE_TAB_ORDER.length - 1) : Math.max(idx - 1, 0)
  const tab = MOBILE_TAB_ORDER[next].key
  setActiveMobileTab(tab)
  return tab
}

/** Check if viewport is mobile width */
export function isMobileWidth(): boolean {
  if (typeof window === 'undefined') return false
  return window.innerWidth < 768
}

// §3.2 — Expand chat mode
export const [chatExpanded, setChatExpanded] = createSignal(false)

export function toggleChatExpanded(): void {
  setChatExpanded(!chatExpanded())
}

// §3.5 — Chat panel width
export const CHAT_PANEL_DEFAULT_WIDTH = 360
export const CHAT_PANEL_MIN_WIDTH = 280
export const CHAT_PANEL_MAX_WIDTH = 600
export const [chatPanelWidth, setChatPanelWidth] = createSignal(CHAT_PANEL_DEFAULT_WIDTH)

// §3.5 — Active thread key for right panel
export const [activeThreadKey, setActiveThreadKey] = createSignal('main')

// §3.1 — Sidebar collapsed state
export const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false)

export function toggleSidebar(): void {
  setSidebarCollapsed(!sidebarCollapsed())
}

const STORAGE_KEY = 'sovereign:active-workspace'

function loadFromStorage(): WorkspaceContext | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore */
  }
  return null
}

function saveToStorage(ctx: WorkspaceContext | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (ctx) localStorage.setItem(STORAGE_KEY, JSON.stringify(ctx))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

const initial = loadFromStorage() || {
  orgId: '_global',
  orgName: 'Global',
  activeProjectId: null,
  activeProjectName: null
}

export const [activeWorkspace, _setActiveWorkspace] = createSignal<WorkspaceContext | null>(initial)

export function setActiveWorkspace(orgId: string, orgName?: string): void {
  const ctx: WorkspaceContext = {
    orgId,
    orgName: orgName || orgId,
    activeProjectId: null,
    activeProjectName: null
  }
  _setActiveWorkspace(ctx)
  saveToStorage(ctx)
}

export function setActiveProject(projectId: string, projectName?: string): void {
  const current = activeWorkspace()
  if (!current) return
  const ctx: WorkspaceContext = {
    ...current,
    activeProjectId: projectId,
    activeProjectName: projectName || projectId
  }
  _setActiveWorkspace(ctx)
  saveToStorage(ctx)
}

/** @internal — for testing */
export function _resetWorkspaceStore(): void {
  _setActiveWorkspace(null)
  _setActiveMobileTab('files')
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(MOBILE_TAB_KEY)
    } catch {
      /* ignore */
    }
  }
}

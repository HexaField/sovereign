import { createSignal } from 'solid-js'
import { switchWorkspaceThreads } from '../threads/store.js'

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
  | 'planning'
  | 'notifications'
  | 'terminal'
  | 'recordings'
  | 'meetings'
  | 'logs'

export const SIDEBAR_TABS: { key: SidebarTab; label: string; iconKey: string }[] = [
  { key: 'files', label: 'Files', iconKey: 'files' },
  { key: 'git', label: 'Git', iconKey: 'git' },
  { key: 'planning', label: 'Planning', iconKey: 'planning' },
  { key: 'notifications', label: 'Notifications', iconKey: 'notifications' },
  { key: 'terminal', label: 'Terminal', iconKey: 'terminal' },
  { key: 'recordings', label: 'Recordings', iconKey: 'recordings' },
  { key: 'meetings', label: 'Meetings', iconKey: 'meetings' },
  { key: 'logs', label: 'Logs', iconKey: 'logs' }
]

// --- Per-workspace persisted signal helper ---

function wsKey(orgId: string, name: string): string {
  return `sovereign:workspace:${orgId}:${name}`
}

function readStorage<T>(key: string, fallback: T, parse: (v: string) => T = JSON.parse): T {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const v = localStorage.getItem(key)
    if (v !== null) return parse(v)
  } catch {
    /* ignore */
  }
  return fallback
}

function writeStorage(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/** Get the current orgId for keying. Called lazily so it works during init. */
function currentOrgId(): string {
  const ws = activeWorkspace()
  return ws?.orgId ?? '_global'
}

// §3.3 — Active sidebar tab
export const [activeSidebarTab, _setActiveSidebarTab] = createSignal<SidebarTab>('files')

export function setActiveSidebarTab(tab: SidebarTab): void {
  _setActiveSidebarTab(tab)
  writeStorage(wsKey(currentOrgId(), 'activeSidebarTab'), tab)
}

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
export const [chatExpanded, _setChatExpanded] = createSignal(false)

export function setChatExpanded(v: boolean): void {
  _setChatExpanded(v)
  writeStorage(wsKey(currentOrgId(), 'chatExpanded'), v)
}

export function toggleChatExpanded(): void {
  setChatExpanded(!chatExpanded())
}

// §3.5 — Chat panel width
export const CHAT_PANEL_DEFAULT_WIDTH = 360
export const CHAT_PANEL_MIN_WIDTH = 280
export const CHAT_PANEL_MAX_WIDTH = 600
export const [chatPanelWidth, _setChatPanelWidth] = createSignal(CHAT_PANEL_DEFAULT_WIDTH)

export function setChatPanelWidth(v: number): void {
  _setChatPanelWidth(v)
  writeStorage(wsKey(currentOrgId(), 'chatPanelWidth'), v)
}

// §3.5 — Active thread key for right panel
export const [activeThreadKey, setActiveThreadKey] = createSignal('main')

// §3.6 — Open file tabs in main content
export interface OpenFileTab {
  id: string
  path: string
  projectId: string
  label: string
}

export const [openFileTabs, setOpenFileTabs] = createSignal<OpenFileTab[]>([])
export const [activeFileTabId, setActiveFileTabId] = createSignal<string | null>(null)

export function openFileTab(path: string, projectId: string): void {
  const id = `file:${projectId}:${path}`
  const label = path.split('/').pop() ?? path
  setOpenFileTabs((prev) => {
    if (prev.some((t) => t.id === id)) return prev
    return [...prev, { id, path, projectId, label }]
  })
  setActiveFileTabId(id)
}

export function closeFileTab(id: string): void {
  setOpenFileTabs((prev) => {
    const next = prev.filter((t) => t.id !== id)
    if (activeFileTabId() === id) {
      setActiveFileTabId(next.length > 0 ? next[next.length - 1].id : null)
    }
    return next
  })
}

// §3.1 — Sidebar width and collapsed state
export const SIDEBAR_DEFAULT_WIDTH = 260
export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 400
export const SIDEBAR_SNAP_THRESHOLD = 100

export const CHAT_SNAP_THRESHOLD = 140

export const [sidebarCollapsed, _setSidebarCollapsed] = createSignal(false)
export const [chatCollapsed, _setChatCollapsed] = createSignal(false)
export const [sidebarWidth, _setSidebarWidth] = createSignal(SIDEBAR_DEFAULT_WIDTH)

export function setSidebarWidth(v: number): void {
  _setSidebarWidth(v)
  writeStorage(wsKey(currentOrgId(), 'sidebarWidth'), v)
}

export function setSidebarCollapsed(v: boolean): void {
  _setSidebarCollapsed(v)
  writeStorage(wsKey(currentOrgId(), 'sidebarCollapsed'), v)
}

export function setChatCollapsed(v: boolean): void {
  _setChatCollapsed(v)
  writeStorage(wsKey(currentOrgId(), 'chatCollapsed'), v)
}

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

// Restore panel state for the initially loaded workspace
restoreWorkspacePanelState(initial.orgId)

export function setActiveWorkspace(orgId: string, orgName?: string): void {
  const ctx: WorkspaceContext = {
    orgId,
    orgName: orgName || orgId,
    activeProjectId: null,
    activeProjectName: null
  }
  _setActiveWorkspace(ctx)
  saveToStorage(ctx)
  restoreWorkspacePanelState(orgId)
  switchWorkspaceThreads(orgId)
}

/** Restore all per-workspace panel state from localStorage */
function restoreWorkspacePanelState(orgId: string): void {
  _setSidebarWidth(readStorage(wsKey(orgId, 'sidebarWidth'), SIDEBAR_DEFAULT_WIDTH))
  _setChatPanelWidth(readStorage(wsKey(orgId, 'chatPanelWidth'), CHAT_PANEL_DEFAULT_WIDTH))
  _setSidebarCollapsed(readStorage(wsKey(orgId, 'sidebarCollapsed'), false))
  _setChatCollapsed(readStorage(wsKey(orgId, 'chatCollapsed'), false))
  _setChatExpanded(readStorage(wsKey(orgId, 'chatExpanded'), false))
  const tab = readStorage<string>(wsKey(orgId, 'activeSidebarTab'), 'files', (v) => v)
  if (SIDEBAR_TABS.some((t) => t.key === tab)) {
    _setActiveSidebarTab(tab as SidebarTab)
  }
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

/**
 * Auto-select the first project if none is selected.
 * Call this once on app init (e.g. in App.tsx onMount).
 */
export async function autoSelectProject(): Promise<void> {
  const ws = activeWorkspace()
  if (!ws || ws.activeProjectId) return // already selected

  try {
    const res = await fetch(`/api/orgs/${encodeURIComponent(ws.orgId)}/projects`)
    if (!res.ok) return
    const projects: Array<{ id: string; name: string }> = await res.json()
    if (projects.length > 0) {
      setActiveProject(projects[0].id, projects[0].name)
    }
  } catch {
    /* ignore */
  }
}

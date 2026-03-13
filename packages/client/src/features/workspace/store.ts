import { createSignal } from 'solid-js'

export interface WorkspaceContext {
  orgId: string
  orgName: string
  activeProjectId: string | null
  activeProjectName: string | null
}

// §3.3 — Sidebar tab types
export type SidebarTab = 'files' | 'git' | 'threads' | 'planning' | 'notifications' | 'terminal' | 'recordings' | 'logs'

export const SIDEBAR_TABS: { key: SidebarTab; label: string; icon: string }[] = [
  { key: 'files', label: 'Files', icon: '📄' },
  { key: 'git', label: 'Git', icon: '🔀' },
  { key: 'threads', label: 'Threads', icon: '💬' },
  { key: 'planning', label: 'Planning', icon: '📊' },
  { key: 'notifications', label: 'Notifications', icon: '🔔' },
  { key: 'terminal', label: 'Terminal', icon: '⬛' },
  { key: 'recordings', label: 'Recordings', icon: '🎙️' },
  { key: 'logs', label: 'Logs', icon: '📋' }
]

// §3.3 — Active sidebar tab
export const [activeSidebarTab, setActiveSidebarTab] = createSignal<SidebarTab>('files')

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
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }
}

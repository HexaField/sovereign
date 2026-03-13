import { createSignal } from 'solid-js'

export interface WorkspaceContext {
  orgId: string
  orgName: string
  activeProjectId: string | null
  activeProjectName: string | null
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

import { createSignal } from 'solid-js'

export interface WorkspaceContext {
  orgId: string
  orgName: string
  activeProjectId: string | null
  activeProjectName: string | null
}

export const [activeWorkspace, setActiveWorkspaceSignal] = createSignal<WorkspaceContext | null>(null)

export function setActiveWorkspace(_orgId: string): void {}
export function setActiveProject(_projectId: string): void {}

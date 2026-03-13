import { describe, it } from 'vitest'

describe('Workspace Store', () => {
  describe('§0.2 — Active Workspace Store', () => {
    it.todo('§0.2 — exposes activeWorkspace(): WorkspaceContext | null')
    it.todo('§0.2 — exposes setActiveWorkspace(orgId: string): void')
    it.todo('§0.2 — exposes setActiveProject(projectId: string): void')
    it.todo('§0.2 — persists last active workspace to localStorage under key sovereign:active-workspace')
    it.todo('§0.2 — restores last active workspace on init')
    it.todo('§0.2 — defaults to _global if no workspace previously selected')
    it.todo('§0.2 — emits workspace.switched event on bus when workspace changes')
    it.todo('§0.2 — WorkspaceContext has orgId, orgName, activeProjectId, activeProjectName')
  })
})

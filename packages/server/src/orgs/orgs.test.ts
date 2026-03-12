import { describe, it } from 'vitest'

describe('Org Manager', () => {
  // Org CRUD
  it.todo('creates an org with id, name, path, timestamps')
  it.todo('updates an org')
  it.todo('deletes an org')
  it.todo('gets an org by id')
  it.todo('lists all orgs')
  it.todo('rejects creating org with non-existent path')

  // Project CRUD
  it.todo('adds a project to an org')
  it.todo('validates project repoPath exists and is a git repo')
  it.todo('rejects project with non-git directory')
  it.todo('rejects project if repoPath already belongs to another org')
  it.todo('updates a project')
  it.todo('removes a project from an org')
  it.todo('gets a project by id')
  it.todo('lists all projects for an org')

  // Persistence
  it.todo('persists orgs to disk on create')
  it.todo('persists orgs to disk on update')
  it.todo('persists orgs to disk on delete')
  it.todo('recovers orgs and projects from disk on startup')

  // Events
  it.todo('emits org.created on the bus')
  it.todo('emits org.updated on the bus')
  it.todo('emits org.deleted on the bus')
  it.todo('emits project.created on the bus')
  it.todo('emits project.updated on the bus')
  it.todo('emits project.deleted on the bus')

  // Monorepo detection
  it.todo('detects pnpm workspace monorepo')
  it.todo('detects npm workspaces monorepo')
  it.todo('detects nx monorepo')
  it.todo('detects turborepo monorepo')
  it.todo('returns undefined monorepo for non-monorepo project')

  // Active context
  it.todo('sets and gets active org')
  it.todo('sets and gets active project')
  it.todo('emits org.active.changed on active org change')
  it.todo('emits project.active.changed on active project change')

  // Config
  it.todo('reads per-org config')
  it.todo('updates per-org config')
  it.todo('hot-reloads per-org config without restart')

  // Constraints
  it.todo('does not create or modify files inside user git repos')
})

describe('Org Manager Routes', () => {
  it.todo('GET /api/orgs returns org list')
  it.todo('POST /api/orgs creates an org')
  it.todo('GET /api/orgs/:orgId returns an org')
  it.todo('PUT /api/orgs/:orgId updates an org')
  it.todo('DELETE /api/orgs/:orgId deletes an org')
  it.todo('GET /api/orgs/:orgId/projects returns project list')
  it.todo('POST /api/orgs/:orgId/projects adds a project')
  it.todo('GET /api/orgs/:orgId/projects/:projectId returns a project')
  it.todo('PUT /api/orgs/:orgId/projects/:projectId updates a project')
  it.todo('DELETE /api/orgs/:orgId/projects/:projectId removes a project')
  it.todo('all routes reject unauthenticated requests with 401')
})

describe('Monorepo Detection', () => {
  it.todo('detects pnpm-workspace.yaml')
  it.todo('detects package.json workspaces field')
  it.todo('detects nx.json')
  it.todo('detects turbo.json')
  it.todo('returns null for non-monorepo')
  it.todo('lists workspace packages for pnpm workspace')
})

describe('Org Store', () => {
  it.todo('reads orgs from disk')
  it.todo('writes orgs to disk atomically')
  it.todo('creates data directory if it does not exist')
})

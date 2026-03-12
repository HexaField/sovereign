import { describe, it } from 'vitest'

describe('Worktree Manager', () => {
  // Creation
  it.todo('creates a worktree via git worktree add')
  it.todo('creates worktree in configurable location')
  it.todo('runs package manager install after worktree creation')
  it.todo('rejects worktree creation on default branch')
  it.todo('assigns a base branch to the worktree')

  // Listing & retrieval
  it.todo('lists all worktrees for a project')
  it.todo('gets a worktree by id')
  it.todo('includes branch, path, creation time, assigned agent, and status')

  // Removal
  it.todo('removes a worktree via git worktree remove')
  it.todo('prunes branch if merged when pruneBranch option is set')

  // Assignment
  it.todo('assigns an agent to a worktree')
  it.todo('unassigns an agent from a worktree')

  // Persistence
  it.todo('persists worktree metadata to disk')
  it.todo('recovers worktree metadata from disk on startup')

  // Events
  it.todo('emits worktree.created on the bus')
  it.todo('emits worktree.removed on the bus')
  it.todo('emits worktree.assigned on the bus')
  it.todo('emits worktree.merged on the bus')
  it.todo('emits worktree.stale on the bus for stale worktrees')

  // Stale detection
  it.todo('detects stale worktrees with no commits for configurable period')

  // Cleanup
  it.todo('cleans up merged worktree branches')

  // Constraints
  it.todo('does not modify the main branch working tree')
})

describe('Worktree Git Wrapper', () => {
  it.todo('executes git worktree add')
  it.todo('executes git worktree remove')
  it.todo('executes git worktree list')
  it.todo('detects if branch is merged into default')
  it.todo('deletes a branch after merge')
})

describe('Worktree Links', () => {
  it.todo('creates a linked worktree set across projects')
  it.todo('persists links to worktree-links.json')
  it.todo('lists links for an org')
  it.todo('gets a link by id')
  it.todo('removes a link')
  it.todo('validates all referenced worktree ids exist')
})

describe('Worktree Store', () => {
  it.todo('reads worktrees from disk')
  it.todo('writes worktrees to disk atomically')
  it.todo('creates data directory if it does not exist')
})

describe('Worktree Routes', () => {
  it.todo('GET /api/orgs/:orgId/projects/:projectId/worktrees returns list')
  it.todo('POST /api/orgs/:orgId/projects/:projectId/worktrees creates worktree')
  it.todo('DELETE /api/orgs/:orgId/projects/:projectId/worktrees/:worktreeId removes worktree')
  it.todo('POST /api/orgs/:orgId/worktree-links creates a link')
  it.todo('all routes reject unauthenticated requests with 401')
})

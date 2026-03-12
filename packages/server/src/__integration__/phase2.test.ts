import { describe, it } from 'vitest'

describe('Phase 2 Integration: Org → Project → Worktree → Files → Git', () => {
  it.todo('creates org, adds project, creates worktree, reads files, makes git commit')
  it.todo('worktree creation emits event that status aggregator reflects')
  it.todo('cross-project worktree link: create linked worktrees across two projects in same org')
  it.todo('file API rejects path traversal outside project repo')
  it.todo('git push to protected branch is rejected')
  it.todo('terminal session starts in correct worktree cwd')
  it.todo('auth middleware protects all Phase 2 API endpoints')
  it.todo('org deletion cascades: removes projects and worktree metadata')
  it.todo('notification generated from worktree.stale event')
  it.todo('active org/project change updates status bar via bus events')
})

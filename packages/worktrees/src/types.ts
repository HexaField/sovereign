export interface Worktree {
  id: string
  projectId: string
  orgId: string
  branch: string
  path: string
  baseBranch: string
  assignedAgent?: string
  linkId?: string
  status: 'active' | 'merged' | 'stale'
  createdAt: string
  lastCommitAt?: string
}

export interface WorktreeLink {
  id: string
  orgId: string
  name: string
  description?: string
  worktreeIds: string[]
  createdAt: string
}

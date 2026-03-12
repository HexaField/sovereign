import type { EventBus } from '@template/core'
import type { GitCli } from './git.js'
import type { GitStatus, CommitInfo } from './types.js'

export interface ProjectResolution {
  repoPath: string
  defaultBranch: string
}

export type ResolveProject = (orgId: string, projectId: string, worktreeId?: string) => ProjectResolution

export interface GitService {
  status(orgId: string, projectId: string, worktreeId?: string): Promise<GitStatus>
  stage(orgId: string, projectId: string, paths: string[], worktreeId?: string): Promise<void>
  unstage(orgId: string, projectId: string, paths: string[], worktreeId?: string): Promise<void>
  commit(orgId: string, projectId: string, message: string, worktreeId?: string): Promise<CommitInfo>
  push(orgId: string, projectId: string, worktreeId?: string): Promise<void>
  pull(orgId: string, projectId: string, worktreeId?: string): Promise<void>
  branches(orgId: string, projectId: string): Promise<string[]>
  checkout(orgId: string, projectId: string, branch: string, create?: boolean): Promise<void>
  log(orgId: string, projectId: string, limit?: number, worktreeId?: string): Promise<CommitInfo[]>
  diff(orgId: string, projectId: string, path: string, worktreeId?: string): Promise<string>
}

export function createGitService(bus: EventBus, gitCli: GitCli, resolveProject: ResolveProject): GitService {
  function resolve(orgId: string, projectId: string, worktreeId?: string): ProjectResolution {
    return resolveProject(orgId, projectId, worktreeId)
  }

  function emitEvent(type: string, payload: unknown): void {
    bus.emit({
      type,
      timestamp: new Date().toISOString(),
      source: 'git',
      payload
    })
  }

  return {
    async status(orgId, projectId, worktreeId?) {
      const { repoPath } = resolve(orgId, projectId, worktreeId)
      return gitCli.status(repoPath)
    },

    async stage(orgId, projectId, paths, worktreeId?) {
      const { repoPath } = resolve(orgId, projectId, worktreeId)
      await gitCli.stage(repoPath, paths)
    },

    async unstage(orgId, projectId, paths, worktreeId?) {
      const { repoPath } = resolve(orgId, projectId, worktreeId)
      await gitCli.unstage(repoPath, paths)
    },

    async commit(orgId, projectId, message, worktreeId?) {
      if (!message || message.trim() === '') {
        throw new Error('Commit message must not be empty')
      }
      const { repoPath } = resolve(orgId, projectId, worktreeId)
      const info = await gitCli.commit(repoPath, message)
      emitEvent('git.commit', { orgId, projectId, worktreeId, commit: info })
      return info
    },

    async push(orgId, projectId, worktreeId?) {
      const { repoPath, defaultBranch } = resolve(orgId, projectId, worktreeId)
      const status = await gitCli.status(repoPath)
      if (status.branch === defaultBranch) {
        throw new Error(`Push to protected branch '${defaultBranch}' is not allowed`)
      }
      await gitCli.push(repoPath)
      emitEvent('git.push', { orgId, projectId, worktreeId, branch: status.branch })
    },

    async pull(orgId, projectId, worktreeId?) {
      const { repoPath } = resolve(orgId, projectId, worktreeId)
      await gitCli.pull(repoPath)
      emitEvent('git.pull', { orgId, projectId, worktreeId })
    },

    async branches(orgId, projectId) {
      const { repoPath } = resolve(orgId, projectId)
      return gitCli.branches(repoPath)
    },

    async checkout(orgId, projectId, branch, create?) {
      const { repoPath } = resolve(orgId, projectId)
      await gitCli.checkout(repoPath, branch, create)
      if (create) {
        emitEvent('git.branch.created', { orgId, projectId, branch })
      }
      emitEvent('git.branch.switched', { orgId, projectId, branch })
    },

    async log(orgId, projectId, limit?, worktreeId?) {
      const { repoPath } = resolve(orgId, projectId, worktreeId)
      return gitCli.log(repoPath, limit)
    },

    async diff(orgId, projectId, filePath, worktreeId?) {
      const { repoPath } = resolve(orgId, projectId, worktreeId)
      return gitCli.diff(repoPath, filePath)
    }
  }
}

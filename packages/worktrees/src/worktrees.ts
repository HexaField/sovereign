import crypto from 'node:crypto'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { Worktree, WorktreeLink } from './types.js'
import { createWorktreeStore, type WorktreeStore } from './store.js'
import { createLinkManager, type LinkManager } from './links.js'
import * as gitOps from './git.js'

export interface WorktreeManagerOpts {
  runInstall?: (worktreePath: string) => Promise<void>
  getProject?: (orgId: string, projectId: string) => { repoPath: string; defaultBranch: string } | undefined
}

export interface WorktreeManager {
  create(orgId: string, projectId: string, data: { branch: string; baseBranch?: string }): Promise<Worktree>
  remove(orgId: string, projectId: string, worktreeId: string, opts?: { pruneBranch?: boolean }): Promise<void>
  list(orgId: string, projectId: string): Worktree[]
  get(orgId: string, projectId: string, worktreeId: string): Worktree | undefined
  assign(orgId: string, projectId: string, worktreeId: string, agentId: string): Worktree
  unassign(orgId: string, projectId: string, worktreeId: string): Worktree
  createLink(orgId: string, data: { name: string; description?: string; worktreeIds: string[] }): WorktreeLink
  getLink(orgId: string, linkId: string): WorktreeLink | undefined
  listLinks(orgId: string): WorktreeLink[]
  removeLink(orgId: string, linkId: string): void
  detectStale(orgId: string, projectId: string, maxAgeDays?: number): Worktree[]
  cleanupMerged(orgId: string, projectId: string): Promise<string[]>
}

export function createWorktreeManager(bus: EventBus, dataDir: string, opts: WorktreeManagerOpts = {}): WorktreeManager {
  const store: WorktreeStore = createWorktreeStore(dataDir)

  const now = () => new Date().toISOString()
  const id = () => crypto.randomUUID()
  const emit = (type: string, payload: unknown) => {
    bus.emit({ type, timestamp: now(), source: 'worktrees', payload })
  }

  const resolveWorktree = (wId: string): boolean => {
    // Search all orgs/projects — simplified: check all known worktrees
    // In practice we'd need to iterate, but for link validation we check broadly
    // This is a simplification; the store would need to enumerate
    return allWorktrees.has(wId)
  }

  // In-memory index of all worktree IDs for link validation
  const allWorktrees = new Set<string>()

  const linkManager: LinkManager = createLinkManager(bus, store, resolveWorktree)

  const requireProject = (orgId: string, projectId: string) => {
    if (!opts.getProject) throw new Error('getProject not configured')
    const project = opts.getProject(orgId, projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return project
  }

  const loadWorktrees = (orgId: string, projectId: string): Worktree[] => {
    const wts = store.readWorktrees(orgId, projectId)
    for (const wt of wts) allWorktrees.add(wt.id)
    return wts
  }

  const saveWorktrees = (orgId: string, projectId: string, worktrees: Worktree[]) => {
    store.writeWorktrees(orgId, projectId, worktrees)
  }

  return {
    async create(orgId, projectId, data) {
      const project = requireProject(orgId, projectId)
      if (data.branch === project.defaultBranch) {
        throw new Error(`Cannot create worktree on default branch: ${project.defaultBranch}`)
      }
      const baseBranch = data.baseBranch || project.defaultBranch
      const worktreePath = path.join(project.repoPath, '.worktrees', data.branch)

      await gitOps.worktreeAdd(project.repoPath, worktreePath, data.branch, baseBranch)

      if (opts.runInstall) await opts.runInstall(worktreePath)

      const wt: Worktree = {
        id: id(),
        projectId,
        orgId,
        branch: data.branch,
        path: worktreePath,
        baseBranch,
        status: 'active',
        createdAt: now()
      }

      const worktrees = loadWorktrees(orgId, projectId)
      worktrees.push(wt)
      saveWorktrees(orgId, projectId, worktrees)
      allWorktrees.add(wt.id)

      emit('worktree.created', wt)
      return wt
    },

    async remove(orgId, projectId, worktreeId, removeOpts) {
      const project = requireProject(orgId, projectId)
      const worktrees = loadWorktrees(orgId, projectId)
      const idx = worktrees.findIndex((w) => w.id === worktreeId)
      if (idx === -1) throw new Error(`Worktree not found: ${worktreeId}`)
      const wt = worktrees[idx]

      await gitOps.worktreeRemove(project.repoPath, wt.path)

      if (removeOpts?.pruneBranch) {
        const merged = await gitOps.isBranchMerged(project.repoPath, wt.branch, project.defaultBranch)
        if (merged) {
          await gitOps.deleteBranch(project.repoPath, wt.branch)
          emit('worktree.merged', wt)
        }
      }

      worktrees.splice(idx, 1)
      saveWorktrees(orgId, projectId, worktrees)
      allWorktrees.delete(wt.id)

      emit('worktree.removed', wt)
    },

    list(orgId, projectId) {
      return loadWorktrees(orgId, projectId)
    },

    get(orgId, projectId, worktreeId) {
      return loadWorktrees(orgId, projectId).find((w) => w.id === worktreeId)
    },

    assign(orgId, projectId, worktreeId, agentId) {
      const worktrees = loadWorktrees(orgId, projectId)
      const wt = worktrees.find((w) => w.id === worktreeId)
      if (!wt) throw new Error(`Worktree not found: ${worktreeId}`)
      wt.assignedAgent = agentId
      saveWorktrees(orgId, projectId, worktrees)
      emit('worktree.assigned', { ...wt, agentId })
      return wt
    },

    unassign(orgId, projectId, worktreeId) {
      const worktrees = loadWorktrees(orgId, projectId)
      const wt = worktrees.find((w) => w.id === worktreeId)
      if (!wt) throw new Error(`Worktree not found: ${worktreeId}`)
      delete wt.assignedAgent
      saveWorktrees(orgId, projectId, worktrees)
      emit('worktree.unassigned', wt)
      return wt
    },

    createLink: (orgId, data) => linkManager.createLink(orgId, data),
    getLink: (orgId, linkId) => linkManager.getLink(orgId, linkId),
    listLinks: (orgId) => linkManager.listLinks(orgId),
    removeLink: (orgId, linkId) => linkManager.removeLink(orgId, linkId),

    detectStale(orgId, projectId, maxAgeDays = 14) {
      const worktrees = loadWorktrees(orgId, projectId)
      const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000)
      const stale = worktrees.filter((wt) => {
        if (wt.status !== 'active') return false
        const lastCommit = wt.lastCommitAt ? new Date(wt.lastCommitAt) : new Date(wt.createdAt)
        return lastCommit < cutoff
      })
      for (const wt of stale) {
        wt.status = 'stale'
        emit('worktree.stale', wt)
      }
      if (stale.length > 0) saveWorktrees(orgId, projectId, worktrees)
      return stale
    },

    async cleanupMerged(orgId, projectId) {
      const project = requireProject(orgId, projectId)
      const worktrees = loadWorktrees(orgId, projectId)
      const removed: string[] = []
      for (const wt of [...worktrees]) {
        const merged = await gitOps.isBranchMerged(project.repoPath, wt.branch, project.defaultBranch)
        if (merged) {
          try {
            await gitOps.worktreeRemove(project.repoPath, wt.path)
          } catch {
            /* already removed */
          }
          try {
            await gitOps.deleteBranch(project.repoPath, wt.branch)
          } catch {
            /* already deleted */
          }
          const idx = worktrees.findIndex((w) => w.id === wt.id)
          if (idx !== -1) worktrees.splice(idx, 1)
          removed.push(wt.id)
          emit('worktree.removed', wt)
        }
      }
      saveWorktrees(orgId, projectId, worktrees)
      return removed
    }
  }
}

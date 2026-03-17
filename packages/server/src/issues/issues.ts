// Core issue tracker — orchestrates providers + cache

import type { EventBus } from '@sovereign/core'
import type { Issue, IssueComment, IssueFilter, IssueProvider, IssueTracker, Remote } from './types.js'
import { createIssueCache, type IssueCache } from './cache.js'
import { createGitHubIssueProvider } from './github.js'
import { createRadicleIssueProvider } from './radicle.js'

export type GetRemotes = (orgId: string, projectId: string) => Remote[]

export interface IssueTrackerDeps {
  createProvider?: (remote: Remote, orgId: string, projectId: string) => IssueProvider
  cache?: IssueCache
}

export function createIssueTracker(
  bus: EventBus,
  dataDir: string,
  getRemotes: GetRemotes,
  deps?: IssueTrackerDeps
): IssueTracker {
  const cache = deps?.cache ?? createIssueCache(dataDir)

  function makeProvider(remote: Remote, orgId: string, projectId: string): IssueProvider {
    if (deps?.createProvider) return deps.createProvider(remote, orgId, projectId)
    if (remote.provider === 'github') {
      return createGitHubIssueProvider({ repo: remote.repo!, remote: remote.name, orgId, projectId })
    }
    return createRadicleIssueProvider({ rid: remote.rid!, remote: remote.name, orgId, projectId })
  }

  function repoPath(remote: Remote): string {
    return remote.repo ?? remote.rid ?? ''
  }

  // Listen for config changes
  bus.on('config.changed', () => {
    // Providers are created per-call, so config changes are picked up automatically
  })

  const tracker: IssueTracker = {
    async list(orgId: string, filter?: IssueFilter): Promise<Issue[]> {
      // If projectId is specified, get remotes for that project; otherwise we'd need all projects
      // For simplicity, if no projectId, we still need remotes — caller should provide via filter
      const projectId = filter?.projectId ?? ''
      const remotes = getRemotes(orgId, projectId)
      const filteredRemotes = filter?.remote ? remotes.filter((r) => r.name === filter.remote) : remotes

      let allIssues: Issue[] = []

      for (const remote of filteredRemotes) {
        const pid = projectId || remote.projectId || remote.name
        try {
          const provider = makeProvider(remote, orgId, pid)
          const issues = await provider.list(repoPath(remote), filter)
          allIssues.push(...issues)
          cache.setCached(orgId, pid, issues)
        } catch {
          // Provider unreachable — serve from cache
          const cached = cache.getCached(orgId, pid)
          if (cached) allIssues.push(...cached)
        }
      }

      // Apply local filters that providers might not support
      if (filter?.q) {
        const q = filter.q.toLowerCase()
        allIssues = allIssues.filter((i) => i.title.toLowerCase().includes(q) || i.body.toLowerCase().includes(q))
      }

      // Pagination
      const offset = filter?.offset ?? 0
      const limit = filter?.limit ?? allIssues.length
      allIssues = allIssues.slice(offset, offset + limit)

      return allIssues
    },

    async get(orgId: string, projectId: string, issueId: string): Promise<Issue | undefined> {
      // Try cache first
      const cached = cache.getCached(orgId, projectId)
      const fromCache = cached?.find((i) => i.id === issueId)

      const remotes = getRemotes(orgId, projectId)
      for (const remote of remotes) {
        try {
          const provider = makeProvider(remote, orgId, projectId)
          const issue = await provider.get(repoPath(remote), issueId)
          if (issue) return issue
        } catch {
          // Provider unreachable
        }
      }

      return fromCache
    },

    async create(
      orgId: string,
      projectId: string,
      data: { remote: string; title: string; body?: string; labels?: string[]; assignees?: string[] }
    ): Promise<Issue> {
      const remotes = getRemotes(orgId, projectId)
      const remote = remotes.find((r) => r.name === data.remote) ?? remotes[0]
      if (!remote) throw new Error(`No remote found: ${data.remote}`)

      try {
        const provider = makeProvider(remote, orgId, projectId)
        const issue = await provider.create(repoPath(remote), data)
        // Update cache
        const existing = cache.getCached(orgId, projectId) ?? []
        cache.setCached(orgId, projectId, [...existing, issue])
        bus.emit({ type: 'issue.created', timestamp: new Date().toISOString(), source: 'issues', payload: issue })
        return issue
      } catch (err) {
        // Offline — queue write
        cache.queueWrite({
          type: 'create',
          orgId,
          projectId,
          remote: remote.name,
          data: data as unknown as Record<string, unknown>
        })
        throw err
      }
    },

    async update(
      orgId: string,
      projectId: string,
      issueId: string,
      patch: { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[] }
    ): Promise<Issue> {
      const remotes = getRemotes(orgId, projectId)
      // Find remote that has this issue — try all
      for (const remote of remotes) {
        try {
          const provider = makeProvider(remote, orgId, projectId)
          const issue = await provider.update(repoPath(remote), issueId, patch)
          // Update cache
          const existing = cache.getCached(orgId, projectId) ?? []
          const idx = existing.findIndex((i) => i.id === issueId)
          if (idx >= 0) existing[idx] = issue
          else existing.push(issue)
          cache.setCached(orgId, projectId, existing)
          bus.emit({ type: 'issue.updated', timestamp: new Date().toISOString(), source: 'issues', payload: issue })
          return issue
        } catch {
          continue
        }
      }
      // All providers failed — queue
      cache.queueWrite({
        type: 'update',
        orgId,
        projectId,
        remote: remotes[0]?.name ?? '',
        data: { issueId, ...patch }
      })
      throw new Error('All providers unreachable')
    },

    async listComments(orgId: string, projectId: string, issueId: string): Promise<IssueComment[]> {
      const remotes = getRemotes(orgId, projectId)
      for (const remote of remotes) {
        try {
          const provider = makeProvider(remote, orgId, projectId)
          return await provider.listComments(repoPath(remote), issueId)
        } catch {
          continue
        }
      }
      return []
    },

    async addComment(orgId: string, projectId: string, issueId: string, body: string): Promise<IssueComment> {
      const remotes = getRemotes(orgId, projectId)
      for (const remote of remotes) {
        try {
          const provider = makeProvider(remote, orgId, projectId)
          const comment = await provider.addComment(repoPath(remote), issueId, body)
          bus.emit({
            type: 'issue.comment.added',
            timestamp: new Date().toISOString(),
            source: 'issues',
            payload: { issueId, comment }
          })
          return comment
        } catch {
          continue
        }
      }
      cache.queueWrite({ type: 'comment', orgId, projectId, remote: remotes[0]?.name ?? '', data: { issueId, body } })
      throw new Error('All providers unreachable')
    },

    async sync(orgId: string, projectId: string): Promise<{ synced: number; errors: number }> {
      const remotes = getRemotes(orgId, projectId)
      let synced = 0
      let errors = 0

      for (const remote of remotes) {
        try {
          const provider = makeProvider(remote, orgId, projectId)
          const issues = await provider.list(repoPath(remote))
          cache.setCached(orgId, projectId, issues)
          synced += issues.length
        } catch {
          errors++
        }
      }

      bus.emit({
        type: 'issue.synced',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: { orgId, projectId, synced, errors }
      })
      return { synced, errors }
    },

    async flushQueue(): Promise<{ replayed: number; failed: number }> {
      const queue = cache.getQueue()
      let replayed = 0
      let failed = 0

      for (const op of queue) {
        try {
          const data = op.data
          switch (op.type) {
            case 'create':
              await tracker.create(op.orgId, op.projectId, {
                remote: op.remote,
                title: data.title as string,
                body: data.body as string,
                labels: data.labels as string[],
                assignees: data.assignees as string[]
              })
              break
            case 'update':
              await tracker.update(op.orgId, op.projectId, data.issueId as string, data)
              break
            case 'comment':
              await tracker.addComment(op.orgId, op.projectId, data.issueId as string, data.body as string)
              break
          }
          cache.removeFromQueue(op.id)
          replayed++
        } catch {
          failed++
        }
      }

      return { replayed, failed }
    }
  }

  return tracker
}

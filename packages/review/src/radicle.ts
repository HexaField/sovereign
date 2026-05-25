// Radicle review provider (rad patch CLI wrapper)

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Review, ReviewComment, ReviewProvider } from './types.js'

const execFileAsync = promisify(execFile)

export interface RadicleReviewProviderConfig {
  rid: string
  remote: string
  orgId: string
  projectId: string
  repoPath?: string
  execFn?: typeof execFileAsync
}

export function createRadicleReviewProvider(config: RadicleReviewProviderConfig): ReviewProvider {
  const exec = config.execFn ?? execFileAsync

  async function rad(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await exec('rad', args, { cwd: cwd ?? config.repoPath })
    return stdout
  }

  function mapReview(raw: Record<string, unknown>): Review {
    const state = String(raw.state ?? 'open').toLowerCase()
    let status: Review['status'] = 'open'
    if (state === 'merged') status = 'merged'
    else if (state === 'closed' || state === 'archived') status = 'closed'
    else if (state === 'accepted') status = 'approved'

    return {
      id: String(raw.id ?? ''),
      changeSetId: '',
      projectId: config.projectId,
      orgId: config.orgId,
      remote: config.remote,
      provider: 'radicle',
      title: String(raw.title ?? ''),
      description: String(raw.description ?? raw.body ?? ''),
      status,
      author:
        typeof raw.author === 'object' && raw.author
          ? String((raw.author as Record<string, unknown>).id ?? (raw.author as Record<string, unknown>).alias ?? '')
          : String(raw.author ?? ''),
      reviewers: Array.isArray(raw.reviewers) ? (raw.reviewers as string[]) : [],
      baseBranch: String(raw.target ?? raw.baseBranch ?? 'main'),
      headBranch: String(raw.head ?? raw.headBranch ?? ''),
      createdAt: String(raw.createdAt ?? raw.timestamp ?? ''),
      updatedAt: String(raw.updatedAt ?? raw.timestamp ?? ''),
      mergedAt: raw.mergedAt ? String(raw.mergedAt) : undefined,
      providerUrl: raw.url ? String(raw.url) : undefined,
      providerMeta: raw
    }
  }

  function mapComment(raw: Record<string, unknown>, reviewId: string): ReviewComment {
    return {
      id: String(raw.id ?? ''),
      reviewId,
      filePath: String(raw.path ?? raw.location ?? ''),
      lineNumber: Number(raw.line ?? raw.lineNumber ?? 0),
      endLineNumber: raw.endLine ? Number(raw.endLine) : undefined,
      side: raw.side === 'old' ? 'old' : 'new',
      body: String(raw.body ?? raw.comment ?? ''),
      author:
        typeof raw.author === 'object' && raw.author
          ? String((raw.author as Record<string, unknown>).id ?? (raw.author as Record<string, unknown>).alias ?? '')
          : String(raw.author ?? ''),
      createdAt: String(raw.createdAt ?? raw.timestamp ?? ''),
      resolved: raw.resolved === true,
      replyTo: raw.replyTo ? String(raw.replyTo) : undefined,
      providerCommentId: String(raw.id ?? '')
    }
  }

  return {
    async create(_repoPath: string, data): Promise<Review> {
      const args = ['patch', 'create', '--repository', config.rid, '--title', data.title, '--target', data.baseBranch]
      if (data.body) args.push('--description', data.body)
      const output = await rad(args, _repoPath || undefined)
      // rad patch create outputs the patch ID
      const id = output.trim().split(/\s+/)[0] || output.trim()
      // Try to fetch full patch
      const patch = await this.get(_repoPath, id)
      return (
        patch ?? {
          id,
          changeSetId: '',
          projectId: config.projectId,
          orgId: config.orgId,
          remote: config.remote,
          provider: 'radicle',
          title: data.title,
          description: data.body ?? '',
          status: 'open',
          author: '',
          reviewers: [],
          baseBranch: data.baseBranch,
          headBranch: data.headBranch,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      )
    },

    async list(_repoPath: string, filter?): Promise<Review[]> {
      const args = ['patch', 'list', '--repository', config.rid]
      if (filter?.status) args.push('--state', filter.status)
      const output = await rad(args, _repoPath || undefined)
      try {
        const items = JSON.parse(output) as Array<Record<string, unknown>>
        return items.map((r) => mapReview(r))
      } catch {
        // Parse text output
        const items: Review[] = []
        for (const line of output.trim().split('\n')) {
          if (!line.trim()) continue
          const parts = line.split(/\s+/)
          if (parts.length >= 2) {
            items.push(mapReview({ id: parts[0], title: parts.slice(1).join(' ') }))
          }
        }
        return items
      }
    },

    async get(_repoPath: string, reviewId: string): Promise<Review | undefined> {
      try {
        const output = await rad(['patch', 'show', reviewId, '--repository', config.rid], _repoPath || undefined)
        return mapReview(JSON.parse(output))
      } catch {
        return undefined
      }
    },

    async approve(_repoPath: string, reviewId: string, body?: string): Promise<void> {
      const args = ['patch', 'review', reviewId, '--accept', '--repository', config.rid]
      if (body) args.push('--message', body)
      await rad(args, _repoPath || undefined)
    },

    async requestChanges(_repoPath: string, reviewId: string, body: string): Promise<void> {
      await rad(
        ['patch', 'review', reviewId, '--reject', '--message', body, '--repository', config.rid],
        _repoPath || undefined
      )
    },

    async merge(_repoPath: string, reviewId: string): Promise<void> {
      await rad(['patch', 'merge', reviewId, '--repository', config.rid], _repoPath || undefined)
    },

    async addComment(_repoPath: string, reviewId: string, comment): Promise<ReviewComment> {
      await rad(
        ['patch', 'comment', reviewId, '--message', comment.body, '--repository', config.rid],
        _repoPath || undefined
      )
      const comments = await this.listComments(_repoPath, reviewId)
      return comments[comments.length - 1]
    },

    async listComments(_repoPath: string, reviewId: string): Promise<ReviewComment[]> {
      try {
        const output = await rad(['patch', 'show', reviewId, '--repository', config.rid], _repoPath || undefined)
        const raw = JSON.parse(output) as Record<string, unknown>
        const discussion = Array.isArray(raw.discussion) ? (raw.discussion as Array<Record<string, unknown>>) : []
        return discussion.map((c) => mapComment(c, reviewId))
      } catch {
        return []
      }
    },

    async resolveComment(_repoPath: string, _reviewId: string, _commentId: string): Promise<void> {
      // Radicle doesn't natively support comment resolution
      // No-op — resolution tracked locally only
    }
  }
}

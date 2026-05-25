// GitHub review provider (gh pr CLI wrapper)

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Review, ReviewComment, ReviewProvider } from './types.js'

const execFileAsync = promisify(execFile)

export interface GitHubReviewProviderConfig {
  repo: string
  remote: string
  orgId: string
  projectId: string
  execFn?: typeof execFileAsync
}

export function createGitHubReviewProvider(config: GitHubReviewProviderConfig): ReviewProvider {
  const exec = config.execFn ?? execFileAsync

  async function gh(args: string[]): Promise<string> {
    const { stdout } = await exec('gh', args)
    return stdout
  }

  function mapReview(raw: Record<string, unknown>): Review {
    const state = String(raw.state ?? 'OPEN').toUpperCase()
    let status: Review['status'] = 'open'
    if (state === 'MERGED') status = 'merged'
    else if (state === 'CLOSED') status = 'closed'
    else if (raw.reviewDecision === 'APPROVED') status = 'approved'
    else if (raw.reviewDecision === 'CHANGES_REQUESTED') status = 'changes_requested'

    return {
      id: String(raw.number ?? ''),
      changeSetId: '',
      projectId: config.projectId,
      orgId: config.orgId,
      remote: config.remote,
      provider: 'github',
      title: String(raw.title ?? ''),
      description: String(raw.body ?? ''),
      status,
      author:
        typeof raw.author === 'object' && raw.author
          ? String((raw.author as Record<string, unknown>).login ?? '')
          : String(raw.author ?? ''),
      reviewers: Array.isArray(raw.reviewRequests)
        ? (raw.reviewRequests as Array<Record<string, unknown>>).map((r) =>
            String((r as Record<string, unknown>).login ?? (r as Record<string, unknown>).name ?? '')
          )
        : [],
      baseBranch: String(raw.baseRefName ?? ''),
      headBranch: String(raw.headRefName ?? ''),
      createdAt: String(raw.createdAt ?? ''),
      updatedAt: String(raw.updatedAt ?? ''),
      mergedAt: raw.mergedAt ? String(raw.mergedAt) : undefined,
      providerUrl: String(raw.url ?? ''),
      providerMeta: raw
    }
  }

  function mapComment(raw: Record<string, unknown>, reviewId: string): ReviewComment {
    return {
      id: String(raw.id ?? ''),
      reviewId,
      filePath: String(raw.path ?? ''),
      lineNumber: Number(raw.line ?? raw.position ?? 0),
      endLineNumber: raw.endLine ? Number(raw.endLine) : undefined,
      side: raw.side === 'LEFT' ? 'old' : 'new',
      body: String(raw.body ?? ''),
      author:
        typeof raw.author === 'object' && raw.author
          ? String((raw.author as Record<string, unknown>).login ?? '')
          : String(raw.author ?? ''),
      createdAt: String(raw.createdAt ?? ''),
      resolved: raw.isResolved === true || raw.resolved === true,
      replyTo: raw.replyTo ? String(raw.replyTo) : undefined,
      providerCommentId: String(raw.id ?? '')
    }
  }

  const PR_JSON_FIELDS =
    'number,title,body,state,author,reviewDecision,reviewRequests,baseRefName,headRefName,createdAt,updatedAt,mergedAt,url'

  return {
    async create(_repoPath: string, data): Promise<Review> {
      const args = [
        'pr',
        'create',
        '-R',
        config.repo,
        '--title',
        data.title,
        '--base',
        data.baseBranch,
        '--head',
        data.headBranch,
        '--json',
        PR_JSON_FIELDS
      ]
      if (data.body) args.push('--body', data.body)
      const output = await gh(args)
      return mapReview(JSON.parse(output))
    },

    async list(_repoPath: string, filter?): Promise<Review[]> {
      const args = ['pr', 'list', '-R', config.repo, '--json', PR_JSON_FIELDS]
      if (filter?.status) {
        const stateMap: Record<string, string> = { open: 'open', merged: 'merged', closed: 'closed' }
        args.push('--state', stateMap[filter.status] ?? 'all')
      }
      const output = await gh(args)
      return (JSON.parse(output) as Array<Record<string, unknown>>).map((r) => mapReview(r))
    },

    async get(_repoPath: string, reviewId: string): Promise<Review | undefined> {
      try {
        const output = await gh(['pr', 'view', reviewId, '-R', config.repo, '--json', PR_JSON_FIELDS])
        return mapReview(JSON.parse(output))
      } catch {
        return undefined
      }
    },

    async approve(_repoPath: string, reviewId: string, body?: string): Promise<void> {
      const args = ['pr', 'review', reviewId, '-R', config.repo, '--approve']
      if (body) args.push('--body', body)
      await gh(args)
    },

    async requestChanges(_repoPath: string, reviewId: string, body: string): Promise<void> {
      await gh(['pr', 'review', reviewId, '-R', config.repo, '--request-changes', '--body', body])
    },

    async merge(_repoPath: string, reviewId: string): Promise<void> {
      await gh(['pr', 'merge', reviewId, '-R', config.repo, '--merge'])
    },

    async addComment(_repoPath: string, reviewId: string, comment): Promise<ReviewComment> {
      // gh api for inline comments
      const args = [
        'pr',
        'comment',
        reviewId,
        '-R',
        config.repo,
        '--body',
        `**${comment.filePath}:${comment.lineNumber}** (${comment.side})\n\n${comment.body}`
      ]
      await gh(args)
      // Fetch latest comments to return the new one
      const comments = await this.listComments(_repoPath, reviewId)
      return comments[comments.length - 1]
    },

    async listComments(_repoPath: string, reviewId: string): Promise<ReviewComment[]> {
      const output = await gh(['pr', 'view', reviewId, '-R', config.repo, '--json', 'comments,reviewComments'])
      const raw = JSON.parse(output) as Record<string, unknown>
      const comments = [
        ...(Array.isArray(raw.comments) ? (raw.comments as Array<Record<string, unknown>>) : []),
        ...(Array.isArray(raw.reviewComments) ? (raw.reviewComments as Array<Record<string, unknown>>) : [])
      ]
      return comments.map((c) => mapComment(c, reviewId))
    },

    async resolveComment(_repoPath: string, _reviewId: string, commentId: string): Promise<void> {
      // GitHub uses GraphQL to resolve review threads; approximate via gh api
      await gh([
        'api',
        'graphql',
        '-f',
        `query=mutation { minimizeComment(input: { subjectId: "${commentId}", classifier: RESOLVED }) { minimizedComment { isMinimized } } }`
      ])
    }
  }
}

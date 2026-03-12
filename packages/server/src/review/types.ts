// Review System — Types

import type { ChangeSet } from '../diff/types.js'

export interface Review {
  id: string
  changeSetId: string
  projectId: string
  orgId: string
  remote: string
  provider: 'github' | 'radicle'
  title: string
  description: string
  status: 'open' | 'approved' | 'changes_requested' | 'merged' | 'closed'
  author: string
  reviewers: string[]
  baseBranch: string
  headBranch: string
  createdAt: string
  updatedAt: string
  mergedAt?: string
  providerUrl?: string
  providerMeta?: Record<string, unknown>
}

export interface ReviewComment {
  id: string
  reviewId: string
  filePath: string
  lineNumber: number
  endLineNumber?: number
  side: 'old' | 'new'
  body: string
  author: string
  createdAt: string
  resolved: boolean
  replyTo?: string
  providerCommentId?: string
}

export interface ReviewProvider {
  create(
    repoPath: string,
    data: { title: string; body?: string; baseBranch: string; headBranch: string }
  ): Promise<Review>
  list(repoPath: string, filter?: { status?: string }): Promise<Review[]>
  get(repoPath: string, reviewId: string): Promise<Review | undefined>
  approve(repoPath: string, reviewId: string, body?: string): Promise<void>
  requestChanges(repoPath: string, reviewId: string, body: string): Promise<void>
  merge(repoPath: string, reviewId: string): Promise<void>
  addComment(
    repoPath: string,
    reviewId: string,
    comment: { filePath: string; lineNumber: number; body: string; side: 'old' | 'new' }
  ): Promise<ReviewComment>
  listComments(repoPath: string, reviewId: string): Promise<ReviewComment[]>
  resolveComment(repoPath: string, reviewId: string, commentId: string): Promise<void>
}

export interface ReviewDeps {
  removeWorktree: (worktreeId: string) => Promise<void>
  getChangeSet: (id: string) => ChangeSet | undefined
  updateChangeSet: (id: string, patch: Partial<ChangeSet>) => ChangeSet
  getProvider: (orgId: string, projectId: string) => ReviewProvider
}

export interface ReviewSystem {
  create(
    orgId: string,
    projectId: string,
    data: {
      remote: string
      worktreeId?: string
      title: string
      description?: string
      baseBranch: string
      headBranch: string
      reviewers?: string[]
    }
  ): Promise<Review>
  get(orgId: string, projectId: string, reviewId: string): Promise<Review | undefined>
  list(orgId: string, filter?: { projectId?: string; status?: string }): Promise<Review[]>
  addComment(
    orgId: string,
    projectId: string,
    reviewId: string,
    comment: {
      filePath: string
      lineNumber: number
      endLineNumber?: number
      side: 'old' | 'new'
      body: string
      replyTo?: string
    }
  ): Promise<ReviewComment>
  listComments(orgId: string, projectId: string, reviewId: string): Promise<ReviewComment[]>
  resolveComment(orgId: string, projectId: string, reviewId: string, commentId: string): Promise<void>
  approve(orgId: string, projectId: string, reviewId: string, body?: string): Promise<Review>
  requestChanges(orgId: string, projectId: string, reviewId: string, body: string): Promise<Review>
  merge(orgId: string, projectId: string, reviewId: string): Promise<Review>
  sync(orgId: string, projectId: string): Promise<{ synced: number; errors: number }>
}

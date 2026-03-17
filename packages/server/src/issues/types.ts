// Issue Tracker — Types

export interface Issue {
  id: string
  kind: 'issue' | 'pr'
  projectId: string
  orgId: string
  remote: string
  provider: 'github' | 'radicle'
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  author: string
  createdAt: string
  updatedAt: string
  commentCount: number
  providerUrl?: string
  providerMeta?: Record<string, unknown>
}

export interface IssueComment {
  id: string
  issueId: string
  author: string
  body: string
  createdAt: string
  updatedAt?: string
}

export interface IssueFilter {
  projectId?: string
  remote?: string
  state?: 'open' | 'closed'
  label?: string
  assignee?: string
  q?: string
  limit?: number
  offset?: number
}

export interface IssueProvider {
  list(repoPath: string, filter?: IssueFilter): Promise<Issue[]>
  get(repoPath: string, issueId: string): Promise<Issue | undefined>
  create(
    repoPath: string,
    data: { title: string; body?: string; labels?: string[]; assignees?: string[] }
  ): Promise<Issue>
  update(
    repoPath: string,
    issueId: string,
    patch: { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[] }
  ): Promise<Issue>
  listComments(repoPath: string, issueId: string): Promise<IssueComment[]>
  addComment(repoPath: string, issueId: string, body: string): Promise<IssueComment>
}

export interface Remote {
  name: string
  provider: 'github' | 'radicle'
  repo?: string
  rid?: string
  projectId?: string
}

export interface IssueTracker {
  list(orgId: string, filter?: IssueFilter): Promise<Issue[]>
  get(orgId: string, projectId: string, issueId: string): Promise<Issue | undefined>
  create(
    orgId: string,
    projectId: string,
    data: { remote: string; title: string; body?: string; labels?: string[]; assignees?: string[] }
  ): Promise<Issue>
  update(
    orgId: string,
    projectId: string,
    issueId: string,
    patch: { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[] }
  ): Promise<Issue>
  listComments(orgId: string, projectId: string, issueId: string): Promise<IssueComment[]>
  addComment(orgId: string, projectId: string, issueId: string, body: string): Promise<IssueComment>
  sync(orgId: string, projectId: string): Promise<{ synced: number; errors: number }>
  flushQueue(): Promise<{ replayed: number; failed: number }>
}

export interface QueuedOperation {
  id: string
  type: 'create' | 'update' | 'comment'
  orgId: string
  projectId: string
  remote: string
  data: Record<string, unknown>
  timestamp: string
}

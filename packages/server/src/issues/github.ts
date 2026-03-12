// GitHub issue provider (gh CLI wrapper)

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Issue, IssueComment, IssueFilter, IssueProvider } from './types.js'

const execFileAsync = promisify(execFile)

export interface GitHubProviderConfig {
  repo: string
  remote: string
  orgId: string
  projectId: string
  execFn?: typeof execFileAsync
}

export function createGitHubIssueProvider(config: GitHubProviderConfig): IssueProvider {
  const exec = config.execFn ?? execFileAsync

  async function gh(args: string[]): Promise<string> {
    const { stdout } = await exec('gh', args)
    return stdout
  }

  function mapIssue(raw: Record<string, unknown>): Issue {
    return {
      id: String(raw.number),
      projectId: config.projectId,
      orgId: config.orgId,
      remote: config.remote,
      provider: 'github',
      title: String(raw.title ?? ''),
      body: String(raw.body ?? ''),
      state: raw.state === 'CLOSED' ? 'closed' : 'open',
      labels: Array.isArray(raw.labels)
        ? (raw.labels as Array<{ name: string }>).map((l) => (typeof l === 'string' ? l : l.name))
        : [],
      assignees: Array.isArray(raw.assignees)
        ? (raw.assignees as Array<{ login: string }>).map((a) => (typeof a === 'string' ? a : a.login))
        : [],
      author:
        typeof raw.author === 'object' && raw.author
          ? String((raw.author as Record<string, unknown>).login ?? '')
          : String(raw.author ?? ''),
      createdAt: String(raw.createdAt ?? ''),
      updatedAt: String(raw.updatedAt ?? ''),
      commentCount: Number((raw.comments as any)?.length ?? raw.commentCount ?? 0),
      providerUrl: String(raw.url ?? ''),
      providerMeta: raw as Record<string, unknown>
    }
  }

  function mapComment(raw: Record<string, unknown>, issueId: string): IssueComment {
    return {
      id: String(raw.id ?? ''),
      issueId,
      author:
        typeof raw.author === 'object' && raw.author
          ? String((raw.author as Record<string, unknown>).login ?? '')
          : String(raw.author ?? ''),
      body: String(raw.body ?? ''),
      createdAt: String(raw.createdAt ?? ''),
      updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined
    }
  }

  return {
    async list(_repoPath: string, filter?: IssueFilter): Promise<Issue[]> {
      const args = [
        'issue',
        'list',
        '-R',
        config.repo,
        '--json',
        'number,title,body,state,labels,assignees,author,createdAt,updatedAt,url,comments'
      ]
      if (filter?.state) args.push('--state', filter.state === 'closed' ? 'closed' : 'open')
      if (filter?.label) args.push('--label', filter.label)
      if (filter?.assignee) args.push('--assignee', filter.assignee)
      if (filter?.q) args.push('--search', filter.q)
      if (filter?.limit) args.push('--limit', String(filter.limit))

      const output = await gh(args)
      const items = JSON.parse(output) as Array<Record<string, unknown>>
      return items.map((i) => mapIssue(i))
    },

    async get(_repoPath: string, issueId: string): Promise<Issue | undefined> {
      try {
        const output = await gh([
          'issue',
          'view',
          issueId,
          '-R',
          config.repo,
          '--json',
          'number,title,body,state,labels,assignees,author,createdAt,updatedAt,url,comments'
        ])
        const raw = JSON.parse(output) as Record<string, unknown>
        return mapIssue(raw)
      } catch {
        return undefined
      }
    },

    async create(
      _repoPath: string,
      data: { title: string; body?: string; labels?: string[]; assignees?: string[] }
    ): Promise<Issue> {
      const args = ['issue', 'create', '-R', config.repo, '--title', data.title]
      if (data.body) args.push('--body', data.body)
      if (data.labels?.length) args.push('--label', data.labels.join(','))
      if (data.assignees?.length) args.push('--assignee', data.assignees.join(','))
      args.push('--json', 'number,title,body,state,labels,assignees,author,createdAt,updatedAt,url')

      const output = await gh(args)
      const raw = JSON.parse(output) as Record<string, unknown>
      return mapIssue(raw)
    },

    async update(
      _repoPath: string,
      issueId: string,
      patch: { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[] }
    ): Promise<Issue> {
      const args = ['issue', 'edit', issueId, '-R', config.repo]
      if (patch.title) args.push('--title', patch.title)
      if (patch.body) args.push('--body', patch.body)
      if (patch.labels) args.push('--add-label', patch.labels.join(','))
      if (patch.assignees) args.push('--add-assignee', patch.assignees.join(','))

      await gh(args)

      // Close/reopen if state changed
      if (patch.state === 'closed') {
        await gh(['issue', 'close', issueId, '-R', config.repo])
      } else if (patch.state === 'open') {
        await gh(['issue', 'reopen', issueId, '-R', config.repo])
      }

      // Fetch updated issue
      return (await this.get(_repoPath, issueId))!
    },

    async listComments(_repoPath: string, issueId: string): Promise<IssueComment[]> {
      const output = await gh(['issue', 'view', issueId, '-R', config.repo, '--json', 'comments'])
      const raw = JSON.parse(output) as { comments: Array<Record<string, unknown>> }
      return (raw.comments ?? []).map((c) => mapComment(c, issueId))
    },

    async addComment(_repoPath: string, issueId: string, body: string): Promise<IssueComment> {
      await gh(['issue', 'comment', issueId, '-R', config.repo, '--body', body])
      // gh issue comment doesn't return JSON, so fetch the latest comment
      const comments = await this.listComments(_repoPath, issueId)
      return comments[comments.length - 1]
    }
  }
}

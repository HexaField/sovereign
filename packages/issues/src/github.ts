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

  function mapIssue(raw: Record<string, unknown>, kind: 'issue' | 'pr' = 'issue'): Issue {
    return {
      id: String(raw.number),
      kind,
      projectId: config.projectId,
      orgId: config.orgId,
      remote: config.remote,
      provider: 'github',
      title: String(raw.title ?? ''),
      body: String(raw.body ?? ''),
      state: raw.state === 'CLOSED' || raw.state === 'MERGED' ? 'closed' : 'open',
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
      // Fetch issues
      const issueArgs = [
        'issue',
        'list',
        '-R',
        config.repo,
        '--json',
        'number,title,body,state,labels,assignees,author,createdAt,updatedAt,url,comments'
      ]
      if (filter?.state) issueArgs.push('--state', filter.state === 'closed' ? 'closed' : 'open')
      if (filter?.label) issueArgs.push('--label', filter.label)
      if (filter?.assignee) issueArgs.push('--assignee', filter.assignee)
      if (filter?.q) issueArgs.push('--search', filter.q)
      if (filter?.limit) issueArgs.push('--limit', String(filter.limit))

      const issueOutput = await gh(issueArgs)
      const issues = (JSON.parse(issueOutput) as Array<Record<string, unknown>>).map((i) => mapIssue(i, 'issue'))

      // Fetch PRs
      const prArgs = [
        'pr',
        'list',
        '-R',
        config.repo,
        '--json',
        'number,title,body,state,labels,assignees,author,createdAt,updatedAt,url,comments'
      ]
      if (filter?.state) prArgs.push('--state', filter.state === 'closed' ? 'closed' : 'open')
      if (filter?.label) prArgs.push('--label', filter.label)
      if (filter?.assignee) prArgs.push('--assignee', filter.assignee)
      if (filter?.q) prArgs.push('--search', filter.q)
      if (filter?.limit) prArgs.push('--limit', String(filter.limit))

      const prOutput = await gh(prArgs)
      const prs = (JSON.parse(prOutput) as Array<Record<string, unknown>>).map((i) => mapIssue(i, 'pr'))

      return [...issues, ...prs]
    },

    async get(_repoPath: string, issueId: string): Promise<Issue | undefined> {
      const fields = 'number,title,body,state,labels,assignees,author,createdAt,updatedAt,url,comments'
      // Try as issue first
      try {
        const output = await gh(['issue', 'view', issueId, '-R', config.repo, '--json', fields])
        const raw = JSON.parse(output) as Record<string, unknown>
        return mapIssue(raw, 'issue')
      } catch {
        // Fall through to try as PR
      }
      // Try as PR
      try {
        const output = await gh(['pr', 'view', issueId, '-R', config.repo, '--json', fields])
        const raw = JSON.parse(output) as Record<string, unknown>
        return mapIssue(raw, 'pr')
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
      return mapIssue(raw, 'issue')
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

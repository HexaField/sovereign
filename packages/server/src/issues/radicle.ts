// Radicle issue provider (rad issue CLI wrapper)

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Issue, IssueComment, IssueFilter, IssueProvider } from './types.js'

const execFileAsync = promisify(execFile)

export interface RadicleProviderConfig {
  rid: string
  remote: string
  orgId: string
  projectId: string
  repoPath?: string
  execFn?: typeof execFileAsync
}

export function createRadicleIssueProvider(config: RadicleProviderConfig): IssueProvider {
  const exec = config.execFn ?? execFileAsync

  async function rad(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await exec('rad', args, { cwd: cwd ?? config.repoPath })
    return stdout
  }

  function parseIssueList(output: string): Array<Record<string, string>> {
    // rad issue list outputs JSON when --format json or structured text
    // Try JSON first
    try {
      return JSON.parse(output)
    } catch {
      // Parse text output: each line is "id title state"
      const items: Array<Record<string, string>> = []
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue
        const parts = line.split(/\s+/)
        if (parts.length >= 2) {
          items.push({ id: parts[0], title: parts.slice(1).join(' ') })
        }
      }
      return items
    }
  }

  function mapIssue(raw: Record<string, unknown>): Issue {
    return {
      id: String(raw.id ?? ''),
      projectId: config.projectId,
      orgId: config.orgId,
      remote: config.remote,
      provider: 'radicle',
      title: String(raw.title ?? ''),
      body: String(raw.description ?? raw.body ?? ''),
      state: String(raw.state ?? 'open') === 'closed' ? 'closed' : 'open',
      labels: Array.isArray(raw.labels) ? (raw.labels as string[]) : [],
      assignees: Array.isArray(raw.assignees) ? (raw.assignees as string[]) : [],
      author:
        typeof raw.author === 'object' && raw.author
          ? String((raw.author as Record<string, unknown>).id ?? (raw.author as Record<string, unknown>).alias ?? '')
          : String(raw.author ?? ''),
      createdAt: String(raw.createdAt ?? raw.timestamp ?? ''),
      updatedAt: String(raw.updatedAt ?? raw.timestamp ?? ''),
      commentCount: Array.isArray(raw.discussion)
        ? (raw.discussion as unknown[]).length
        : Number(raw.commentCount ?? 0),
      providerUrl: raw.url ? String(raw.url) : undefined,
      providerMeta: raw as Record<string, unknown>
    }
  }

  function mapComment(raw: Record<string, unknown>, issueId: string): IssueComment {
    return {
      id: String(raw.id ?? ''),
      issueId,
      author:
        typeof raw.author === 'object' && raw.author
          ? String((raw.author as Record<string, unknown>).id ?? (raw.author as Record<string, unknown>).alias ?? '')
          : String(raw.author ?? ''),
      body: String(raw.body ?? raw.comment ?? ''),
      createdAt: String(raw.createdAt ?? raw.timestamp ?? ''),
      updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined
    }
  }

  return {
    async list(_repoPath: string, filter?: IssueFilter): Promise<Issue[]> {
      const args = ['issue', 'list', '--repository', config.rid]
      if (filter?.state) args.push('--state', filter.state)

      const output = await rad(args, _repoPath || undefined)
      const items = parseIssueList(output)
      let issues = items.map((i) => mapIssue(i))

      if (filter?.label) {
        issues = issues.filter((i) => i.labels.includes(filter.label!))
      }
      if (filter?.assignee) {
        issues = issues.filter((i) => i.assignees.includes(filter.assignee!))
      }
      if (filter?.q) {
        const q = filter.q.toLowerCase()
        issues = issues.filter((i) => i.title.toLowerCase().includes(q) || i.body.toLowerCase().includes(q))
      }

      return issues
    },

    async get(_repoPath: string, issueId: string): Promise<Issue | undefined> {
      try {
        const output = await rad(['issue', 'show', issueId, '--repository', config.rid], _repoPath || undefined)
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
      const args = ['issue', 'open', '--repository', config.rid, '--title', data.title]
      if (data.body) args.push('--description', data.body)
      if (data.labels?.length) {
        for (const l of data.labels) args.push('--label', l)
      }
      if (data.assignees?.length) {
        for (const a of data.assignees) args.push('--assign', a)
      }

      const output = await rad(args, _repoPath || undefined)
      // rad issue open typically outputs the issue ID
      const id = output.trim().split(/\s+/)[0] || output.trim()

      // Fetch the created issue
      const issue = await this.get(_repoPath, id)
      return (
        issue ?? {
          id,
          projectId: config.projectId,
          orgId: config.orgId,
          remote: config.remote,
          provider: 'radicle',
          title: data.title,
          body: data.body ?? '',
          state: 'open',
          labels: data.labels ?? [],
          assignees: data.assignees ?? [],
          author: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          commentCount: 0
        }
      )
    },

    async update(
      _repoPath: string,
      issueId: string,
      patch: { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[] }
    ): Promise<Issue> {
      if (patch.state === 'closed') {
        await rad(['issue', 'state', issueId, '--repository', config.rid, '--closed'], _repoPath || undefined)
      } else if (patch.state === 'open') {
        await rad(['issue', 'state', issueId, '--repository', config.rid, '--open'], _repoPath || undefined)
      }

      if (patch.labels?.length) {
        for (const l of patch.labels) {
          await rad(['issue', 'label', issueId, '--add', l, '--repository', config.rid], _repoPath || undefined)
        }
      }

      if (patch.assignees?.length) {
        for (const a of patch.assignees) {
          await rad(['issue', 'assign', issueId, '--add', a, '--repository', config.rid], _repoPath || undefined)
        }
      }

      const issue = await this.get(_repoPath, issueId)
      return issue!
    },

    async listComments(_repoPath: string, issueId: string): Promise<IssueComment[]> {
      try {
        const output = await rad(['issue', 'show', issueId, '--repository', config.rid], _repoPath || undefined)
        const raw = JSON.parse(output) as Record<string, unknown>
        const discussion = Array.isArray(raw.discussion) ? (raw.discussion as Array<Record<string, unknown>>) : []
        return discussion.map((c) => mapComment(c, issueId))
      } catch {
        return []
      }
    },

    async addComment(_repoPath: string, issueId: string, body: string): Promise<IssueComment> {
      await rad(['issue', 'comment', issueId, '--message', body, '--repository', config.rid], _repoPath || undefined)
      const comments = await this.listComments(_repoPath, issueId)
      return comments[comments.length - 1]
    }
  }
}

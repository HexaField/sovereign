import { describe, it, expect, vi } from 'vitest'
import { createGitHubIssueProvider } from './github.js'

function mockExec(responses: Record<string, string>) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = args.slice(0, 3).join(' ')
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern) || args.join(' ').includes(pattern)) {
        return { stdout: response, stderr: '' }
      }
    }
    throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`)
  }) as any
}

const sampleGhIssue = {
  number: 42,
  title: 'Fix bug',
  body: 'Description here',
  state: 'OPEN',
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'alice' }],
  author: { login: 'bob' },
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-02T00:00:00Z',
  url: 'https://github.com/owner/repo/issues/42',
  comments: []
}

const sampleComment = {
  id: 'IC_1',
  author: { login: 'alice' },
  body: 'Looks good',
  createdAt: '2024-01-03T00:00:00Z'
}

describe('GitHubIssueProvider', () => {
  describe('list', () => {
    it('lists issues via gh issue list', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([sampleGhIssue]), 'pr list': JSON.stringify([]) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issues = await provider.list('')
      expect(issues).toHaveLength(1)
      expect(execFn).toHaveBeenCalled()
    })

    it('includes PRs in list results', async () => {
      const samplePr = { ...sampleGhIssue, number: 99, title: 'Fix PR' }
      const execFn = mockExec({ 'issue list': JSON.stringify([sampleGhIssue]), 'pr list': JSON.stringify([samplePr]) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issues = await provider.list('')
      expect(issues).toHaveLength(2)
      expect(issues[0].kind).toBe('issue')
      expect(issues[1].kind).toBe('pr')
    })

    it('passes state filter to gh CLI', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([]), 'pr list': JSON.stringify([]) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.list('', { state: 'closed' })
      expect(execFn.mock.calls[0][1]).toContain('closed')
    })

    it('passes label filter to gh CLI', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([]), 'pr list': JSON.stringify([]) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.list('', { label: 'bug' })
      expect(execFn.mock.calls[0][1]).toContain('bug')
    })

    it('passes assignee filter to gh CLI', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([]), 'pr list': JSON.stringify([]) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.list('', { assignee: 'alice' })
      expect(execFn.mock.calls[0][1]).toContain('alice')
    })

    it('parses gh CLI JSON output into Issue objects', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([sampleGhIssue]), 'pr list': JSON.stringify([]) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issues = await provider.list('')
      expect(issues[0].id).toBe('42')
      expect(issues[0].title).toBe('Fix bug')
      expect(issues[0].kind).toBe('issue')
    })

    it('maps all unified issue model fields', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([sampleGhIssue]), 'pr list': JSON.stringify([]) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issues = await provider.list('')
      const issue = issues[0]
      expect(issue.provider).toBe('github')
      expect(issue.remote).toBe('origin')
      expect(issue.orgId).toBe('org1')
      expect(issue.projectId).toBe('proj1')
      expect(issue.state).toBe('open')
      expect(issue.labels).toEqual(['bug'])
      expect(issue.assignees).toEqual(['alice'])
      expect(issue.author).toBe('bob')
    })
  })

  describe('get', () => {
    it('gets issue by id via gh issue view', async () => {
      const execFn = mockExec({ 'issue view': JSON.stringify(sampleGhIssue) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.get('', '42')
      expect(issue).toBeDefined()
      expect(issue!.id).toBe('42')
    })

    it('returns undefined for non-existent issue', async () => {
      const execFn = vi.fn(async () => {
        throw new Error('not found')
      }) as any
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.get('', '999')
      expect(issue).toBeUndefined()
    })
  })

  describe('create', () => {
    it('creates issue via gh issue create', async () => {
      const created = { ...sampleGhIssue, number: 43, title: 'New issue' }
      const execFn = mockExec({ 'issue create': JSON.stringify(created) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.create('', { title: 'New issue', body: 'Body' })
      expect(issue.id).toBe('43')
      expect(issue.title).toBe('New issue')
    })

    it('passes title, body, labels, assignees to gh CLI', async () => {
      const execFn = mockExec({ 'issue create': JSON.stringify(sampleGhIssue) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.create('', { title: 'T', body: 'B', labels: ['bug'], assignees: ['alice'] })
      const args = execFn.mock.calls[0][1]
      expect(args).toContain('T')
      expect(args).toContain('B')
      expect(args).toContain('bug')
      expect(args).toContain('alice')
    })

    it('returns created Issue object', async () => {
      const execFn = mockExec({ 'issue create': JSON.stringify(sampleGhIssue) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.create('', { title: 'Fix bug' })
      expect(issue.provider).toBe('github')
      expect(issue.remote).toBe('origin')
    })
  })

  describe('update', () => {
    it('updates issue via gh issue edit', async () => {
      const execFn = mockExec({
        'issue edit': '',
        'issue view': JSON.stringify({ ...sampleGhIssue, title: 'Updated' })
      })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.update('', '42', { title: 'Updated' })
      expect(issue.title).toBe('Updated')
    })

    it('updates title', async () => {
      const execFn = mockExec({
        'issue edit': '',
        'issue view': JSON.stringify({ ...sampleGhIssue, title: 'New Title' })
      })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.update('', '42', { title: 'New Title' })
      expect(execFn.mock.calls[0][1]).toContain('New Title')
    })

    it('updates body', async () => {
      const execFn = mockExec({
        'issue edit': '',
        'issue view': JSON.stringify(sampleGhIssue)
      })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.update('', '42', { body: 'New body' })
      expect(execFn.mock.calls[0][1]).toContain('New body')
    })

    it('updates state (close/reopen)', async () => {
      const execFn = mockExec({
        'issue edit': '',
        'issue close': '',
        'issue view': JSON.stringify({ ...sampleGhIssue, state: 'CLOSED' })
      })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.update('', '42', { state: 'closed' })
      expect(issue.state).toBe('closed')
    })

    it('updates labels', async () => {
      const execFn = mockExec({
        'issue edit': '',
        'issue view': JSON.stringify(sampleGhIssue)
      })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.update('', '42', { labels: ['enhancement'] })
      expect(execFn.mock.calls[0][1]).toContain('enhancement')
    })

    it('updates assignees', async () => {
      const execFn = mockExec({
        'issue edit': '',
        'issue view': JSON.stringify(sampleGhIssue)
      })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.update('', '42', { assignees: ['charlie'] })
      expect(execFn.mock.calls[0][1]).toContain('charlie')
    })
  })

  describe('comments', () => {
    it('lists comments via gh CLI', async () => {
      const execFn = mockExec({ 'issue view': JSON.stringify({ comments: [sampleComment] }) })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const comments = await provider.listComments('', '42')
      expect(comments).toHaveLength(1)
      expect(comments[0].body).toBe('Looks good')
    })

    it('adds comment via gh issue comment', async () => {
      const execFn = mockExec({
        'issue comment': '',
        'issue view': JSON.stringify({
          comments: [
            sampleComment,
            { id: 'IC_2', author: { login: 'bob' }, body: 'New comment', createdAt: '2024-01-04T00:00:00Z' }
          ]
        })
      })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const comment = await provider.addComment('', '42', 'New comment')
      expect(comment.body).toBe('New comment')
    })

    it('returns IssueComment object', async () => {
      const execFn = mockExec({
        'issue comment': '',
        'issue view': JSON.stringify({ comments: [sampleComment] })
      })
      const provider = createGitHubIssueProvider({
        repo: 'owner/repo',
        remote: 'origin',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const comment = await provider.addComment('', '42', 'test')
      expect(comment.issueId).toBe('42')
      expect(comment.author).toBe('alice')
    })
  })
})

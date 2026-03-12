import { describe, it, expect, vi } from 'vitest'
import { createRadicleIssueProvider } from './radicle.js'

function mockExec(responses: Record<string, string>) {
  return vi.fn(async (cmd: string, args: string[], _opts?: unknown) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (args.join(' ').includes(pattern)) {
        return { stdout: response, stderr: '' }
      }
    }
    throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`)
  }) as any
}

const sampleRadIssue = {
  id: 'abc123',
  title: 'Fix radicle bug',
  description: 'Radicle issue body',
  state: 'open',
  labels: ['bug'],
  assignees: ['did:key:z6Mk...'],
  author: { id: 'did:key:z6Mk...', alias: 'alice' },
  timestamp: '2024-01-01T00:00:00Z',
  discussion: []
}

const sampleDiscussion = {
  ...sampleRadIssue,
  discussion: [
    {
      id: 'c1',
      author: { id: 'did:key:z6Mk...', alias: 'alice' },
      body: 'First comment',
      timestamp: '2024-01-02T00:00:00Z'
    }
  ]
}

describe('RadicleIssueProvider', () => {
  describe('list', () => {
    it('lists issues via rad issue list', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([sampleRadIssue]) })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issues = await provider.list('')
      expect(issues).toHaveLength(1)
    })

    it('parses rad CLI output into Issue objects', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([sampleRadIssue]) })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issues = await provider.list('')
      expect(issues[0].id).toBe('abc123')
      expect(issues[0].title).toBe('Fix radicle bug')
    })

    it('maps all unified issue model fields', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([sampleRadIssue]) })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issues = await provider.list('')
      const issue = issues[0]
      expect(issue.provider).toBe('radicle')
      expect(issue.remote).toBe('rad')
      expect(issue.state).toBe('open')
      expect(issue.labels).toEqual(['bug'])
    })

    it('filters by state', async () => {
      const execFn = mockExec({ 'issue list': JSON.stringify([]) })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.list('', { state: 'closed' })
      expect(execFn.mock.calls[0][1]).toContain('closed')
    })
  })

  describe('get', () => {
    it('gets issue by id via rad issue show', async () => {
      const execFn = mockExec({ 'issue show': JSON.stringify(sampleRadIssue) })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.get('', 'abc123')
      expect(issue).toBeDefined()
      expect(issue!.id).toBe('abc123')
    })

    it('returns undefined for non-existent issue', async () => {
      const execFn = vi.fn(async () => {
        throw new Error('not found')
      }) as any
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.get('', 'nonexistent')
      expect(issue).toBeUndefined()
    })
  })

  describe('create', () => {
    it('creates issue via rad issue open', async () => {
      const execFn = mockExec({
        'issue open': 'abc456',
        'issue show': JSON.stringify({ ...sampleRadIssue, id: 'abc456', title: 'New rad issue' })
      })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.create('', { title: 'New rad issue', body: 'Body' })
      expect(issue.title).toBe('New rad issue')
    })

    it('passes title and body to rad CLI', async () => {
      const execFn = mockExec({
        'issue open': 'abc456',
        'issue show': JSON.stringify(sampleRadIssue)
      })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.create('', { title: 'T', body: 'B' })
      const args = execFn.mock.calls[0][1]
      expect(args).toContain('T')
      expect(args).toContain('B')
    })

    it('returns created Issue object', async () => {
      const execFn = mockExec({
        'issue open': 'abc456',
        'issue show': JSON.stringify({ ...sampleRadIssue, id: 'abc456' })
      })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.create('', { title: 'Test' })
      expect(issue.provider).toBe('radicle')
    })
  })

  describe('update', () => {
    it('updates labels via rad issue label', async () => {
      const execFn = mockExec({
        'issue label': '',
        'issue show': JSON.stringify({ ...sampleRadIssue, labels: ['enhancement'] })
      })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.update('', 'abc123', { labels: ['enhancement'] })
      expect(issue.labels).toContain('enhancement')
    })

    it('updates assignees via rad issue assign', async () => {
      const execFn = mockExec({
        'issue assign': '',
        'issue show': JSON.stringify(sampleRadIssue)
      })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      await provider.update('', 'abc123', { assignees: ['did:key:new'] })
      expect(execFn.mock.calls[0][1]).toContain('did:key:new')
    })

    it('updates issue state', async () => {
      const execFn = mockExec({
        'issue state': '',
        'issue show': JSON.stringify({ ...sampleRadIssue, state: 'closed' })
      })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const issue = await provider.update('', 'abc123', { state: 'closed' })
      expect(issue.state).toBe('closed')
    })
  })

  describe('comments', () => {
    it('lists comments for an issue', async () => {
      const execFn = mockExec({ 'issue show': JSON.stringify(sampleDiscussion) })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const comments = await provider.listComments('', 'abc123')
      expect(comments).toHaveLength(1)
      expect(comments[0].body).toBe('First comment')
    })

    it('adds comment via rad issue comment', async () => {
      const execFn = mockExec({
        'issue comment': '',
        'issue show': JSON.stringify({
          ...sampleRadIssue,
          discussion: [{ id: 'c2', author: { alias: 'bob' }, body: 'New comment', timestamp: '2024-01-03T00:00:00Z' }]
        })
      })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const comment = await provider.addComment('', 'abc123', 'New comment')
      expect(comment.body).toBe('New comment')
    })

    it('returns IssueComment object', async () => {
      const execFn = mockExec({
        'issue comment': '',
        'issue show': JSON.stringify(sampleDiscussion)
      })
      const provider = createRadicleIssueProvider({
        rid: 'rad:z123',
        remote: 'rad',
        orgId: 'org1',
        projectId: 'proj1',
        execFn
      })
      const comment = await provider.addComment('', 'abc123', 'test')
      expect(comment.issueId).toBe('abc123')
    })
  })
})

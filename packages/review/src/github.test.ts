import { describe, it, expect, vi } from 'vitest'
import { createGitHubReviewProvider } from './github.js'

function mockExec(responses: Record<string, string>) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    const key = args.join(' ')
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return { stdout: response, stderr: '' }
      }
    }
    throw new Error(`Unexpected call: ${_cmd} ${key}`)
  })
}

const samplePr = {
  number: 42,
  title: 'Add feature',
  body: 'Description',
  state: 'OPEN',
  author: { login: 'alice' },
  reviewDecision: '',
  reviewRequests: [],
  baseRefName: 'main',
  headRefName: 'feature/x',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  mergedAt: null,
  url: 'https://github.com/owner/repo/pull/42'
}

const sampleComment = {
  id: 'c1',
  body: 'Looks good',
  path: 'src/index.ts',
  line: 10,
  side: 'RIGHT',
  author: { login: 'bob' },
  createdAt: '2026-01-01T00:00:00Z',
  isResolved: false
}

describe('GitHubReviewProvider', () => {
  const baseConfig = { repo: 'owner/repo', remote: 'origin', orgId: 'org1', projectId: 'proj1' }

  describe('create', () => {
    it('creates PR via gh pr create', async () => {
      const exec = mockExec({ 'pr create': JSON.stringify(samplePr) })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      const review = await provider.create('', {
        title: 'Add feature',
        body: 'Description',
        baseBranch: 'main',
        headBranch: 'feature/x'
      })
      expect(review.id).toBe('42')
      expect(review.title).toBe('Add feature')
      expect(review.provider).toBe('github')
      expect(exec).toHaveBeenCalledOnce()
    })

    it('passes title, body, baseBranch, headBranch to gh CLI', async () => {
      const exec = mockExec({ 'pr create': JSON.stringify(samplePr) })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.create('', { title: 'Add feature', body: 'Desc', baseBranch: 'main', headBranch: 'feat' })
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--title')
      expect(args).toContain('--base')
      expect(args).toContain('--head')
      expect(args).toContain('--body')
    })

    it('returns Review object', async () => {
      const exec = mockExec({ 'pr create': JSON.stringify(samplePr) })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      const review = await provider.create('', { title: 'T', baseBranch: 'main', headBranch: 'feat' })
      expect(review).toHaveProperty('id')
      expect(review).toHaveProperty('status')
      expect(review).toHaveProperty('remote', 'origin')
    })
  })

  describe('list', () => {
    it('lists PRs via gh pr list', async () => {
      const exec = mockExec({ 'pr list': JSON.stringify([samplePr]) })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      const reviews = await provider.list('')
      expect(reviews).toHaveLength(1)
      expect(reviews[0].id).toBe('42')
    })

    it('filters by status', async () => {
      const exec = mockExec({ 'pr list': JSON.stringify([]) })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.list('', { status: 'merged' })
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--state')
      expect(args).toContain('merged')
    })

    it('parses gh CLI JSON output into Review objects', async () => {
      const exec = mockExec({ 'pr list': JSON.stringify([samplePr, { ...samplePr, number: 43, state: 'MERGED' }]) })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      const reviews = await provider.list('')
      expect(reviews).toHaveLength(2)
      expect(reviews[1].status).toBe('merged')
    })
  })

  describe('get', () => {
    it('gets PR by id via gh pr view', async () => {
      const exec = mockExec({ 'pr view': JSON.stringify(samplePr) })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      const review = await provider.get('', '42')
      expect(review).toBeDefined()
      expect(review!.id).toBe('42')
    })

    it('returns undefined for non-existent PR', async () => {
      const exec = vi.fn(async () => {
        throw new Error('not found')
      })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      const review = await provider.get('', '999')
      expect(review).toBeUndefined()
    })
  })

  describe('approve', () => {
    it('approves via gh pr review --approve', async () => {
      const exec = mockExec({ 'pr review': '' })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.approve('', '42')
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--approve')
    })

    it('includes optional body', async () => {
      const exec = mockExec({ 'pr review': '' })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.approve('', '42', 'LGTM')
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--body')
      expect(args).toContain('LGTM')
    })
  })

  describe('requestChanges', () => {
    it('requests changes via gh pr review --request-changes', async () => {
      const exec = mockExec({ 'pr review': '' })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.requestChanges('', '42', 'Please fix')
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--request-changes')
      expect(args).toContain('Please fix')
    })

    it('includes body', async () => {
      const exec = mockExec({ 'pr review': '' })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.requestChanges('', '42', 'Fix this')
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--body')
    })
  })

  describe('merge', () => {
    it('merges via gh pr merge', async () => {
      const exec = mockExec({ 'pr merge': '' })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.merge('', '42')
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('pr')
      expect(args).toContain('merge')
      expect(args).toContain('--merge')
    })
  })

  describe('comments', () => {
    it('adds inline comment via gh pr comment', async () => {
      const exec = mockExec({
        'pr comment': '',
        'pr view': JSON.stringify({ comments: [sampleComment], reviewComments: [] })
      })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      const comment = await provider.addComment('', '42', {
        filePath: 'src/index.ts',
        lineNumber: 10,
        body: 'Fix this',
        side: 'new'
      })
      expect(comment).toBeDefined()
      expect(comment.body).toContain('Looks good')
    })

    it('lists comments for a PR', async () => {
      const exec = mockExec({
        'pr view': JSON.stringify({ comments: [sampleComment], reviewComments: [] })
      })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      const comments = await provider.listComments('', '42')
      expect(comments).toHaveLength(1)
      expect(comments[0].filePath).toBe('src/index.ts')
    })

    it('resolves comment', async () => {
      const exec = mockExec({ 'api graphql': '{}' })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      await expect(provider.resolveComment('', '42', 'c1')).resolves.toBeUndefined()
    })

    it('maps comment fields to ReviewComment', async () => {
      const exec = mockExec({
        'pr view': JSON.stringify({ comments: [sampleComment], reviewComments: [] })
      })
      const provider = createGitHubReviewProvider({ ...baseConfig, execFn: exec as any })
      const comments = await provider.listComments('', '42')
      expect(comments[0]).toMatchObject({
        id: 'c1',
        reviewId: '42',
        filePath: 'src/index.ts',
        lineNumber: 10,
        side: 'new',
        author: 'bob',
        resolved: false
      })
    })
  })
})

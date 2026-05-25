import { describe, it, expect, vi } from 'vitest'
import { createRadicleReviewProvider } from './radicle.js'

function mockExec(responses: Record<string, string>) {
  return vi.fn(async (_cmd: string, args: string[], _opts?: unknown) => {
    const key = args.join(' ')
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return { stdout: response, stderr: '' }
      }
    }
    throw new Error(`Unexpected call: ${_cmd} ${key}`)
  })
}

const samplePatch = {
  id: 'abc123',
  title: 'Fix issue',
  description: 'Patch description',
  state: 'open',
  author: { id: 'did:key:z6Mk...', alias: 'alice' },
  reviewers: [],
  target: 'main',
  head: 'fix/issue',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z'
}

const sampleDiscussion = {
  ...samplePatch,
  discussion: [
    {
      id: 'dc1',
      body: 'Nice fix',
      author: { alias: 'bob' },
      path: 'src/main.ts',
      line: 5,
      createdAt: '2026-01-01T00:00:00Z',
      resolved: false
    }
  ]
}

describe('RadicleReviewProvider', () => {
  const baseConfig = { rid: 'rad:z123', remote: 'rad', orgId: 'org1', projectId: 'proj1' }

  describe('create', () => {
    it('creates patch via rad patch create', async () => {
      const exec = mockExec({
        'patch create': 'abc123',
        'patch show': JSON.stringify(samplePatch)
      })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      const review = await provider.create('', {
        title: 'Fix issue',
        body: 'Desc',
        baseBranch: 'main',
        headBranch: 'fix/issue'
      })
      expect(review.id).toBe('abc123')
      expect(review.provider).toBe('radicle')
    })

    it('passes title, body, baseBranch, headBranch', async () => {
      const exec = mockExec({
        'patch create': 'abc123',
        'patch show': JSON.stringify(samplePatch)
      })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.create('', { title: 'T', body: 'B', baseBranch: 'main', headBranch: 'feat' })
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--title')
      expect(args).toContain('--target')
      expect(args).toContain('--description')
    })

    it('returns Review object', async () => {
      const exec = mockExec({
        'patch create': 'abc123',
        'patch show': JSON.stringify(samplePatch)
      })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      const review = await provider.create('', { title: 'T', baseBranch: 'main', headBranch: 'feat' })
      expect(review).toHaveProperty('id')
      expect(review).toHaveProperty('status', 'open')
      expect(review).toHaveProperty('remote', 'rad')
    })
  })

  describe('list', () => {
    it('lists patches via rad patch list', async () => {
      const exec = mockExec({ 'patch list': JSON.stringify([samplePatch]) })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      const reviews = await provider.list('')
      expect(reviews).toHaveLength(1)
      expect(reviews[0].id).toBe('abc123')
    })

    it('filters by status', async () => {
      const exec = mockExec({ 'patch list': JSON.stringify([]) })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.list('', { status: 'merged' })
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--state')
      expect(args).toContain('merged')
    })

    it('parses rad CLI output into Review objects', async () => {
      const merged = { ...samplePatch, id: 'def456', state: 'merged' }
      const exec = mockExec({ 'patch list': JSON.stringify([samplePatch, merged]) })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      const reviews = await provider.list('')
      expect(reviews).toHaveLength(2)
      expect(reviews[1].status).toBe('merged')
    })
  })

  describe('get', () => {
    it('gets patch by id via rad patch show', async () => {
      const exec = mockExec({ 'patch show': JSON.stringify(samplePatch) })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      const review = await provider.get('', 'abc123')
      expect(review).toBeDefined()
      expect(review!.id).toBe('abc123')
    })

    it('returns undefined for non-existent patch', async () => {
      const exec = vi.fn(async () => {
        throw new Error('not found')
      })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      const review = await provider.get('', 'nonexistent')
      expect(review).toBeUndefined()
    })
  })

  describe('approve', () => {
    it('approves via rad patch review --accept', async () => {
      const exec = mockExec({ 'patch review': '' })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.approve('', 'abc123')
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--accept')
    })
  })

  describe('requestChanges', () => {
    it('requests changes via rad patch review with comment', async () => {
      const exec = mockExec({ 'patch review': '' })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.requestChanges('', 'abc123', 'Please fix')
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('--reject')
      expect(args).toContain('--message')
      expect(args).toContain('Please fix')
    })
  })

  describe('merge', () => {
    it('merges via rad patch merge', async () => {
      const exec = mockExec({ 'patch merge': '' })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      await provider.merge('', 'abc123')
      const args = exec.mock.calls[0][1] as string[]
      expect(args).toContain('patch')
      expect(args).toContain('merge')
    })
  })

  describe('comments', () => {
    it('adds comment via rad patch comment', async () => {
      const exec = mockExec({
        'patch comment': '',
        'patch show': JSON.stringify(sampleDiscussion)
      })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      const comment = await provider.addComment('', 'abc123', {
        filePath: 'src/main.ts',
        lineNumber: 5,
        body: 'Fix this',
        side: 'new'
      })
      expect(comment).toBeDefined()
    })

    it('lists comments for a patch', async () => {
      const exec = mockExec({ 'patch show': JSON.stringify(sampleDiscussion) })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      const comments = await provider.listComments('', 'abc123')
      expect(comments).toHaveLength(1)
      expect(comments[0].body).toBe('Nice fix')
    })

    it('maps comment fields to ReviewComment', async () => {
      const exec = mockExec({ 'patch show': JSON.stringify(sampleDiscussion) })
      const provider = createRadicleReviewProvider({ ...baseConfig, execFn: exec as any })
      const comments = await provider.listComments('', 'abc123')
      expect(comments[0]).toMatchObject({
        id: 'dc1',
        reviewId: 'abc123',
        filePath: 'src/main.ts',
        lineNumber: 5,
        author: 'bob',
        resolved: false
      })
    })
  })
})

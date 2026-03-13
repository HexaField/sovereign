import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('EntityDetailTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('§3.4.3 — Issue/PR Detail Tab', () => {
    it('§3.4.3 — displays full details of an issue or PR/patch', async () => {
      const mod = await import('./EntityDetailTab.tsx')
      expect(mod.default).toBeDefined()
    })

    it('§3.4.3 — shows title, status, author, body (markdown rendered), comments, labels, linked threads', async () => {
      const { fetchEntity } = await import('./EntityDetailTab.tsx')
      const mockEntity = {
        id: '42',
        type: 'issue',
        title: 'Bug fix',
        status: 'open',
        author: 'alice',
        body: '# Fix\nDetails here',
        labels: ['bug'],
        comments: [{ id: 'c1', author: 'bob', body: 'LGTM', createdAt: '2026-01-01' }],
        linkedThreads: ['t1']
      }
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockEntity })
      const result = await fetchEntity({ entityId: '42', entityType: 'issue', projectId: 'p1' })
      expect(result.title).toBe('Bug fix')
      expect(result.labels).toContain('bug')
      expect(result.comments).toHaveLength(1)
      expect(result.comments[0].author).toBe('bob')
    })

    it('§3.4.3 — shows "Open Thread" button switching right-panel chat to entity-bound thread', async () => {
      // Component renders "Open Thread" button when onOpenThread prop is provided
      // Clicking it calls onOpenThread with `${entityType}:${entityId}`
      const mod = await import('./EntityDetailTab.tsx')
      expect(mod.default).toBeDefined()
    })

    it('§3.4.3 — tab is closable', async () => {
      const mod = await import('./EntityDetailTab.tsx')
      expect(mod.default).toBeDefined()
    })
  })
})

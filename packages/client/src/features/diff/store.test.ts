import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clearDiffSelection, selectedFile, setSelectedFile, selectedRepo, setSelectedRepo } from './store.js'

describe('diff store', () => {
  beforeEach(() => {
    clearDiffSelection()
  })

  it('clearDiffSelection resets all selection state', () => {
    setSelectedFile('src/foo.ts')
    setSelectedRepo('/home/user/project')
    expect(selectedFile()).toBe('src/foo.ts')
    expect(selectedRepo()).toBe('/home/user/project')

    clearDiffSelection()

    expect(selectedFile()).toBe(null)
    expect(selectedRepo()).toBe(null)
  })
})

describe('fetchGitContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns contexts on success', async () => {
    const mockContexts = [
      { repoRoot: '/repo', repoName: 'repo', branch: 'feat', baseBranch: 'main', aheadBy: 3, files: [] }
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ contexts: mockContexts })
      })
    )

    const { fetchGitContext } = await import('./store.js')
    const result = await fetchGitContext('thread-1')
    expect(result).toEqual(mockContexts)
  })

  it('returns null on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const { fetchGitContext } = await import('./store.js')
    const result = await fetchGitContext('thread-1')
    expect(result).toBe(null)
  })

  it('returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))

    const { fetchGitContext } = await import('./store.js')
    const result = await fetchGitContext('thread-1')
    expect(result).toBe(null)
  })
})

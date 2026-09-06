import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  openDiffViewer,
  closeDiffViewer,
  diffViewerOpen,
  diffThreadId,
  selectedFile,
  setSelectedFile,
  selectedRepo,
  setSelectedRepo
} from './store.js'

describe('diff store', () => {
  beforeEach(() => {
    closeDiffViewer() // reset state
  })

  it('openDiffViewer sets threadId and opens', () => {
    expect(diffViewerOpen()).toBe(false)
    expect(diffThreadId()).toBe(null)

    openDiffViewer('thread-123')

    expect(diffViewerOpen()).toBe(true)
    expect(diffThreadId()).toBe('thread-123')
    expect(selectedFile()).toBe(null)
    expect(selectedRepo()).toBe(null)
  })

  it('closeDiffViewer clears all state', () => {
    openDiffViewer('thread-456')
    expect(diffViewerOpen()).toBe(true)

    closeDiffViewer()

    expect(diffViewerOpen()).toBe(false)
    expect(diffThreadId()).toBe(null)
    expect(selectedFile()).toBe(null)
    expect(selectedRepo()).toBe(null)
  })

  it('openDiffViewer resets file/repo selection from previous session', () => {
    openDiffViewer('thread-1')
    // Simulate selecting a file
    setSelectedFile('src/foo.ts')
    setSelectedRepo('/home/user/project')

    // Open for a different thread — should reset
    openDiffViewer('thread-2')
    expect(selectedFile()).toBe(null)
    expect(selectedRepo()).toBe(null)
    expect(diffThreadId()).toBe('thread-2')
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

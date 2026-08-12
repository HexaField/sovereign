/**
 * Multi-root file watcher tests.
 *
 * Validates: start/stop lifecycle, multiple roots, event emission,
 * and ignore patterns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub fs.watch before importing the module
const mockWatchers: Array<{
  handler: (eventType: string, filename: string | null) => void
  root: string
  close: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}> = []

vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn((root: string, _opts: any, handler: any) => {
      const watcher = {
        handler,
        root,
        close: vi.fn(),
        on: vi.fn()
      }
      mockWatchers.push(watcher)
      return watcher
    }),
    statSync: vi.fn(() => ({ isFile: () => true }))
  }
}))

describe('createMultiRootFileWatcher', () => {
  beforeEach(() => {
    mockWatchers.length = 0
    vi.clearAllMocks()
  })

  it('creates one watcher per root', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a', '/root/b', '/root/c'])
    watcher.start()

    expect(mockWatchers.length).toBe(3)
    expect(watcher.watching()).toBe(true)
  })

  it('stops all watchers on stop()', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a', '/root/b'])
    watcher.start()
    watcher.stop()

    expect(mockWatchers[0].close).toHaveBeenCalled()
    expect(mockWatchers[1].close).toHaveBeenCalled()
    expect(watcher.watching()).toBe(false)
  })

  it('emits events with root in payload', async () => {
    vi.useFakeTimers()
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a'])
    watcher.start()

    // Simulate a file change
    mockWatchers[0].handler('change', 'src/index.ts')

    // Advance past debounce
    vi.advanceTimersByTime(200)

    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'file.changed',
        source: 'files',
        payload: expect.objectContaining({
          path: 'src/index.ts',
          fullPath: '/root/a/src/index.ts',
          root: '/root/a'
        })
      })
    )

    watcher.stop()
    vi.useRealTimers()
  })

  it('ignores node_modules paths', async () => {
    vi.useFakeTimers()
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a'])
    watcher.start()

    mockWatchers[0].handler('change', 'node_modules/pkg/index.js')
    vi.advanceTimersByTime(200)

    expect(bus.emit).not.toHaveBeenCalled()

    watcher.stop()
    vi.useRealTimers()
  })

  it('handles single root via createFileWatcher compat', async () => {
    const { createFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createFileWatcher(bus, '/single/root')
    watcher.start()

    expect(mockWatchers.length).toBe(1)
    expect(watcher.watching()).toBe(true)

    watcher.stop()
  })
})

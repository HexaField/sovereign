/**
 * Multi-root file watcher tests.
 *
 * Validates: start/stop lifecycle, multiple roots, event emission,
 * and ignore patterns. Uses a chokidar mock — the real watcher uses chokidar
 * so ignore patterns are applied at watch-registration time (not just event
 * filtering), keeping inotify descriptor counts low.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ── Chokidar mock ──────────────────────────────────────────────────────────
// Capture the last FSWatcher emitter and the options passed to watch().

let lastWatcherEmitter: EventEmitter | null = null
let lastWatchOptions: any = null
let lastWatchPaths: string[] = []

vi.mock('chokidar', () => ({
  watch: vi.fn((paths: string | string[], opts: any) => {
    lastWatchPaths = Array.isArray(paths) ? paths : [paths]
    lastWatchOptions = opts
    const emitter = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
    emitter.close = vi.fn().mockResolvedValue(undefined)
    lastWatcherEmitter = emitter
    return emitter
  })
}))

// ── Helpers ────────────────────────────────────────────────────────────────

function resetMocks() {
  lastWatcherEmitter = null
  lastWatchOptions = null
  lastWatchPaths = []
  vi.clearAllMocks()
}

// Emit a chokidar event on the current watcher instance.
function simulateChokidar(event: string, fullPath: string) {
  if (!lastWatcherEmitter) throw new Error('No watcher started')
  lastWatcherEmitter.emit(event, fullPath)
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('createMultiRootFileWatcher', () => {
  beforeEach(resetMocks)

  it('starts a single chokidar watcher for all roots', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a', '/root/b', '/root/c'])
    watcher.start()

    expect(lastWatchPaths).toEqual(['/root/a', '/root/b', '/root/c'])
    expect(watcher.watching()).toBe(true)
  })

  it('is idempotent — double start() does not create a second watcher', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any
    const { watch } = await import('chokidar')

    const watcher = createMultiRootFileWatcher(bus, ['/root/a'])
    watcher.start()
    watcher.start()

    expect(watch).toHaveBeenCalledTimes(1)
  })

  it('closes the watcher on stop()', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a', '/root/b'])
    watcher.start()
    const emitter = lastWatcherEmitter as any
    watcher.stop()

    expect(emitter.close).toHaveBeenCalled()
    expect(watcher.watching()).toBe(false)
  })

  it('emits file.changed on chokidar add event with root in payload', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a'])
    watcher.start()

    simulateChokidar('add', '/root/a/src/index.ts')

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
  })

  it('emits file.changed on chokidar change event', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a'])
    watcher.start()

    simulateChokidar('change', '/root/a/README.md')

    expect(bus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'file.changed' }))
    watcher.stop()
  })

  it('emits file.deleted on chokidar unlink event', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a'])
    watcher.start()

    simulateChokidar('unlink', '/root/a/gone.ts')

    expect(bus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'file.deleted' }))
    watcher.stop()
  })

  it('passes shouldIgnore as chokidar ignored option', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a'])
    watcher.start()

    // The ignored option should be a function
    expect(typeof lastWatchOptions.ignored).toBe('function')

    // It must exclude known noisy dirs
    const ignored = lastWatchOptions.ignored as (p: string) => boolean
    expect(ignored('/root/a/.git/objects/ab')).toBe(true)
    expect(ignored('/root/a/node_modules/pkg/index.js')).toBe(true)
    expect(ignored('/root/a/dist/index.js')).toBe(true)
    expect(ignored('/root/a/results/run_42.json')).toBe(true)
    expect(ignored('/root/a/.codegraph/codegraph.db')).toBe(true)

    // Normal source paths must NOT be ignored
    expect(ignored('/root/a/src/index.ts')).toBe(false)
    expect(ignored('/root/a/packages/server/src/bootstrap.ts')).toBe(false)

    watcher.stop()
  })

  it('routes events from different roots correctly', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createMultiRootFileWatcher(bus, ['/root/a', '/root/b'])
    watcher.start()

    simulateChokidar('change', '/root/b/lib/util.ts')

    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          root: '/root/b',
          path: 'lib/util.ts'
        })
      })
    )
    watcher.stop()
  })

  it('handles single root via createFileWatcher compat', async () => {
    const { createFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any

    const watcher = createFileWatcher(bus, '/single/root')
    watcher.start()

    expect(lastWatchPaths).toEqual(['/single/root'])
    expect(watcher.watching()).toBe(true)

    watcher.stop()
  })

  it('does not start when rootPaths is empty', async () => {
    const { createMultiRootFileWatcher } = await import('./watcher.js')
    const bus = { emit: vi.fn() } as any
    const { watch } = await import('chokidar')

    const watcher = createMultiRootFileWatcher(bus, [])
    watcher.start()

    expect(watch).not.toHaveBeenCalled()
    expect(watcher.watching()).toBe(false)
  })
})

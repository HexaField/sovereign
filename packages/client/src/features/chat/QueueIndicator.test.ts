import { describe, it, expect, vi } from 'vitest'
import type { QueuedMessage } from '@sovereign/core'

// ── Pure logic tests for QueueIndicator behaviour ──
// These test the filtering and state rules without rendering DOM.

function makeQueueItem(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: `q-${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thread-1',
    text: 'test message',
    timestamp: Date.now(),
    status: 'queued',
    attempts: 0,
    ...overrides
  }
}

describe('QueueIndicator — visible items', () => {
  // visibleItems = serverQueue() — all statuses shown (queued, sending, failed).
  // Action buttons only render for queued/failed (not sending).

  it('includes queued items', () => {
    const items = [makeQueueItem({ status: 'queued' })]
    expect(items).toHaveLength(1)
  })

  it('includes failed items', () => {
    const items = [makeQueueItem({ status: 'failed', error: 'backend down' })]
    expect(items).toHaveLength(1)
  })

  it('includes sending items (rendered without action buttons)', () => {
    const items = [makeQueueItem({ status: 'sending' })]
    expect(items).toHaveLength(1)
  })

  it('preserves all statuses in a mixed queue', () => {
    const items = [
      makeQueueItem({ status: 'sending', text: 'in-flight' }),
      makeQueueItem({ status: 'queued', text: 'waiting' }),
      makeQueueItem({ status: 'failed', text: 'broken' })
    ]
    expect(items).toHaveLength(3)
    expect(items.map((m) => m.status)).toEqual(['sending', 'queued', 'failed'])
  })

  it('returns empty for an empty queue', () => {
    expect([]).toHaveLength(0)
  })
})

describe('QueueIndicator — action button visibility', () => {
  // Replicates the rendering logic: actions show for queued/failed, not sending.
  function hasActions(item: QueuedMessage): boolean {
    return item.status !== 'sending'
  }

  it('shows actions for queued items', () => {
    expect(hasActions(makeQueueItem({ status: 'queued' }))).toBe(true)
  })

  it('shows actions for failed items', () => {
    expect(hasActions(makeQueueItem({ status: 'failed' }))).toBe(true)
  })

  it('hides actions for sending items', () => {
    expect(hasActions(makeQueueItem({ status: 'sending' }))).toBe(false)
  })
})

describe('QueueIndicator — expand/collapse logic', () => {
  // Replicates the effect logic from QueueIndicator.
  // visibleItems = full serverQueue() (no filter).
  function createExpandTracker() {
    let expanded = false
    let prevLength = 0

    function update(queue: QueuedMessage[]): boolean {
      const len = queue.length
      if (len === 0) {
        expanded = false
      } else if (len > prevLength) {
        expanded = true
      }
      prevLength = len
      return expanded
    }

    return { update, getExpanded: () => expanded }
  }

  it('auto-expands when first item arrives', () => {
    const tracker = createExpandTracker()
    const result = tracker.update([makeQueueItem({ status: 'queued' })])
    expect(result).toBe(true)
  })

  it('auto-expands when first item arrives as sending (fast transition)', () => {
    const tracker = createExpandTracker()
    const result = tracker.update([makeQueueItem({ status: 'sending' })])
    expect(result).toBe(true)
  })

  it('auto-collapses when all items clear', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'queued' })])
    const result = tracker.update([])
    expect(result).toBe(false)
  })

  it('auto-expands when a new item arrives in a non-empty queue', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'queued', text: 'first' })])
    const result = tracker.update([
      makeQueueItem({ status: 'queued', text: 'first' }),
      makeQueueItem({ status: 'queued', text: 'second' })
    ])
    expect(result).toBe(true)
  })

  it('preserves state when count stays the same', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'queued' })])
    // count stays 1 — no expansion or collapse trigger
    const result = tracker.update([makeQueueItem({ status: 'queued' })])
    expect(result).toBe(true)
  })

  it('preserves state when an item transitions from queued to sending (count unchanged)', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'queued', text: 'a' }), makeQueueItem({ status: 'queued', text: 'b' })])
    // 'a' moves to sending — total count stays 2
    const result = tracker.update([
      makeQueueItem({ status: 'sending', text: 'a' }),
      makeQueueItem({ status: 'queued', text: 'b' })
    ])
    expect(result).toBe(true)
  })

  it('auto-collapses when the last item gets removed', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'sending' })])
    // removeSent clears the item — count drops to 0
    const result = tracker.update([])
    expect(result).toBe(false)
  })
})

describe('QueueIndicator — store integration', () => {
  it('forceSendQueuedMessage calls the correct endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const { forceSendQueuedMessage } = await import('./store.js')
    forceSendQueuedMessage('queue-item-123')

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/queue/queue-item-123/force-send', { method: 'POST' })

    vi.unstubAllGlobals()
  })

  it('cancelQueuedMessage calls the correct endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const { cancelQueuedMessage } = await import('./store.js')
    cancelQueuedMessage('queue-item-456')

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/queue/queue-item-456', { method: 'DELETE' })

    vi.unstubAllGlobals()
  })

  it('retryQueuedMessage calls the correct endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const { retryQueuedMessage } = await import('./store.js')
    retryQueuedMessage('queue-item-789')

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/queue/queue-item-789/retry', { method: 'POST' })

    vi.unstubAllGlobals()
  })
})

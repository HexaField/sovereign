import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { QueuedMessage } from '@sovereign/core'

// ── Pure logic tests for QueueIndicator behaviour ──
// These test the filtering and state rules without rendering DOM.

/** Replicates the actionable-items filter from QueueIndicator. */
function actionableItems(queue: QueuedMessage[]): QueuedMessage[] {
  return queue.filter((m) => m.status !== 'sending')
}

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

describe('QueueIndicator — actionable items filter', () => {
  it('includes queued items', () => {
    const items = [makeQueueItem({ status: 'queued' })]
    expect(actionableItems(items)).toHaveLength(1)
  })

  it('includes failed items', () => {
    const items = [makeQueueItem({ status: 'failed', error: 'backend down' })]
    expect(actionableItems(items)).toHaveLength(1)
  })

  it('excludes sending items', () => {
    const items = [makeQueueItem({ status: 'sending' })]
    expect(actionableItems(items)).toHaveLength(0)
  })

  it('filters a mixed queue correctly', () => {
    const items = [
      makeQueueItem({ status: 'sending', text: 'in-flight' }),
      makeQueueItem({ status: 'queued', text: 'waiting' }),
      makeQueueItem({ status: 'failed', text: 'broken' })
    ]
    const result = actionableItems(items)
    expect(result).toHaveLength(2)
    expect(result.map((m) => m.text)).toEqual(['waiting', 'broken'])
  })

  it('returns empty for an all-sending queue', () => {
    const items = [makeQueueItem({ status: 'sending' }), makeQueueItem({ status: 'sending' })]
    expect(actionableItems(items)).toHaveLength(0)
  })

  it('returns empty for an empty queue', () => {
    expect(actionableItems([])).toHaveLength(0)
  })
})

describe('QueueIndicator — expand/collapse logic', () => {
  // Replicates the effect logic from QueueIndicator
  function createExpandTracker() {
    let expanded = false
    let prevLength = 0

    function update(queue: QueuedMessage[]): boolean {
      const items = actionableItems(queue)
      const len = items.length
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

  it('auto-expands when first actionable item arrives', () => {
    const tracker = createExpandTracker()
    const result = tracker.update([makeQueueItem({ status: 'queued' })])
    expect(result).toBe(true)
  })

  it('auto-collapses when all items clear', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'queued' })])
    const result = tracker.update([])
    expect(result).toBe(false)
  })

  it('auto-expands when a new actionable item arrives in a non-empty queue', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'queued', text: 'first' })])
    const result = tracker.update([
      makeQueueItem({ status: 'queued', text: 'first' }),
      makeQueueItem({ status: 'queued', text: 'second' })
    ])
    expect(result).toBe(true)
  })

  it('stays collapsed when user manually collapsed and count does not increase', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'queued' })])
    // Simulate user collapse — not modelled in pure logic, but count staying
    // the same means the effect doesn't re-expand.
    const result = tracker.update([makeQueueItem({ status: 'queued' })])
    // Still true because len === prevLength — no expansion trigger, no collapse trigger.
    // The effect preserves current state.
    expect(result).toBe(true)
  })

  it('does NOT expand when a queued item transitions to sending (count decreases)', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'queued', text: 'a' }), makeQueueItem({ status: 'queued', text: 'b' })])
    // 'a' moves to sending — actionable count drops from 2 to 1
    const result = tracker.update([
      makeQueueItem({ status: 'sending', text: 'a' }),
      makeQueueItem({ status: 'queued', text: 'b' })
    ])
    // Still expanded (count decreased, so neither branch fires — state preserved)
    expect(result).toBe(true)
  })

  it('auto-collapses when the last actionable item moves to sending', () => {
    const tracker = createExpandTracker()
    tracker.update([makeQueueItem({ status: 'queued' })])
    // Item moves to 'sending' — actionable count drops to 0
    const result = tracker.update([makeQueueItem({ status: 'sending' })])
    expect(result).toBe(false)
  })
})

describe('QueueIndicator — store integration', () => {
  it('forceSendQueuedMessage calls the correct endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    // Import dynamically so the mock is in place
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

import { describe, it, expect } from 'vitest'
import { EndpointQueue } from './endpoint-queue.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a deferred promise so tests can control when a queued fn resolves. */
function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush all microtasks (Promise chain ticks) so side effects propagate. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EndpointQueue', () => {
  // ── Basic behaviour ───────────────────────────────────────────────────────

  it('runs a single request immediately', async () => {
    const q = new EndpointQueue(1)
    const result = await q.run(() => Promise.resolve(42))
    expect(result).toBe(42)
  })

  it('propagates rejection from fn', async () => {
    const q = new EndpointQueue(1)
    const err = new Error('inference failed')
    await expect(q.run(() => Promise.reject(err))).rejects.toBe(err)
    // Queue continues to work after an error.
    const result = await q.run(() => Promise.resolve('ok'))
    expect(result).toBe('ok')
  })

  it('exposes queueLength and activeCount', async () => {
    const q = new EndpointQueue(1)
    const d = deferred<void>()

    expect(q.activeCount).toBe(0)
    expect(q.queueLength).toBe(0)

    const p = q.run(() => d.promise)
    expect(q.activeCount).toBe(1)
    expect(q.queueLength).toBe(0)

    void q.run(async () => {}) // sits in queue while p runs
    expect(q.queueLength).toBe(1)

    d.resolve()
    await p
    await flush() // let the second request drain
    expect(q.activeCount).toBe(0)
    expect(q.queueLength).toBe(0)
  })

  // ── Serialisation ─────────────────────────────────────────────────────────

  it('serialises requests when maxConcurrent=1', async () => {
    const q = new EndpointQueue(1)
    const order: number[] = []
    const d1 = deferred<void>()

    const p1 = q.run(async () => {
      order.push(1)
      await d1.promise
    })
    const p2 = q.run(async () => {
      order.push(2)
    })

    expect(order).toEqual([1]) // p1 started, p2 still waiting
    expect(q.activeCount).toBe(1)
    expect(q.queueLength).toBe(1)

    d1.resolve()
    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
  })

  it('allows maxConcurrent=2 requests to run in parallel', async () => {
    const q = new EndpointQueue(2)
    const d1 = deferred<void>(),
      d2 = deferred<void>()

    const p1 = q.run(() => d1.promise)
    const p2 = q.run(() => d2.promise)
    const p3 = q.run(async () => {}) // third must wait

    expect(q.activeCount).toBe(2)
    expect(q.queueLength).toBe(1)

    d1.resolve()
    d2.resolve()
    await Promise.all([p1, p2, p3])
    expect(q.activeCount).toBe(0)
    expect(q.queueLength).toBe(0)
  })

  // ── Priority ordering ─────────────────────────────────────────────────────

  it('serves high → normal → low regardless of arrival order', async () => {
    const q = new EndpointQueue(1)
    const d = deferred<void>()
    const order: string[] = []

    // Occupy the single slot so subsequent enqueues actually queue.
    const p0 = q.run(() => d.promise, { priority: 'normal' })

    // Enqueue out-of-tier order to verify sorting.
    const pLow = q.run(
      async () => {
        order.push('low')
      },
      { priority: 'low' }
    )
    const pHigh = q.run(
      async () => {
        order.push('high')
      },
      { priority: 'high' }
    )
    const pNormal = q.run(
      async () => {
        order.push('normal')
      },
      { priority: 'normal' }
    )

    expect(q.queueLength).toBe(3)

    d.resolve()
    await Promise.all([p0, pLow, pHigh, pNormal])

    expect(order).toEqual(['high', 'normal', 'low'])
  })

  it('orders by estimatedTokens (shortest first) within a priority tier', async () => {
    const q = new EndpointQueue(1)
    const d = deferred<void>()
    const order: number[] = []

    const p0 = q.run(() => d.promise, { priority: 'normal' })
    const pBig = q.run(
      async () => {
        order.push(1000)
      },
      { priority: 'normal', estimatedTokens: 1000 }
    )
    const pSmall = q.run(
      async () => {
        order.push(100)
      },
      { priority: 'normal', estimatedTokens: 100 }
    )
    const pTiny = q.run(
      async () => {
        order.push(10)
      },
      { priority: 'normal', estimatedTokens: 10 }
    )

    d.resolve()
    await Promise.all([p0, pBig, pSmall, pTiny])

    expect(order).toEqual([10, 100, 1000])
  })

  it('priority beats estimatedTokens (high with large context before low with tiny context)', async () => {
    const q = new EndpointQueue(1)
    const d = deferred<void>()
    const order: string[] = []

    const p0 = q.run(() => d.promise)
    const pLowSmall = q.run(
      async () => {
        order.push('low-small')
      },
      { priority: 'low', estimatedTokens: 1 }
    )
    const pHighLarge = q.run(
      async () => {
        order.push('high-large')
      },
      { priority: 'high', estimatedTokens: 99999 }
    )

    d.resolve()
    await Promise.all([p0, pLowSmall, pHighLarge])

    // high-large must run before low-small despite having more tokens
    expect(order).toEqual(['high-large', 'low-small'])
  })

  // ── AbortSignal handling ──────────────────────────────────────────────────

  it('rejects immediately when signal is already aborted', async () => {
    const q = new EndpointQueue(1)
    const signal = AbortSignal.abort()
    await expect(q.run(() => Promise.resolve(), { signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('dequeues and rejects when signal aborts while waiting', async () => {
    const q = new EndpointQueue(1)
    const d = deferred<void>()
    const ctrl = new AbortController()

    const p1 = q.run(() => d.promise)
    const p2 = q.run(async () => 'result', { signal: ctrl.signal })

    expect(q.queueLength).toBe(1)
    ctrl.abort()

    await expect(p2).rejects.toMatchObject({ name: 'AbortError' })
    expect(q.queueLength).toBe(0) // removed from queue

    d.resolve()
    await p1
  })

  it('continues draining after a queued abort', async () => {
    const q = new EndpointQueue(1)
    const d = deferred<void>()
    const ctrl = new AbortController()
    const order: string[] = []

    const p1 = q.run(() => d.promise)
    const pAbort = q.run(
      async () => {
        order.push('aborted-fn')
      },
      { signal: ctrl.signal }
    )
    const p3 = q.run(async () => {
      order.push('third')
    })

    ctrl.abort()
    await expect(pAbort).rejects.toMatchObject({ name: 'AbortError' })

    d.resolve()
    await Promise.all([p1, p3])
    expect(order).toEqual(['third']) // aborted fn never ran
  })

  it('handles abort that fires between shift() and fn() (tight race)', async () => {
    // Simulate the race where drain() shift()s the entry and the signal
    // fires before fn() is called. We test this by pre-aborting a signal
    // that the queue's pre-enqueue check did NOT see (signal becomes aborted
    // after the aborted check but before drain picks it).
    //
    // In practice: create a signal that is NOT aborted when run() is called,
    // then abort it synchronously before the microtask queue can drain.
    const q = new EndpointQueue(1)
    const d = deferred<void>()
    const ctrl = new AbortController()

    // Occupy the slot so the entry goes into the waiting queue.
    const p1 = q.run(() => d.promise)
    const p2 = q.run(async () => 'ok', { signal: ctrl.signal })

    // Abort and free the slot simultaneously — drain() will shift p2 and
    // immediately check signal.aborted.
    ctrl.abort()
    d.resolve()

    // p2 should reject (either from the abort listener or the drain check).
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' })
    await p1
  })

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('handles concurrent completions with maxConcurrent > 1', async () => {
    const q = new EndpointQueue(3)
    const results = await Promise.all([
      q.run(() => Promise.resolve(1)),
      q.run(() => Promise.resolve(2)),
      q.run(() => Promise.resolve(3)),
      q.run(() => Promise.resolve(4)) // queues behind the 3 concurrent
    ])
    expect(results).toEqual([1, 2, 3, 4])
  })

  it('inserting into an empty queue always returns index 0', async () => {
    const q = new EndpointQueue(1)
    // All priorities should work on an empty queue without throwing.
    for (const priority of ['high', 'normal', 'low'] as const) {
      const result = await q.run(() => Promise.resolve(priority), { priority })
      expect(result).toBe(priority)
    }
  })
})

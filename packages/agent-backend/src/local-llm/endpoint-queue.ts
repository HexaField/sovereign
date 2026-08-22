// Per-endpoint serialisation queue with priority tiers.
//
// The inference server runs with --parallel 1: one request processes at
// a time. Without a client-side queue, multiple sessions race to fire
// complete() simultaneously and the server serialises them internally
// with no visibility into session priorities or context lengths.
//
// This queue:
// - Limits concurrent requests per endpoint to maxConcurrent (default 1
//   to match --parallel 1 on the server).
// - Orders waiting requests by priority tier: high → normal → low.
// - Within a tier, orders by estimatedTokens (shortest first) so a brief
//   presence ping does not wait behind a 40 K-token coding turn.
// - Propagates AbortSignal: a cancelled request dequeues immediately
//   without ever reaching the server, freeing the slot for the next entry.

export type QueuePriority = 'high' | 'normal' | 'low'

export interface QueueRunOptions {
  signal?: AbortSignal
  priority?: QueuePriority
  /** Estimated prompt-token count for sub-priority ordering (shortest first).
   *  Pass state.lastPromptTokens for the most accurate value. Defaults to 0. */
  estimatedTokens?: number
}

interface QueueEntry {
  fn: () => Promise<unknown>
  priority: QueuePriority
  estimatedTokens: number
  signal?: AbortSignal
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

const PRIORITY_ORDER: Record<QueuePriority, number> = { high: 0, normal: 1, low: 2 }

export class EndpointQueue {
  private readonly _queue: QueueEntry[] = []
  private _running = 0

  constructor(readonly maxConcurrent = 1) {}

  /** Enqueue `fn` and return a Promise that resolves or rejects with its
   *  result. The call may wait if all maxConcurrent slots are busy. */
  run<T>(fn: () => Promise<T>, opts: QueueRunOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const { signal, priority = 'normal', estimatedTokens = 0 } = opts

      // Reject immediately when already aborted — never enter the queue.
      if (signal?.aborted) {
        reject(new DOMException('Request aborted before queuing', 'AbortError'))
        return
      }

      const entry: QueueEntry = {
        fn: fn as () => Promise<unknown>,
        priority,
        estimatedTokens,
        signal,
        resolve: resolve as (value: unknown) => void,
        reject
      }

      // Remove-and-reject if the signal fires while waiting in the queue.
      // { once: true } auto-cleans the listener after it fires. On the happy
      // path (no abort), the listener stays registered but becomes a no-op
      // and GCs with the signal object.
      const onAbort = () => {
        const idx = this._queue.indexOf(entry)
        if (idx !== -1) {
          this._queue.splice(idx, 1)
          reject(new DOMException('Request aborted while queued', 'AbortError'))
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      // Insert at the correct sorted position:
      // lower PRIORITY_ORDER value = higher urgency = earlier in queue.
      // Within the same tier, fewer estimatedTokens = earlier in queue.
      const pos = this._insertionIndex(entry)
      this._queue.splice(pos, 0, entry)

      this._drain()
    })
  }

  private _insertionIndex(entry: QueueEntry): number {
    const epri = PRIORITY_ORDER[entry.priority]
    for (let i = 0; i < this._queue.length; i++) {
      const q = this._queue[i]
      const qpri = PRIORITY_ORDER[q.priority]
      if (qpri > epri) return i
      if (qpri === epri && q.estimatedTokens > entry.estimatedTokens) return i
    }
    return this._queue.length
  }

  private _drain(): void {
    while (this._running < this.maxConcurrent && this._queue.length > 0) {
      const entry = this._queue.shift()!
      this._running++

      // Re-check abort: the signal may have fired between enqueue and drain.
      // If the abort listener fires AFTER the entry was already shift()ed,
      // the listener finds indexOf === -1 and does nothing — we catch it here.
      if (entry.signal?.aborted) {
        this._running--
        entry.reject(new DOMException('Request aborted before execution', 'AbortError'))
        continue
      }

      entry.fn().then(
        (value) => {
          entry.resolve(value)
          this._running--
          this._drain()
        },
        (err: unknown) => {
          entry.reject(err)
          this._running--
          this._drain()
        }
      )
    }
  }

  /** Number of requests currently waiting in the queue. */
  get queueLength(): number {
    return this._queue.length
  }
  /** Number of requests currently executing. */
  get activeCount(): number {
    return this._running
  }
}

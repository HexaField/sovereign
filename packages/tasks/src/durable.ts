// Durable — an in-memory state kept in step with a remote backend (AD4M)
// that is not always reachable.
//
//   reads   → the in-memory copy, always
//   write   → applied to the copy, appended to the outbox (write-ahead),
//             then replayed to the backend in order
//   restart → the copy loads from the local snapshot plus the outbox, then
//             from the backend once it answers
//
// Files (in `dir`):
//   <outbox>    append-only JSON lines {seq, at, op}: ops the backend has not
//               confirmed. Rewritten (tmp + rename) once a replay pass ends.
//   <snapshot>  the whole copy, written tmp + fsync + rename, debounced.
//   <outbox>.dead.jsonl  ops the backend kept rejecting while reachable.
//
// Ops must be idempotent: after a crash mid-replay the outbox still holds ops
// the backend already applied, and they replay again.
//
// Without a backend (`connect: null`) the snapshot is the store, and the
// outbox only bridges the gap between a write and the next snapshot.

import fs from 'node:fs'
import path from 'node:path'

export interface DurableBackend<S, Op> {
  /** Stable identity of the backing store (the perspective uuid). A change
   *  of identity reseeds the backend from the local copy. */
  id: string
  load(): Promise<S>
  apply(op: Op): Promise<void>
  /** Cheap reachability probe: tells "backend down" from "op rejected". */
  ping(): Promise<void>
}

export interface DurableOptions<S, Op> {
  /** Log tag, e.g. "tasks". */
  name: string
  dir: string
  outboxFile: string
  snapshotFile: string
  /** Opens the backend; throws while it is unreachable. null = local only. */
  connect: (() => Promise<DurableBackend<S, Op>>) | null
  /** Signals that the backend may be back (AD4M reconnect). Returns an unsubscriber. */
  onReconnect?: (cb: () => void) => () => void
  empty(): S
  /** Apply an op to a state in place. Must be idempotent. */
  apply(state: S, op: Op): void
  serialize(state: S): unknown
  deserialize(raw: unknown): S
  /** Validate and migrate an op read back from the outbox. */
  reviveOp(raw: unknown): Op | undefined
  /** Ops that rebuild `state` in an empty backend. */
  seedOps(state: S): Op[]
  isEmpty(state: S): boolean
  /** Retry interval while the backend is down or ops are pending. Default 15 s. */
  retryMs?: number
  /** Timeout for each backend call. Default 20 s. */
  callTimeoutMs?: number
  /** Snapshot debounce. Default 250 ms. */
  snapshotDelayMs?: number
  /** Rejections (while the backend answers pings) before an op is dead-lettered. Default 5. */
  maxOpAttempts?: number
  log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface DurableStatus {
  backend: 'off' | 'connected' | 'down' | 'connecting'
  /** The copy has been loaded from the backend at least once this process. */
  loadedFromBackend: boolean
  /** Ops waiting in the outbox. */
  pending: number
  deadLettered: number
  lastError?: string
  lastSyncAt?: string
  snapshotAt?: string
}

export interface Durable<S, Op> {
  /** The current in-memory copy. Replaced (not mutated) when the backend loads. */
  state(): S
  /** Apply an op locally and queue it for the backend. Synchronous. */
  write(op: Op): void
  status(): DurableStatus
  /** Run one replay/load pass now. Resolves when that pass ends. */
  sync(): Promise<void>
  /** Resolves once the first pass after start has finished, success or not. */
  settled(): Promise<void>
  /** Write the snapshot now. */
  flushSnapshot(): void
  /** Stop timers and write the snapshot. */
  dispose(): void
}

interface OutboxEntry<Op> {
  seq: number
  at: string
  op: Op
  attempts?: number
}

interface SnapshotFile {
  version: 1
  savedAt: string
  /** Backend identity whose contents this copy reflects; null = local only. */
  backendId: string | null
  state: unknown
}

function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms} ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

function errMsg(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

export function createDurable<S, Op>(opts: DurableOptions<S, Op>): Durable<S, Op> {
  const log = opts.log ?? console
  const tag = `[${opts.name}]`
  const retryMs = opts.retryMs ?? 15_000
  const callTimeoutMs = opts.callTimeoutMs ?? 20_000
  const snapshotDelayMs = opts.snapshotDelayMs ?? 250
  const maxOpAttempts = opts.maxOpAttempts ?? 5
  const outboxPath = path.join(opts.dir, opts.outboxFile)
  const snapshotPath = path.join(opts.dir, opts.snapshotFile)
  const deadPath = `${outboxPath}.dead.jsonl`

  fs.mkdirSync(opts.dir, { recursive: true })

  let current: S = opts.empty()
  let backendId: string | null = null
  let queue: OutboxEntry<Op>[] = []
  let seq = 0
  let backend: DurableBackend<S, Op> | null = null
  let loadedFromBackend = false
  let disposed = false
  const status: DurableStatus = {
    backend: opts.connect ? 'connecting' : 'off',
    loadedFromBackend: false,
    pending: 0,
    deadLettered: 0
  }

  // ── Load local state ────────────────────────────────────────────────
  try {
    const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as SnapshotFile
    current = opts.deserialize(raw.state)
    backendId = raw.backendId ?? null
    status.snapshotAt = raw.savedAt
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(tag, `snapshot unreadable, starting from the outbox only: ${errMsg(err)}`)
    }
  }

  try {
    const lines = fs.readFileSync(outboxPath, 'utf-8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as OutboxEntry<unknown>
        const op = opts.reviveOp(entry.op)
        if (!op) {
          log.warn(tag, `outbox: dropping unrecognised op at seq ${entry.seq}`)
          continue
        }
        queue.push({ seq: entry.seq, at: entry.at, op })
        seq = Math.max(seq, entry.seq)
      } catch {
        // A torn last line from a crash mid-append. Everything before it is intact.
        log.warn(tag, 'outbox: skipping a malformed line')
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tag, `outbox unreadable: ${errMsg(err)}`)
  }
  for (const entry of queue) opts.apply(current, entry.op)
  status.pending = queue.length
  // Writes made local-only never reach a backend, so the copy no longer
  // reflects any backend: the next backend connect reseeds it.
  if (!opts.connect) backendId = null
  // Data that may be missing from the backend: a snapshot (or outbox) that
  // came from local-only mode. Ops written from here on are in the outbox.
  let unseededLocalData = backendId === null && !opts.isEmpty(current)
  if (queue.length > 0) log.log(tag, `${queue.length} op(s) pending in the outbox`)

  // ── Files ───────────────────────────────────────────────────────────
  function appendOutbox(entry: OutboxEntry<Op>): void {
    fs.appendFileSync(outboxPath, JSON.stringify({ seq: entry.seq, at: entry.at, op: entry.op }) + '\n')
  }

  function rewriteOutbox(): void {
    if (queue.length === 0) {
      try {
        fs.rmSync(outboxPath, { force: true })
      } catch (err) {
        log.warn(tag, `failed to clear outbox: ${errMsg(err)}`)
      }
      return
    }
    const text = queue.map((e) => JSON.stringify({ seq: e.seq, at: e.at, op: e.op })).join('\n') + '\n'
    writeFileAtomic(outboxPath, text)
  }

  let snapshotTimer: ReturnType<typeof setTimeout> | null = null
  function flushSnapshot(): void {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer)
      snapshotTimer = null
    }
    const savedAt = new Date().toISOString()
    const file: SnapshotFile = { version: 1, savedAt, backendId, state: opts.serialize(current) }
    try {
      writeFileAtomic(snapshotPath, JSON.stringify(file))
      status.snapshotAt = savedAt
    } catch (err) {
      log.error(tag, `snapshot write failed: ${errMsg(err)}`)
      return
    }
    // Local-only: the snapshot now holds every queued op.
    if (!opts.connect && queue.length > 0) {
      queue = []
      status.pending = 0
      rewriteOutbox()
    }
  }

  function scheduleSnapshot(): void {
    if (disposed || snapshotTimer) return
    snapshotTimer = setTimeout(flushSnapshot, snapshotDelayMs)
    snapshotTimer.unref?.()
  }

  function deadLetter(entry: OutboxEntry<Op>, err: unknown): void {
    log.error(tag, `backend keeps rejecting op seq ${entry.seq}; moved to ${path.basename(deadPath)}: ${errMsg(err)}`)
    try {
      fs.appendFileSync(deadPath, JSON.stringify({ ...entry, error: errMsg(err) }) + '\n')
    } catch (e) {
      log.error(tag, `failed to write dead letter: ${errMsg(e)}`)
    }
    status.deadLettered++
  }

  function markDown(err: unknown): void {
    backend = null
    if (status.backend !== 'down') log.warn(tag, `backend unreachable, writes queue in the outbox: ${errMsg(err)}`)
    status.backend = 'down'
    status.lastError = errMsg(err)
  }

  // ── Replay ──────────────────────────────────────────────────────────
  async function pass(): Promise<void> {
    if (!opts.connect || disposed) return
    let b = backend
    if (!b) {
      try {
        b = await withTimeout(opts.connect(), callTimeoutMs, 'connect')
      } catch (err) {
        markDown(err)
        return
      }
      backend = b
      // A backend that does not hold our copy (first connect after running
      // local-only, or a new perspective): seed it from the copy first.
      if (b.id !== backendId && (backendId !== null || unseededLocalData) && !opts.isEmpty(current)) {
        const seeds = opts.seedOps(current).map((op) => ({ seq: 0, at: new Date().toISOString(), op }))
        log.log(tag, `seeding backend ${b.id} with ${seeds.length} op(s) from the local copy`)
        queue = [...seeds, ...queue]
        rewriteOutbox()
      }
      if (b.id !== backendId) {
        backendId = b.id
        loadedFromBackend = false
      }
      unseededLocalData = false
    }

    while (queue.length > 0) {
      if (disposed) return
      const entry = queue[0]
      try {
        await withTimeout(b.apply(entry.op), callTimeoutMs, 'apply')
        queue.shift()
        status.pending = queue.length
      } catch (err) {
        let alive = false
        try {
          await withTimeout(b.ping(), callTimeoutMs, 'ping')
          alive = true
        } catch {
          /* down */
        }
        if (!alive) {
          rewriteOutbox()
          markDown(err)
          return
        }
        entry.attempts = (entry.attempts ?? 0) + 1
        status.lastError = errMsg(err)
        if (entry.attempts >= maxOpAttempts) {
          deadLetter(entry, err)
          queue.shift()
          status.pending = queue.length
          continue
        }
        rewriteOutbox()
        log.warn(tag, `op seq ${entry.seq} rejected (attempt ${entry.attempts}): ${errMsg(err)}`)
        return
      }
    }
    rewriteOutbox()

    if (!loadedFromBackend) {
      let loaded: S
      try {
        loaded = await withTimeout(b.load(), callTimeoutMs, 'load')
      } catch (err) {
        markDown(err)
        return
      }
      // Ops written while the load ran are in memory but not in `loaded`.
      for (const entry of queue) opts.apply(loaded, entry.op)
      current = loaded
      loadedFromBackend = true
      status.loadedFromBackend = true
      flushSnapshot()
      log.log(tag, `loaded from backend ${b.id}`)
      if (queue.length > 0) return pass()
    }

    if (status.backend !== 'connected') log.log(tag, 'backend connected; outbox drained')
    status.backend = 'connected'
    status.lastError = undefined
    status.lastSyncAt = new Date().toISOString()
  }

  let running: Promise<void> | null = null
  let again = false
  function sync(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await pass()
          // A request that came in during the pass (a write, a reconnect signal)
          // gets its own pass, even if this one found the backend down.
        } while (again && !disposed)
      } catch (err) {
        log.error(tag, `sync failed: ${errMsg(err)}`)
      } finally {
        running = null
      }
    })()
    return running
  }

  // ── Lifecycle ───────────────────────────────────────────────────────
  let retryTimer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | undefined
  let firstPass: Promise<void> = Promise.resolve()
  if (opts.connect) {
    retryTimer = setInterval(() => {
      if (queue.length > 0 || !loadedFromBackend || status.backend !== 'connected') void sync()
    }, retryMs)
    retryTimer.unref?.()
    unsubscribe = opts.onReconnect?.(() => {
      backend = null
      void sync()
    })
    firstPass = sync()
  } else if (queue.length > 0) {
    flushSnapshot()
  }

  return {
    state: () => current,

    write(op) {
      if (disposed) throw new Error(`${tag} store disposed`)
      opts.apply(current, op)
      const entry: OutboxEntry<Op> = { seq: ++seq, at: new Date().toISOString(), op }
      queue.push(entry)
      status.pending = queue.length
      try {
        appendOutbox(entry)
      } catch (err) {
        log.error(tag, `outbox append failed: ${errMsg(err)}`)
      }
      scheduleSnapshot()
      if (opts.connect) void sync()
    },

    status: () => ({ ...status, pending: queue.length }),
    sync,
    settled: () => firstPass,
    flushSnapshot,

    dispose() {
      if (disposed) return
      flushSnapshot()
      disposed = true
      if (retryTimer) clearInterval(retryTimer)
      unsubscribe?.()
    }
  }
}

// Keeps every codegraph index under the org roots in step with the files on
// disk. The files watcher reports each change; a burst of changes becomes one
// `codegraph sync` of the checkout that owns the changed paths. A sync
// reconciles the whole index against the filesystem (stat, then hash), so it
// also absorbs commits, checkouts and pulls, and a missed event costs nothing
// once a later event — or the periodic pass — reaches that checkout.

import fs from 'node:fs'
import path from 'node:path'
import type { BusEvent, EventBus } from '@sovereign/core'
import { createCodegraphCli, type CodegraphCli } from './cli.js'
import { discoverRoots, hasIndex, isWithin, MAX_DEPTH, type DiscoveredRoots } from './discover.js'

export interface RootStatus {
  root: string
  state: 'queued' | 'syncing' | 'ok' | 'error'
  /** Epoch ms of the last successful sync. */
  lastSyncAt?: number
  durationMs?: number
  error?: string
}

export interface CodeIndexStatus {
  enabled: boolean
  version?: string
  /** Why the index is not running, when it isn't. */
  reason?: string
  roots: RootStatus[]
}

export interface CodeIndexHealth {
  status: 'ok' | 'degraded' | 'down' | 'off'
  version: string
  roots: number
  errors: number
  lastSyncAt: number | null
}

export interface CodeIndexOptions {
  bus: EventBus
  getOrgRoots: () => string[]
  /** False opts out (CODEGRAPH_INDEX=off). */
  enabled?: boolean
  cli?: CodegraphCli
  discover?: (orgRoots: string[]) => Promise<DiscoveredRoots>
  /** Quiet time after the last change before a checkout syncs. */
  debounceMs?: number
  /** Longest a checkout under continuous writes waits for a sync. */
  maxWaitMs?: number
  /** Coalesces discovery triggers. */
  rediscoverDelayMs?: number
  /** First retry after a failed job; doubles per failure up to the reconcile interval. */
  retryMs?: number
  concurrency?: number
  reconcileIntervalMs?: number
  rediscoverIntervalMs?: number
}

export interface CodeIndex {
  start(): Promise<void>
  stop(): void
  status(): CodeIndexStatus
  health(): CodeIndexHealth
  /** Queue a sync of one checkout (false when unknown), or of every checkout. */
  sync(root?: string): boolean
  /** Rescan the org roots; resolves after a pass that started after the call. */
  rediscover(): Promise<void>
}

interface Root {
  status: RootStatus
  /** Discovered without an index: its jobs run `codegraph init` until one exists. */
  init: boolean
  failures: number
  retry?: NodeJS.Timeout
  debounce?: { timer: NodeJS.Timeout; firstAt: number }
  /** Changed while its job ran, so it runs again after; true when urgent. */
  dirty?: boolean
}

const STRUCTURAL_EVENTS = [
  'worktree.created',
  'worktree.removed',
  'project.created',
  'project.deleted',
  'org.created',
  'org.updated',
  'org.deleted'
]

export function createCodeIndex(opts: CodeIndexOptions): CodeIndex {
  const cli = opts.cli ?? createCodegraphCli()
  const discover = opts.discover ?? discoverRoots
  const debounceMs = opts.debounceMs ?? 250
  const maxWaitMs = opts.maxWaitMs ?? 3_000
  const rediscoverDelayMs = opts.rediscoverDelayMs ?? 1_000
  const reconcileIntervalMs = opts.reconcileIntervalMs ?? 10 * 60_000
  const retryMs = opts.retryMs ?? 10_000
  const concurrency = opts.concurrency ?? 2

  const roots = new Map<string, Root>()
  /** Queued jobs in FIFO order; true marks an urgent one. */
  const pending = new Map<string, boolean>()
  /** Paths with a job in flight, tracked or not: a path never runs two at once. */
  const running = new Set<string>()
  /**
   * Org roots whose path runs through a symlink, as [configured, real].
   * Discovery tracks real paths; the watcher reports configured ones.
   */
  let aliases: Array<[string, string]> = []

  const optedOut = opts.enabled === false
  let version: string | null | undefined // undefined until probed; null when missing
  let stopped = false
  let discovery = Promise.resolve()
  let discoveryQueued = false
  let rediscoverTimer: NodeJS.Timeout | undefined
  const unsubscribes: Array<() => void> = []
  const intervals: NodeJS.Timeout[] = []

  const isActive = () => !optedOut && !!version && !stopped

  function track(root: string): Root {
    const r: Root = { status: { root, state: 'queued' }, init: false, failures: 0 }
    roots.set(root, r)
    return r
  }

  function untrack(root: string): void {
    const r = roots.get(root)
    clearTimeout(r?.retry)
    clearTimeout(r?.debounce?.timer)
    roots.delete(root)
    pending.delete(root)
  }

  /** Urgent (event-triggered) jobs run before startup catch-up, retries and periodic passes. */
  function request(root: string, urgent: boolean): void {
    const r = roots.get(root)
    if (stopped || !r) return
    if (running.has(root)) {
      r.dirty = urgent || !!r.dirty
      return
    }
    pending.set(root, urgent || !!pending.get(root))
    pump()
  }

  function pump(): void {
    while (running.size < concurrency && pending.size > 0) {
      // Map order is insertion order: FIFO within each priority.
      const root = [...pending].find(([, urgent]) => urgent)?.[0] ?? pending.keys().next().value!
      pending.delete(root)
      void runJob(root, roots.get(root)!)
    }
  }

  async function runJob(root: string, r: Root): Promise<void> {
    running.add(root)
    r.status.state = 'syncing'
    const started = Date.now()
    try {
      // Checked now, not at discovery: `codegraph init` over an index that
      // someone else created meanwhile exits 0 without syncing.
      await cli.run(r.init && !hasIndex(root) ? ['init', root] : ['sync', '-q', root])
      const now = Date.now()
      Object.assign(r.status, { state: 'ok', lastSyncAt: now, durationMs: now - started, error: undefined })
      r.init = false
      r.failures = 0
      clearTimeout(r.retry)
    } catch (err) {
      Object.assign(r.status, { state: 'error', durationMs: Date.now() - started, error: errorMessage(err) })
      if (!fs.existsSync(root)) untrack(root)
      else if (roots.get(root) === r) {
        // Another writer holding codegraph's lock is the usual cause. One timer
        // per checkout, so each failure pushes the retry further out.
        clearTimeout(r.retry)
        r.retry = setTimeout(() => request(root, false), Math.min(retryMs * 2 ** r.failures, reconcileIntervalMs))
        r.failures++
      }
    } finally {
      running.delete(root)
      const current = roots.get(root)
      if (current?.dirty !== undefined) {
        const urgent = current.dirty
        current.dirty = undefined
        request(root, urgent)
      }
      pump()
    }
  }

  function schedule(root: string): void {
    const r = roots.get(root)!
    const now = Date.now()
    const firstAt = r.debounce?.firstAt ?? now
    const wait = Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now))
    clearTimeout(r.debounce?.timer)
    const timer = setTimeout(() => {
      r.debounce = undefined
      request(root, true)
    }, wait)
    r.debounce = { timer, firstAt }
  }

  /** The deepest tracked checkout that holds `p`. */
  function ownerOf(p: string): string | undefined {
    let owner: string | undefined
    for (const root of roots.keys()) if (isWithin(root, p) && root.length > (owner?.length ?? 0)) owner = root
    return owner
  }

  /** A path up to MAX_DEPTH below an org root may be a checkout that appeared or went away. */
  function isCheckoutLevel(fullPath: string): boolean {
    return opts.getOrgRoots().some((orgRoot) => {
      const rel = path.relative(orgRoot, fullPath)
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep).length <= MAX_DEPTH
    })
  }

  function onFileEvent(event: BusEvent): void {
    const fullPath = (event.payload as { fullPath?: unknown } | undefined)?.fullPath
    if (typeof fullPath !== 'string') return
    const alias = aliases.find(([from]) => isWithin(from, fullPath))
    const real = alias ? alias[1] + fullPath.slice(alias[0].length) : fullPath
    if (event.type === 'file.deleted' && roots.has(real)) return scheduleRediscover()
    const root = ownerOf(real)
    if (root) schedule(root)
    else if (isCheckoutLevel(fullPath)) scheduleRediscover()
  }

  function scheduleRediscover(): void {
    if (stopped || rediscoverTimer) return
    rediscoverTimer = setTimeout(() => {
      rediscoverTimer = undefined
      void rediscover()
    }, rediscoverDelayMs)
  }

  /** Queues a discovery pass after any in flight; calls made while one waits share it. */
  function rediscover(): Promise<void> {
    if (!discoveryQueued) {
      discoveryQueued = true
      discovery = discovery.then(() => {
        discoveryQueued = false
        return discoverPass()
      })
    }
    return discovery
  }

  async function discoverPass(): Promise<void> {
    if (!isActive()) return
    try {
      const orgRoots = opts.getOrgRoots()
      aliases = orgRoots
        .map((o): [string, string] => [path.resolve(o), resolveReal(o)])
        .filter(([from, to]) => from !== to)
      const found = await discover(orgRoots)
      if (stopped) return
      const wanted = new Set([...found.indexed, ...found.uninitialized])
      for (const root of roots.keys()) if (!wanted.has(root)) untrack(root)
      for (const root of found.indexed) {
        if (roots.has(root)) continue
        track(root)
        request(root, false) // catch up on whatever changed while unwatched
      }
      for (const root of found.uninitialized) {
        const r = roots.get(root) ?? track(root)
        if (r.init) continue // a failed init retries on its own backoff
        r.init = true
        request(root, true)
      }
    } catch (err) {
      console.error('[code-index] discovery failed:', errorMessage(err))
    }
  }

  return {
    async start() {
      if (optedOut) return
      version = await cli.version()
      if (!isActive()) return
      unsubscribes.push(opts.bus.on('file.changed', onFileEvent), opts.bus.on('file.deleted', onFileEvent))
      for (const type of STRUCTURAL_EVENTS) unsubscribes.push(opts.bus.on(type, scheduleRediscover))
      intervals.push(
        setInterval(() => {
          for (const root of roots.keys()) request(root, false)
        }, reconcileIntervalMs),
        setInterval(() => void rediscover(), opts.rediscoverIntervalMs ?? 5 * 60_000)
      )
      for (const t of intervals) t.unref()
      await rediscover()
    },

    stop() {
      stopped = true
      for (const off of unsubscribes) off()
      for (const t of intervals) clearInterval(t)
      clearTimeout(rediscoverTimer)
      for (const root of roots.keys()) untrack(root)
    },

    status() {
      const reason = optedOut
        ? 'disabled by CODEGRAPH_INDEX=off'
        : version === null
          ? 'codegraph not found on PATH'
          : undefined
      return {
        enabled: isActive(),
        ...(version ? { version } : {}),
        ...(reason ? { reason } : {}),
        roots: [...roots.values()].map((r) => ({ ...r.status })).sort((a, b) => a.root.localeCompare(b.root))
      }
    },

    health() {
      const list = [...roots.values()].map((r) => r.status)
      const errors = list.filter((r) => r.state === 'error').length
      const synced = list.flatMap((r) => (r.lastSyncAt ? [r.lastSyncAt] : []))
      return {
        status: optedOut ? 'off' : version === null ? 'down' : errors > 0 ? 'degraded' : 'ok',
        version: version ?? '',
        roots: list.length,
        errors,
        lastSyncAt: synced.length > 0 ? Math.max(...synced) : null
      }
    },

    sync(root) {
      if (root === undefined) {
        for (const r of roots.keys()) request(r, true)
        return true
      }
      const resolved = resolveReal(root)
      if (!roots.has(resolved)) return false
      request(resolved, true)
      return true
    },

    rediscover
  }
}

function resolveReal(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { createEventBus, type EventBus } from '@sovereign/core'
import { createCodeIndex, type CodeIndex, type CodeIndexOptions } from './code-index.js'
import type { CodegraphCli } from './cli.js'
import { discoverRoots, type DiscoveredRoots } from './discover.js'
import { createCodeIndexRouter } from './routes.js'

let tmp: string
let org: string
let bus: EventBus
let index: CodeIndex | undefined

interface Call {
  args: string[]
  resolve: () => void
  reject: (err: Error) => void
}

/** A codegraph CLI whose jobs finish only when the test says so. */
function fakeCli(version: string | null = '1.5.0') {
  const calls: Call[] = []
  const cli: CodegraphCli = {
    version: async () => version,
    run: (args) => new Promise<void>((resolve, reject) => calls.push({ args, resolve, reject }))
  }
  /** Finish every running job and let the queue start the next ones. */
  const drain = async () => {
    for (let i = 0; i < 20 && calls.some((c) => !done.has(c)); i++) {
      for (const c of calls) if (!done.has(c)) finish(c)
      await vi.advanceTimersByTimeAsync(0)
    }
  }
  const done = new Set<Call>()
  const finish = (c: Call, err?: Error) => {
    done.add(c)
    if (err) c.reject(err)
    else c.resolve()
  }
  const open = () => calls.filter((c) => !done.has(c))
  /** The `codegraph` arguments of every job so far, and of those still running. */
  const syncs = () => calls.map((c) => c.args.join(' '))
  const running = () => open().map((c) => c.args.join(' '))
  return { cli, drain, finish, open, syncs, running }
}

function dir(rel: string): string {
  const p = path.join(org, rel)
  fs.mkdirSync(p, { recursive: true })
  return p
}

function start(
  found: DiscoveredRoots | (() => DiscoveredRoots),
  cli: CodegraphCli,
  extra: Partial<CodeIndexOptions> = {}
): { index: CodeIndex; discover: ReturnType<typeof vi.fn> } {
  const discover = vi.fn(async () => (typeof found === 'function' ? found() : found))
  index = createCodeIndex({
    bus,
    getOrgRoots: () => [org],
    cli,
    discover,
    debounceMs: 100,
    maxWaitMs: 1_000,
    rediscoverDelayMs: 50,
    retryMs: 1_000,
    ...extra
  })
  return { index, discover }
}

function change(fullPath: string, type: 'file.changed' | 'file.deleted' = 'file.changed'): void {
  bus.emit({
    type,
    timestamp: new Date().toISOString(),
    source: 'files',
    payload: { path: path.relative(org, fullPath), fullPath, root: org }
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-')))
  org = path.join(tmp, 'org')
  bus = createEventBus(path.join(tmp, 'data'))
})

afterEach(() => {
  index?.stop()
  index = undefined
  vi.useRealTimers()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('code index', () => {
  it('catches up every checkout at start, then syncs once per burst of changes', async () => {
    const a = dir('a')
    const b = dir('b')
    const fake = fakeCli()
    const { index } = start({ indexed: [a, b], uninitialized: [] }, fake.cli)
    await index.start()
    expect(fake.syncs()).toEqual([`sync -q ${a}`, `sync -q ${b}`])
    await fake.drain()

    for (let i = 0; i < 5; i++) {
      change(path.join(a, `f${i}.ts`))
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(200)
    expect(fake.syncs().slice(2)).toEqual([`sync -q ${a}`])
    await fake.drain()
    expect(index.status().roots.map((r) => r.state)).toEqual(['ok', 'ok'])
  })

  it('gives a changed path to the deepest checkout that holds it', async () => {
    const main = dir('app')
    const wt = dir('app/.worktrees/fix')
    const sibling = dir('app-feat') // shares a string prefix with app
    const fake = fakeCli()
    const { index } = start({ indexed: [main, wt, sibling], uninitialized: [] }, fake.cli)
    await index.start()
    await fake.drain()

    change(path.join(wt, 'src/x.ts'))
    change(path.join(sibling, 'y.ts'))
    await vi.advanceTimersByTimeAsync(150)
    expect(fake.running()).toEqual([`sync -q ${wt}`, `sync -q ${sibling}`])
  })

  it('maps changes under a symlinked org root onto the real checkout', async () => {
    const a = dir('a')
    fs.mkdirSync(path.join(a, '.codegraph'))
    fs.writeFileSync(path.join(a, '.codegraph', 'codegraph.db'), '')
    const link = path.join(tmp, 'link') // e.g. ~/workspaces on another disk
    fs.symlinkSync(org, link)
    const fake = fakeCli()
    const { index } = start({ indexed: [], uninitialized: [] }, fake.cli, {
      getOrgRoots: () => [link],
      discover: discoverRoots
    })
    await index.start()
    await fake.drain()
    expect(index.status().roots.map((r) => r.root)).toEqual([a])

    // The watcher reports paths under the org root as configured.
    change(path.join(link, 'a', 'x.ts'))
    await vi.advanceTimersByTimeAsync(150)
    expect(fake.running()).toEqual([`sync -q ${a}`])
  })

  it('syncs at least every maxWaitMs while writes keep coming', async () => {
    const a = dir('a')
    const fake = fakeCli()
    const { index } = start({ indexed: [a], uninitialized: [] }, fake.cli)
    await index.start()
    await fake.drain()

    for (let i = 0; i < 40; i++) {
      change(path.join(a, 'log.ts'))
      await vi.advanceTimersByTimeAsync(80)
      await fake.drain()
    }
    const syncs = fake.syncs().length - 1
    expect(syncs).toBeGreaterThanOrEqual(3) // 3.2 s of writes, 1 s cap
    expect(syncs).toBeLessThanOrEqual(4)
  })

  it('runs a checkout again when it changes during its sync', async () => {
    const a = dir('a')
    const fake = fakeCli()
    const { index } = start({ indexed: [a], uninitialized: [] }, fake.cli)
    await index.start()
    await fake.drain()

    change(path.join(a, 'x.ts'))
    await vi.advanceTimersByTimeAsync(150)
    expect(fake.open()).toHaveLength(1)
    change(path.join(a, 'y.ts'))
    await vi.advanceTimersByTimeAsync(150)
    expect(fake.open()).toHaveLength(1) // never two jobs on one checkout

    fake.finish(fake.open()[0])
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.running()).toEqual([`sync -q ${a}`])
  })

  it('puts change-driven syncs ahead of background catch-up', async () => {
    const [a, b, c] = [dir('a'), dir('b'), dir('c')]
    const fake = fakeCli()
    const { index } = start({ indexed: [a, b, c], uninitialized: [] }, fake.cli, { concurrency: 1 })
    await index.start()
    expect(fake.syncs()).toEqual([`sync -q ${a}`]) // b and c wait in the background queue

    change(path.join(c, 'x.ts'))
    await vi.advanceTimersByTimeAsync(150)
    fake.finish(fake.open()[0])
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.running()).toEqual([`sync -q ${c}`])
  })

  it('creates an index for a new worktree when the worktrees module reports it', async () => {
    const main = dir('app')
    const wt = dir('app-feat')
    let found: DiscoveredRoots = { indexed: [main], uninitialized: [] }
    const fake = fakeCli()
    const { index } = start(() => found, fake.cli)
    await index.start()
    await fake.drain()

    found = { indexed: [main], uninitialized: [wt] }
    bus.emit({ type: 'worktree.created', timestamp: new Date().toISOString(), source: 'worktrees', payload: {} })
    await vi.advanceTimersByTimeAsync(100)
    expect(fake.running()).toEqual([`init ${wt}`])
  })

  it('rediscovers when a directory appears near the top of an org root', async () => {
    const a = dir('a')
    const fake = fakeCli()
    const { index, discover } = start({ indexed: [a], uninitialized: [] }, fake.cli)
    await index.start()
    await fake.drain()
    expect(discover).toHaveBeenCalledTimes(1)

    change(path.join(dir('new-worktree'), '.'))
    change(path.join(dir('x/y/z'), 'deep.ts')) // too deep to be a checkout
    await vi.advanceTimersByTimeAsync(100)
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('drops a checkout once its directory is gone', async () => {
    const a = dir('a')
    const b = dir('b')
    let found: DiscoveredRoots = { indexed: [a, b], uninitialized: [] }
    const fake = fakeCli()
    const { index } = start(() => found, fake.cli)
    await index.start()
    await fake.drain()

    fs.rmSync(a, { recursive: true })
    found = { indexed: [b], uninitialized: [] }
    change(a, 'file.deleted')
    await vi.advanceTimersByTimeAsync(100)
    expect(index.status().roots.map((r) => r.root)).toEqual([b])

    // A sync that fails because the directory vanished also drops it.
    change(path.join(b, 'x.ts'))
    await vi.advanceTimersByTimeAsync(150)
    fs.rmSync(b, { recursive: true })
    fake.finish(fake.open()[0], new Error('ENOENT'))
    await vi.advanceTimersByTimeAsync(0)
    expect(index.status().roots).toEqual([])
  })

  it('retries a failed sync with backoff and reports it meanwhile', async () => {
    const a = dir('a')
    const fake = fakeCli()
    const { index } = start({ indexed: [a], uninitialized: [] }, fake.cli)
    await index.start()
    fake.finish(fake.open()[0], new Error('CodeGraph file lock held by another process'))
    await vi.advanceTimersByTimeAsync(0)

    expect(index.status().roots[0]).toMatchObject({ state: 'error', error: expect.stringContaining('lock') })
    expect(index.health()).toMatchObject({ status: 'degraded', errors: 1 })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.open()).toHaveLength(1)
    await fake.drain()
    expect(index.health()).toMatchObject({ status: 'ok', errors: 0, roots: 1 })
  })

  it('keeps one retry pending per checkout, however often it fails', async () => {
    const a = dir('a')
    const runs: string[] = []
    const cli: CodegraphCli = {
      version: async () => '1.5.0',
      run: async (args) => {
        runs.push(args.join(' '))
        throw new Error('CodeGraph file lock held by another process')
      }
    }
    const { index } = start({ indexed: [a], uninitialized: [] }, cli)
    await index.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 4; i++) {
      index.sync(a)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(runs).toHaveLength(5)

    // Five failures back off to one retry 16 s out, not five retries.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(runs).toHaveLength(6)
  })

  it('drops the pending retry once a sync succeeds', async () => {
    const a = dir('a')
    const fake = fakeCli()
    const { index } = start({ indexed: [a], uninitialized: [] }, fake.cli)
    await index.start()
    fake.finish(fake.open()[0], new Error('locked'))
    await vi.advanceTimersByTimeAsync(0)

    index.sync(a)
    await fake.drain()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fake.syncs()).toHaveLength(2)
  })

  it('keeps creating a worktree index until one exists', async () => {
    const wt = dir('app-wt')
    const fake = fakeCli()
    const { index } = start({ indexed: [], uninitialized: [wt] }, fake.cli)
    await index.start()
    expect(fake.syncs()).toEqual([`init ${wt}`])

    // Changed during an init that fails: the re-run is another init.
    change(path.join(wt, 'x.ts'))
    await vi.advanceTimersByTimeAsync(150)
    fake.finish(fake.open()[0], new Error('boom'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.running()).toEqual([`init ${wt}`])

    // Changed after a failed init: still an init.
    fake.finish(fake.open()[0], new Error('boom'))
    await vi.advanceTimersByTimeAsync(0)
    change(path.join(wt, 'y.ts'))
    await vi.advanceTimersByTimeAsync(150)
    expect(fake.running()).toEqual([`init ${wt}`])
  })

  it('syncs a worktree whose index appeared while its init waited', async () => {
    const a = dir('a')
    const wt = dir('a-wt')
    const fake = fakeCli()
    const { index } = start({ indexed: [a], uninitialized: [wt] }, fake.cli, { concurrency: 1 })
    await index.start()
    expect(fake.syncs()).toEqual([`sync -q ${a}`])

    // Someone else ran `codegraph init`; a second init exits 0 without syncing.
    fs.mkdirSync(path.join(wt, '.codegraph'))
    fs.writeFileSync(path.join(wt, '.codegraph', 'codegraph.db'), '')
    fake.finish(fake.open()[0])
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.running()).toEqual([`sync -q ${wt}`])
  })

  it('retries a failed init on its backoff, not on every discovery pass', async () => {
    const wt = dir('app-wt')
    const fake = fakeCli()
    const { index, discover } = start({ indexed: [], uninitialized: [wt] }, fake.cli)
    await index.start()
    fake.finish(fake.open()[0], new Error('boom'))
    await vi.advanceTimersByTimeAsync(0)

    for (let i = 0; i < 3; i++) {
      bus.emit({ type: 'worktree.created', timestamp: new Date().toISOString(), source: 'worktrees', payload: {} })
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(discover).toHaveBeenCalledTimes(4)
    expect(fake.syncs()).toEqual([`init ${wt}`])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.syncs()).toEqual([`init ${wt}`, `init ${wt}`])
  })

  it('resolves rediscover() after a pass that saw the call', async () => {
    const a = dir('a')
    const b = dir('b')
    let found: DiscoveredRoots = { indexed: [a], uninitialized: [] }
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let passes = 0
    const discover = async () => {
      const snapshot = found
      if (++passes === 2) await held
      return snapshot
    }
    const { index } = start(found, fakeCli().cli, { discover })
    await index.start()

    void index.rediscover() // pass 2, held with the old snapshot
    found = { indexed: [a, b], uninitialized: [] }
    const next = index.rediscover()
    release()
    await next
    expect(index.status().roots.map((r) => r.root)).toEqual([a, b])
  })

  it('leaves no timers behind once stopped, even with a job in flight', async () => {
    const a = dir('a')
    const fake = fakeCli()
    const { index } = start({ indexed: [a], uninitialized: [] }, fake.cli)
    await index.start()
    fake.finish(fake.open()[0], new Error('locked')) // a retry is pending
    await vi.advanceTimersByTimeAsync(0)
    index.sync(a)
    change(path.join(a, 'x.ts')) // a debounce is pending

    index.stop()
    fake.finish(fake.open()[0], new Error('locked')) // the job in flight fails after stop
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stays down when codegraph is missing, and off when opted out', async () => {
    const missing = start({ indexed: [dir('a')], uninitialized: [] }, fakeCli(null).cli)
    await missing.index.start()
    expect(missing.index.status()).toMatchObject({ enabled: false, reason: 'codegraph not found on PATH' })
    expect(missing.index.health().status).toBe('down')
    expect(missing.discover).not.toHaveBeenCalled()
    missing.index.stop()

    const off = start({ indexed: [dir('a')], uninitialized: [] }, fakeCli().cli, { enabled: false })
    await off.index.start()
    expect(off.index.health().status).toBe('off')
    expect(off.discover).not.toHaveBeenCalled()
  })

  it('serves status and queues syncs over HTTP', async () => {
    const a = dir('a')
    const fake = fakeCli()
    const { index } = start({ indexed: [a], uninitialized: [] }, fake.cli)
    await index.start()
    await fake.drain()
    const app = express().use(createCodeIndexRouter(index, (_req, _res, next) => next()))

    const status = await request(app).get('/api/code-index')
    expect(status.body).toMatchObject({ enabled: true, version: '1.5.0', roots: [{ root: a, state: 'ok' }] })
    expect((await request(app).post('/api/code-index/sync').send({ root: a })).status).toBe(202)
    expect((await request(app).post('/api/code-index/sync').send({ root: '/nope' })).status).toBe(404)
    expect((await request(app).post('/api/code-index/sync').send({ root: 42 })).status).toBe(400)
    expect((await request(app).post('/api/code-index/sync').send({})).status).toBe(202)
  })
})

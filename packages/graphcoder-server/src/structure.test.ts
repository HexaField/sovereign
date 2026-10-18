import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import type { GraphSource } from '@sovereign/graphcoder-core'
import { createCodegraphIndexer, type Indexer } from './indexer.js'
import { createGraphcoderRouter } from './routes.js'
import { createGraphcoderService, UnknownRepoError } from './service.js'
import { createStructureStore } from './structure.js'
import { cliGitPort, fixtureWithChange, hasCodegraphCli } from './test-fixture.js'

let fixture: ReturnType<typeof fixtureWithChange> | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

const listing = (repos: string[]): GraphSource => ({
  list: async () => repos,
  open: () => Promise.reject(new Error('structure never opens the checkout index'))
})

/** The real indexer, counting runs and how many overlap */
function countingIndexer(inner: Indexer = createCodegraphIndexer()) {
  let active = 0
  const stats = { runs: 0, maxActive: 0 }
  const indexer: Indexer = {
    index: async (dir) => {
      stats.runs++
      stats.maxActive = Math.max(stats.maxActive, ++active)
      try {
        await inner.index(dir)
      } finally {
        active--
      }
    }
  }
  return { indexer, stats }
}

function setup() {
  fixture = fixtureWithChange()
  const checkouts = path.join(fixture.root, 'checkouts')
  const cacheDir = path.join(fixture.root, 'cache')
  const git = cliGitPort(checkouts)
  const counting = countingIndexer()
  const service = createGraphcoderService(
    { graph: listing([fixture.repo]), git },
    { cacheDir, indexer: counting.indexer }
  )
  const worktrees = () =>
    execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture!.repo, encoding: 'utf-8' })
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
  return { fx: fixture, git, service, stats: counting.stats, cacheDir, worktrees }
}

describe.skipIf(!hasCodegraphCli)('the structure of a change', () => {
  it('computes symbols, modules, reach and tests from both sides, then releases the checkout', async () => {
    const { fx, git, service, worktrees } = setup()
    const s = await service.structureOf(fx.repo, 'main', 'feature')
    expect(s.base).toBe(fx.main)
    expect(s.head).toBe(fx.feature)
    expect(s.symbols.added.map((r) => r.qualifiedName)).toEqual(['negate'])
    expect(s.symbols.removed.map((r) => r.qualifiedName).sort()).toEqual(['Point::scale', 'multiply'])
    // Point lost a method (and the blank line before it, a line of its own body)
    expect(s.symbols.modified.map((r) => r.qualifiedName)).toEqual(['Point', 'add'])
    expect(s.modules).toEqual([{ module: 'src', label: 'src', added: 1, removed: 2, modified: 2 }])
    // negate – math.ts – add – translate (calls add) – Point (holds translate)
    expect([s.reach, s.parts]).toEqual([4, 1])
    expect(s.tests).toEqual([{ id: 'src/math.test.ts::math adds', file: 'src/math.test.ts', depth: 1 }])
    expect(s.violations).toEqual([])
    expect(git.calls).toEqual(['fetch main feature', `checkout ${fx.main}`, `switch ${fx.feature}`, 'release'])
    expect(worktrees()).toHaveLength(1)
  })

  it('answers a repeated request from the cache, also in a new service over the same directory', async () => {
    const { fx, service, stats, cacheDir } = setup()
    const first = await service.structureOf(fx.repo, 'main', 'feature')
    expect(stats.runs).toBe(2)
    expect(await service.structureOf(fx.repo, fx.main, fx.feature)).toEqual(first)
    expect(stats.runs).toBe(2)
    expect(await service.cachedStructure(fx.repo, 'main', 'feature')).toEqual({ state: 'ready', structure: first })
    const restarted = createGraphcoderService(
      { graph: listing([fx.repo]), git: cliGitPort(path.join(fx.root, 'other')) },
      { cacheDir, indexer: { index: () => Promise.reject(new Error('indexed again')) } }
    )
    expect(await restarted.structureOf(fx.repo, 'main', 'feature')).toEqual(first)
  })

  it('computes one change at a time and joins a request already queued', async () => {
    const { fx, service, stats } = setup()
    const [a, b, c] = await Promise.all([
      service.structureOf(fx.repo, 'main', 'feature'),
      service.structureOf(fx.repo, 'main', 'feature'),
      service.structureOf(fx.repo, `${fx.feature}~1`, 'feature')
    ])
    expect(b).toBe(a)
    expect(c.symbols.modified.map((r) => r.qualifiedName)).toEqual(['Point', 'add'])
    expect(stats.maxActive).toBe(1)
    // the third names the same merge base and head through other refs: computed once, then read from the cache
    expect(stats.runs).toBe(2)
  })

  it('reports computing while queued, then a failure, and releases the checkout when indexing fails', async () => {
    fixture = fixtureWithChange()
    const fx = fixture
    const git = cliGitPort(path.join(fx.root, 'checkouts'))
    let fail!: (err: Error) => void
    const store = createStructureStore({
      git,
      cacheDir: path.join(fx.root, 'cache'),
      indexer: { index: () => new Promise((_, reject) => (fail = reject)) }
    })
    expect(await store.cachedStructure(fx.repo, 'main', 'feature')).toEqual({ state: 'none' })
    const job = store.structureOf(fx.repo, 'main', 'feature')
    expect(await store.cachedStructure(fx.repo, 'main', 'feature')).toEqual({ state: 'computing' })
    while (!fail) await new Promise((r) => setTimeout(r, 5))
    fail(new Error('index broke'))
    await expect(job).rejects.toThrow('index broke')
    expect(await store.cachedStructure(fx.repo, 'main', 'feature')).toEqual({ state: 'failed', error: 'index broke' })
    expect(git.calls[git.calls.length - 1]).toBe('release')
    expect(fs.readdirSync(path.join(fx.root, 'checkouts'))).toEqual([])
  })

  it('fails on refs the checkout cannot resolve, without a checkout', async () => {
    const { fx, git, service } = setup()
    await expect(service.structureOf(fx.repo, 'main', 'no-such-branch')).rejects.toThrow(
      /no commit for main or no-such-branch/
    )
    expect(git.calls).toEqual(['fetch main no-such-branch'])
  })

  it('serves both routes', async () => {
    const { fx, service } = setup()
    const app = express().use(createGraphcoderRouter(service, (_req, _res, next) => next()))
    const before = await request(app)
      .get('/api/graphcoder/structure/cached')
      .query({ path: fx.repo, base: 'main', head: 'feature' })
    expect(before.body).toEqual({ state: 'none' })
    const res = await request(app)
      .get('/api/graphcoder/structure')
      .query({ path: fx.repo, base: 'main', head: 'feature' })
    expect(res.status).toBe(200)
    expect(res.body.symbols.added).toHaveLength(1)
    const after = await request(app)
      .get('/api/graphcoder/structure/cached')
      .query({ path: fx.repo, base: 'main', head: 'feature' })
    expect(after.body).toEqual({ state: 'ready', structure: res.body })
  })
})

describe('structure routes refuse what they must', () => {
  const service = createGraphcoderService(
    { graph: listing(['/srv/repo']), git: cliGitPort('/nonexistent') },
    { cacheDir: '/nonexistent/cache', indexer: { index: () => Promise.reject(new Error('indexed')) } }
  )
  const app = (denied = false) =>
    express().use(
      createGraphcoderRouter(service, (_req, res, next) =>
        denied ? void res.status(401).json({ error: 'auth' }) : next()
      )
    )

  it('needs a path and two refs that cannot pass for options', async () => {
    for (const route of ['/api/graphcoder/structure', '/api/graphcoder/structure/cached']) {
      expect((await request(app()).get(route).query({ base: 'a', head: 'b' })).status).toBe(400)
      expect((await request(app()).get(route).query({ path: '/srv/repo', base: 'a' })).status).toBe(400)
      expect((await request(app()).get(route).query({ path: '/srv/repo', base: '--output=x', head: 'b' })).status).toBe(
        400
      )
      expect((await request(app()).get(route).query({ path: '/srv/repo', base: 'a b', head: 'b' })).status).toBe(400)
    }
  })

  it('refuses a checkout the GraphSource does not list', async () => {
    await expect(service.structureOf('/etc', 'a', 'b')).rejects.toBeInstanceOf(UnknownRepoError)
    const res = await request(app())
      .get('/api/graphcoder/structure/cached')
      .query({ path: '/etc', base: 'a', head: 'b' })
    expect(res.status).toBe(404)
  })

  it('runs the auth middleware', async () => {
    const q = { path: '/srv/repo', base: 'a', head: 'b' }
    expect((await request(app(true)).get('/api/graphcoder/structure').query(q)).status).toBe(401)
    expect((await request(app(true)).get('/api/graphcoder/structure/cached').query(q)).status).toBe(401)
  })
})

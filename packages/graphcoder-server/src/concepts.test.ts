import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import type { GraphSource } from '@sovereign/graphcoder-core'
import { openCodegraphIndex } from './codegraph.js'
import { UnknownRefError } from './concepts.js'
import { createCodegraphIndexer, type Indexer } from './indexer.js'
import { createGraphcoderRouter } from './routes.js'
import { createGraphcoderService, UnknownRepoError } from './service.js'
import { cliGitPort, fixtureWithConcepts, hasCodegraphCli } from './test-fixture.js'

let fixture: ReturnType<typeof fixtureWithConcepts> | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup() {
  fixture = fixtureWithConcepts()
  const fx = fixture
  const opened: string[] = []
  const graph: GraphSource = {
    list: async () => [fx.repo],
    open: async (repo) => {
      opened.push(repo)
      return openCodegraphIndex(repo)
    }
  }
  const git = cliGitPort(path.join(fx.root, 'checkouts'))
  const inner = createCodegraphIndexer()
  const stats = { runs: 0 }
  const indexer: Indexer = {
    index: async (dir) => {
      stats.runs++
      await inner.index(dir)
    }
  }
  const cacheDir = path.join(fx.root, 'cache')
  const service = createGraphcoderService({ graph, git }, { cacheDir, indexer })
  const app = express().use(createGraphcoderRouter(service, (_req, _res, next) => next()))
  return { fx, git, service, stats, opened, app, cacheDir }
}

describe.skipIf(!hasCodegraphCli)('the concept map of a checkout', () => {
  it('reads HEAD in place: the tree, its owners, the checks and the dependencies between concepts', async () => {
    const { fx, git, service, opened } = setup()
    const r = await service.concepts(fx.repo)
    expect(r.path).toBe(fx.repo)
    expect(r.sha).toBe(fx.main)
    expect(r.dir).toBe('mental-models')
    expect(r.pages.map((p) => [p.id, p.title, p.files, p.symbols, p.unresolved])).toEqual([
      ['', 'Tiny', 1, 0, []],
      ['math', 'Math', 1, 2, []],
      ['geometry', 'Geometry', 1, 1, ['Vector']]
    ])
    expect(r.pages[2].model).toBe('A point moves by adding to its coordinates.')
    expect(r.coverage).toEqual({ files: 3, covered: 3, uncovered: [] })
    expect(r.stale).toEqual([{ page: 'geometry', path: 'src/gone.ts' }])
    expect(r.shared).toEqual([])
    // Point calls add and multiply; index.ts (the root's) re-exports both pages' code
    expect(r.dependencies).toEqual([
      { from: 'geometry', to: 'math', edges: expect.any(Number) },
      { from: '', to: 'geometry', edges: 1 },
      { from: '', to: 'math', edges: 1 }
    ])
    expect(opened).toEqual([fx.repo])
    expect(git.calls).toEqual([])
  })

  it('reads another commit from a temporary worktree, once, and releases it', async () => {
    const { fx, git, service, stats } = setup()
    const r = await service.concepts(fx.repo, 'change')
    expect(r.sha).toBe(fx.change)
    expect(r.pages.map((p) => p.id)).toEqual(['', 'math', 'geometry', 'vectors'])
    expect(r.pages.find((p) => p.id === 'math')!.symbols).toBe(2)
    expect(git.calls).toEqual([`checkout ${fx.change}`, 'release'])
    expect(await service.concepts(fx.repo, fx.change)).toEqual(r)
    expect(stats.runs).toBe(1)
    expect(fs.readdirSync(path.join(fx.root, 'checkouts'))).toEqual([])
  })

  it('reports a commit without a tree as all uncovered', async () => {
    const { fx, service } = setup()
    const r = await service.concepts(fx.repo, fx.before)
    expect(r.pages).toEqual([])
    expect(r.coverage.covered).toBe(0)
    expect(r.coverage.files).toBe(r.coverage.uncovered.reduce((a, u) => a + u.files, 0))
  })

  it('takes the tree folder from .graphcoder/config.json', async () => {
    const { fx, service } = setup()
    fs.mkdirSync(path.join(fx.repo, '.graphcoder'), { recursive: true })
    fs.writeFileSync(path.join(fx.repo, '.graphcoder/config.json'), '{ "conceptDir": "docs/concepts" }')
    const r = await service.concepts(fx.repo)
    expect([r.dir, r.pages]).toEqual(['docs/concepts', []])
  })

  it('serves the route, and refuses unknown refs and checkouts', async () => {
    const { fx, service, app } = setup()
    const res = await request(app).get('/api/graphcoder/concepts').query({ path: fx.repo })
    expect(res.status).toBe(200)
    expect(res.body.pages).toHaveLength(3)
    await expect(service.concepts(fx.repo, 'no-such-branch')).rejects.toBeInstanceOf(UnknownRefError)
    expect((await request(app).get('/api/graphcoder/concepts').query({ path: fx.repo, ref: 'nope' })).status).toBe(404)
    await expect(service.concepts('/etc')).rejects.toBeInstanceOf(UnknownRepoError)
    expect((await request(app).get('/api/graphcoder/concepts').query({ path: '/etc' })).status).toBe(404)
    expect((await request(app).get('/api/graphcoder/concepts').query({ path: fx.repo, ref: '--all' })).status).toBe(400)
    expect((await request(app).get('/api/graphcoder/concepts')).status).toBe(400)
  })
})

describe.skipIf(!hasCodegraphCli)('the concept impact of a change', () => {
  it('maps changed symbols through each side’s tree and marks model shifts and their signals', async () => {
    const { fx, service } = setup()
    const s = await service.structureOf(fx.repo, 'main', 'change')
    expect(s.symbols.added.map((r) => [r.qualifiedName, r.concept])).toEqual([['negate', 'math']])
    expect(s.modules).toEqual([{ module: 'mental-models/math.md', label: 'Math', added: 1, removed: 0, modified: 0 }])
    expect(s.concepts?.summary).toBe('Shifts Geometry (1 changed), Vectors (1 new); touches Math (code only)')
    expect(s.concepts?.pages.map((p) => [p.id, p.page, p.signal, p.symbols.added])).toEqual([
      ['', undefined, undefined, 0],
      ['math', undefined, 'stale-page', 1],
      ['geometry', 'changed', 'docs-only', 0],
      ['vectors', 'added', 'docs-only', 0]
    ])
    expect(s.concepts?.pages[2]).toMatchObject({
      model: 'A point moves and scales.',
      before: { model: 'A point moves by adding to its coordinates.' }
    })
  })
})

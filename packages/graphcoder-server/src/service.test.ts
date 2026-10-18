import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitPort, GraphSource } from '@sovereign/graphcoder-core'
import { openCodegraphIndex } from './codegraph.js'
import { createGraphcoderRouter } from './routes.js'
import { createGraphcoderService, UnknownRepoError } from './service.js'
import { hasCodegraphCli, indexedFixture } from './test-fixture.js'

let fixture: ReturnType<typeof indexedFixture> | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

/** A GraphSource over a fixed list of checkouts, opening each index directly */
function sourceOf(repos: string[], opened: string[] = []): GraphSource {
  return {
    list: async () => repos,
    open: async (repo) => {
      if (!repos.includes(repo)) throw new Error(`not listed: ${repo}`)
      opened.push(repo)
      return openCodegraphIndex(repo)
    }
  }
}

/** P0 never reaches git; any call is a test failure */
const noGit: GitPort = {
  diffRefs: () => Promise.reject(new Error('git used')),
  checkout: () => Promise.reject(new Error('git used')),
  log: () => Promise.reject(new Error('git used'))
}

function app(service: ReturnType<typeof createGraphcoderService>, denied = false) {
  const a = express()
  a.use(
    createGraphcoderRouter(service, (_req, res, next) =>
      denied ? void res.status(401).json({ error: 'auth' }) : next()
    )
  )
  return a
}

describe.skipIf(!hasCodegraphCli)('graphcoder service and routes over an indexed fixture', () => {
  it('lists the checkouts it can open', async () => {
    fixture = indexedFixture()
    const service = createGraphcoderService({ graph: sourceOf([fixture.repo, '/srv/b', '/srv/a']), git: noGit })
    expect(await service.status()).toEqual({ enabled: true, repos: ['/srv/a', '/srv/b', fixture.repo].sort() })
    const res = await request(app(service)).get('/api/graphcoder/status')
    expect(res.status).toBe(200)
    expect(res.body.repos).toContain(fixture.repo)
  })

  it('returns node, edge and file counts, node kinds and the annotation count of a listed checkout', async () => {
    fixture = indexedFixture()
    const service = createGraphcoderService({ graph: sourceOf([fixture.repo]), git: noGit })
    const res = await request(app(service)).get('/api/graphcoder/repos/stats').query({ path: fixture.repo })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      path: fixture.repo,
      nodeCount: 10,
      edgeCount: expect.any(Number),
      fileCount: 3,
      nodesByKind: { class: 1, file: 3, function: 2, import: 1, method: 3 },
      annotations: 1
    })
    expect(res.body.edgeCount).toBeGreaterThan(0)
  })

  it('accepts an unnormalised spelling of a listed path', async () => {
    fixture = indexedFixture()
    const service = createGraphcoderService({ graph: sourceOf([fixture.repo]), git: noGit })
    const spelled = `${path.dirname(fixture.repo)}/./tiny-ts/`
    expect((await service.repoStats(spelled)).path).toBe(fixture.repo)
  })
})

describe('graphcoder routes refuse what they must', () => {
  it('opens nothing outside the listed checkouts', async () => {
    const opened: string[] = []
    const service = createGraphcoderService({ graph: sourceOf(['/srv/indexed'], opened), git: noGit })
    await expect(service.repoStats('/etc')).rejects.toBeInstanceOf(UnknownRepoError)
    await expect(service.repoStats('/srv/indexed/../../etc')).rejects.toBeInstanceOf(UnknownRepoError)
    const res = await request(app(service)).get('/api/graphcoder/repos/stats').query({ path: '/srv/other' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Not an indexed checkout/)
    expect(opened).toEqual([])
  })

  it('needs a path', async () => {
    const service = createGraphcoderService({ graph: sourceOf([]), git: noGit })
    expect((await request(app(service)).get('/api/graphcoder/repos/stats')).status).toBe(400)
    expect((await request(app(service)).get('/api/graphcoder/repos/stats?path=a&path=b')).status).toBe(400)
  })

  it('reports an index it cannot read as a server error', async () => {
    const service = createGraphcoderService({ graph: sourceOf(['/srv/no-index']), git: noGit })
    const res = await request(app(service)).get('/api/graphcoder/repos/stats').query({ path: '/srv/no-index' })
    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/No CodeGraph index/)
  })

  it('runs the auth middleware on every route', async () => {
    const service = createGraphcoderService({ graph: sourceOf([]), git: noGit })
    expect((await request(app(service, true)).get('/api/graphcoder/status')).status).toBe(401)
    expect((await request(app(service, true)).get('/api/graphcoder/repos/stats?path=/x')).status).toBe(401)
  })
})

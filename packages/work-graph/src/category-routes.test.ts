// Node categories through the service and its routes: the rules on the graph,
// the user's override (PUT /api/forge/nodes/:id/category, null clears it),
// rethink refused under a user or rule category, the category filter, and a
// restart through the meta store's snapshot.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, type WorkNode } from '@sovereign/core'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createForgeRouter } from './routes.js'
import { createForgeService, type ForgeService } from './service.js'
import { change, createFakeForge, createTestTaskPort, issue, type TestTaskPort } from './testing.js'

const WIDGET = 'acme-labs/widget'
const NOW = Date.parse('2026-10-16T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()
const nid = (n: number) => `github:github.com/${WIDGET}#${n}`

describe('node categories', () => {
  let tmp: string
  let port: TestTaskPort
  let service: ForgeService
  let app: express.Express

  function make() {
    const forge = createFakeForge()
    forge.put(change(WIDGET, 50, { title: 'fix: teeth slip', updatedAt: daysAgo(1) }))
    forge.put(change(WIDGET, 51, { title: 'Faster gears', updatedAt: daysAgo(1) }))
    forge.put(issue(WIDGET, 7, { title: 'Gears jam', labels: ['regression'], updatedAt: daysAgo(2) }))
    forge.branches.set(WIDGET, [{ name: 'dev', sha: 'd1' }])
    port = createTestTaskPort(path.join(tmp, 'tasks'))
    const widgetDir = path.join(tmp, 'acme', 'widget')
    const membranes = [{ id: 'acme', workspaceIds: ['acme-org'] }]
    service = createForgeService({
      dataDir: path.join(tmp, 'data'),
      config: () => ({ enabled: true, identities: { github: 'hex-agent' }, repos: { acme: [WIDGET] } }),
      scope: {
        getMembrane: (id) => membranes.find((m) => m.id === id),
        listMembranes: () => membranes,
        getOrg: (id) => (id === 'acme-org' ? { id, path: path.join(tmp, 'acme') } : undefined),
        listProjects: () => [{ id: 'widget', name: 'widget', repoPath: widgetDir }]
      },
      forgeRegistry: { forgeFor: () => forge },
      tasks: port,
      bus: createEventBus(path.join(tmp, 'bus')),
      threads: { createThread: async () => 'thread-1', sendToThread: async () => {}, presence: () => undefined },
      now: () => NOW,
      log: () => {}
    })
    app = express()
    app.use(createForgeRouter(service, (_req, _res, next) => next()))
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cat-'))
    const widgetDir = path.join(tmp, 'acme', 'widget')
    fs.mkdirSync(path.join(widgetDir, '.git'), { recursive: true })
    fs.writeFileSync(
      path.join(widgetDir, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:acme-labs/widget.git\n'
    )
    make()
  })
  afterEach(() => {
    service.stop()
    port.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const put = (n: number, body: object) =>
    request(app)
      .put(`/api/forge/nodes/${encodeURIComponent(nid(n))}/category`)
      .send({ membrane: 'acme', ...body })
  const nodesOf = async (q = ''): Promise<WorkNode[]> =>
    (await request(app).get(`/api/forge?membrane=acme${q}`)).body.nodes
  const catOf = async (n: number) => {
    const x = (await nodesOf()).find((y) => y.id === nid(n))!
    return [x.category, x.categorySource]
  }

  it('serves rule categories and leaves the rest uncategorised', async () => {
    await service.sync('acme')
    expect(await catOf(50)).toEqual(['bug', 'rule'])
    expect(await catOf(7)).toEqual(['bug', 'rule'])
    expect(await catOf(51)).toEqual([undefined, undefined])
  })

  it('PUT sets the user category over the rules, null clears it, and bad input is refused', async () => {
    await service.sync('acme')
    const res = await put(50, { category: 'future' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: nid(50), category: 'future', categorySource: 'user' })
    expect(await catOf(50)).toEqual(['future', 'user'])
    expect((await put(50, { category: null })).body).toMatchObject({ category: 'bug', categorySource: 'rule' })
    expect(await catOf(50)).toEqual(['bug', 'rule'])

    expect((await put(50, { category: 'later' })).status).toBe(400)
    expect((await put(50, {})).status).toBe(400)
    expect((await put(50, { category: 'bug', membrane: '' })).status).toBe(400)
    expect((await put(99, { category: 'bug' })).status).toBe(404)
  })

  it('user > rule > rethink: rethink fills only what the rules leave open and never overwrites the user', async () => {
    await service.sync('acme')
    // Uncategorised: rethink decides.
    expect(await service.setCategory('acme', nid(51), 'feature', 'rethink', 'faster for users')).toMatchObject({
      category: 'feature',
      categorySource: 'rethink'
    })
    // A rule already decides: refused.
    await expect(service.setCategory('acme', nid(50), 'feature', 'rethink')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('by the rules')
    })
    // The user wins over rethink; rethink is refused afterwards, and cannot clear.
    await put(51, { category: 'design' })
    expect(await catOf(51)).toEqual(['design', 'user'])
    await expect(service.setCategory('acme', nid(51), 'bug', 'rethink')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("user's choice")
    })
    await expect(service.setCategory('acme', nid(51), null, 'rethink')).rejects.toMatchObject({ status: 400 })
    // Clearing the user's choice brings rethink's back.
    await put(51, { category: null })
    expect(await catOf(51)).toEqual(['feature', 'rethink'])
  })

  it('filters by category in a view, and keeps categories across a restart', async () => {
    await service.sync('acme')
    await put(51, { category: 'feature' })
    await service.putViews('acme', [
      { id: 'bugs', membrane: 'acme', title: 'Bugs', repos: [], filters: { categories: ['bug'] } }
    ])
    const shown = async () =>
      (await nodesOf('&view=bugs'))
        .filter((n) => n.kind !== 'branch')
        .map((n) => n.id)
        .sort()
    expect(await shown()).toEqual([nid(50), nid(7)].sort())

    service.stop()
    port.dispose()
    make()
    await service.sync('acme')
    expect(await catOf(51)).toEqual(['feature', 'user'])
  })
})

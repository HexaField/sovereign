// The goal tree through the service and its routes: progress on graph()'s
// streams, placing a stream (one parent, cycles refused), moving a leaf.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, type WorkStream } from '@sovereign/core'
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

describe('goal tree', () => {
  let tmp: string
  let port: TestTaskPort
  let service: ForgeService
  let app: express.Express

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-tree-'))
    const widgetDir = path.join(tmp, 'acme', 'widget')
    fs.mkdirSync(path.join(widgetDir, '.git'), { recursive: true })
    fs.writeFileSync(
      path.join(widgetDir, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:acme-labs/widget.git\n'
    )
    const forge = createFakeForge()
    forge.put(change(WIDGET, 50, { updatedAt: daysAgo(1) }))
    forge.put(change(WIDGET, 51, { updatedAt: daysAgo(1), base: { branch: 'feat/50' } })) // stacked on #50
    forge.put(change(WIDGET, 30, { state: 'merged', updatedAt: daysAgo(3), closedAt: daysAgo(3) }))
    forge.put(change(WIDGET, 31, { state: 'closed', updatedAt: daysAgo(3), closedAt: daysAgo(3) }))
    forge.put(issue(WIDGET, 7, { updatedAt: daysAgo(2) }))
    forge.branches.set(WIDGET, [{ name: 'dev', sha: 'd1' }])
    port = createTestTaskPort(path.join(tmp, 'tasks'))
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
      threads: {
        createThread: async () => 'thread-1',
        sendToThread: async () => {},
        presence: () => undefined
      },
      now: () => NOW,
      log: () => {}
    })
    app = express()
    app.use(createForgeRouter(service, (_req, _res, next) => next()))
  })
  afterEach(() => {
    service.stop()
    port.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const streamsOf = async (q = ''): Promise<WorkStream[]> =>
    (await request(app).get(`/api/forge?membrane=acme${q}`)).body.workstreams
  const parent = (id: string, body: object) =>
    request(app)
      .post(`/api/forge/streams/${encodeURIComponent(id)}/parent`)
      .send({ membrane: 'acme', ...body })

  it('serves each stream’s progress over its subtree', async () => {
    await service.sync('acme')
    const goal = await service.createStream('acme', 'Closed beta')
    const node = await service.createStream('acme', 'Auth', goal.id)
    await service.addMember(node.id, nid(30), 'acme') // merged: done
    await service.addMember(node.id, nid(31), 'acme') // closed unmerged: cancelled, left out
    await service.addMember(node.id, nid(50), 'acme') // open
    await service.addMember(goal.id, nid(51), 'acme') // stacked on #50: blocked
    await service.addMember(goal.id, nid(7), 'acme') // open issue

    const s = await streamsOf()
    expect(s.find((w) => w.id === goal.id)).toMatchObject({ progress: { done: 1, total: 4, blocked: 1 } })
    expect(s.find((w) => w.id === node.id)).toMatchObject({
      parentId: goal.id,
      progress: { done: 1, total: 2, blocked: 0 }
    })
  })

  it('places a stream: under one parent, back to the top; self and cycles refused', async () => {
    await service.sync('acme')
    const goal = (await request(app).post('/api/forge/streams').send({ membrane: 'acme', name: 'Goal' })).body
    const a = (await request(app).post('/api/forge/streams').send({ membrane: 'acme', name: 'A' })).body
    const b = (await request(app).post('/api/forge/streams').send({ membrane: 'acme', name: 'B', parentId: a.id })).body

    // Moving B under Goal leaves A: one parent.
    const moved = await parent(b.id, { parentId: goal.id })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({ id: b.id, parentId: goal.id })
    expect((await port.get(b.id))!.parentIds).toEqual([goal.id])

    // A cycle (Goal under its own child) and a self-parent are refused; nothing moves.
    expect((await parent(goal.id, { parentId: b.id })).status).toBe(400)
    expect((await parent(b.id, { parentId: b.id })).status).toBe(400)
    expect((await port.get(goal.id))!.parentIds).toEqual([])

    // Bad bodies and unknown streams.
    expect((await parent(b.id, {})).status).toBe(400)
    expect((await parent(b.id, { parentId: 7 })).status).toBe(400)
    expect((await parent('task://nope', { parentId: null })).status).toBe(404)
    expect((await parent(b.id, { parentId: 'task://nope' })).status).toBe(404)

    // To the top level: a goal again.
    const top = await parent(b.id, { parentId: null })
    expect(top.status).toBe(200)
    expect(top.body).not.toHaveProperty('parentId')
    expect((await streamsOf()).find((w) => w.id === b.id)).not.toHaveProperty('parentId')
  })

  it('moves a leaf to another node through the members route (one owner)', async () => {
    await service.sync('acme')
    const a = await service.createStream('acme', 'A')
    const b = await service.createStream('acme', 'B')
    const add = (id: string) =>
      request(app)
        .post(`/api/forge/streams/${encodeURIComponent(id)}/members`)
        .send({ membrane: 'acme', nodeId: nid(7) })
    expect((await add(a.id)).status).toBe(200)
    expect((await add(b.id)).status).toBe(200)
    const node = (await request(app).get('/api/forge?membrane=acme')).body.nodes.find(
      (n: { id: string }) => n.id === nid(7)
    )
    expect(node.workstreams).toEqual([b.id])
  })
})

// Decisions through the forge service and its routes: open, list by status,
// edit, group many at once, and resolve many at once — each receiving thread
// gets ONE message holding all of its resolutions, unthreaded ones send
// nothing — plus a restart through the meta store's snapshot.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, type BusEvent, type Decision } from '@sovereign/core'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatResolutions } from './decisions.js'
import { createForgeRouter } from './routes.js'
import { createForgeService, type ForgeService } from './service.js'
import { createFakeForge, createTestTaskPort, type TestTaskPort } from './testing.js'

const NOW = Date.parse('2026-10-30T12:00:00Z')

describe('decisions', () => {
  let tmp: string
  let port: TestTaskPort
  let service: ForgeService
  let app: express.Express
  let sent: Array<{ threadId: string; text: string }>
  let failFor: string | null
  let events: BusEvent[]
  let clock: number

  function make() {
    port = createTestTaskPort(path.join(tmp, 'tasks'))
    const bus = createEventBus(path.join(tmp, 'bus'))
    bus.on('forge.updated', (e) => void events.push(e))
    service = createForgeService({
      dataDir: path.join(tmp, 'data'),
      config: () => ({ enabled: true, repos: {} }),
      scope: {
        getMembrane: () => undefined,
        listMembranes: () => [],
        getOrg: () => undefined,
        listProjects: () => []
      },
      forgeRegistry: { forgeFor: () => createFakeForge() },
      tasks: port,
      bus,
      threads: {
        createThread: async () => 'thread-new',
        sendToThread: async (threadId, text) => {
          if (threadId === failFor) throw new Error('thread is gone')
          sent.push({ threadId, text })
        },
        presence: () => undefined
      },
      now: () => (clock += 1000),
      log: () => {}
    })
    app = express()
    app.use(createForgeRouter(service, (_req, _res, next) => next()))
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dec-'))
    sent = []
    events = []
    failFor = null
    clock = NOW
    make()
  })
  afterEach(() => {
    service.stop()
    port.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const open = async (body: object): Promise<Decision> => {
    const res = await request(app)
      .post('/api/forge/decisions')
      .send({ membrane: 'acme', ...body })
    expect(res.status).toBe(201)
    return res.body
  }
  const list = async (q = ''): Promise<Decision[]> =>
    (await request(app).get(`/api/forge/decisions?membrane=acme${q}`)).body.decisions

  it('opens a decision, lists open ones newest first, and refuses bad input', async () => {
    const a = await open({
      question: 'Which  database\nfor the index?',
      context: 'It grows **fast**.\nSecond line.',
      options: ['SQLite', 'Postgres', 'SQLite', ' '],
      source: { kind: 'plan', ref: 'plan:engine/plans/index.md', label: 'Index plan' },
      group: 'Index',
      threadId: 'thread-a'
    })
    expect(a).toMatchObject({
      membrane: 'acme',
      question: 'Which database for the index?',
      context: 'It grows **fast**.\nSecond line.',
      options: ['SQLite', 'Postgres'],
      source: { kind: 'plan', ref: 'plan:engine/plans/index.md', label: 'Index plan' },
      group: 'Index',
      threadId: 'thread-a',
      status: 'open',
      createdBy: 'user'
    })
    expect(a.id).toMatch(/^forge-decision:\/\/acme\/[0-9a-f-]{36}$/)
    const b = await open({ question: 'Ship on Friday?' })
    expect((await list()).map((d) => d.id)).toEqual([b.id, a.id])
    expect(
      await request(app)
        .get('/api/forge/decisions?membrane=other')
        .then((r) => r.body.decisions)
    ).toEqual([])
    expect(events.map((e) => e.payload)).toEqual([{ membrane: 'acme' }, { membrane: 'acme' }])

    const post = (body: object) => request(app).post('/api/forge/decisions').send(body)
    expect((await post({ question: 'No membrane' })).status).toBe(400)
    expect((await post({ membrane: 'acme', question: ' ' })).status).toBe(400)
    expect((await post({ membrane: 'acme', question: 'q', options: 'yes' })).status).toBe(400)
    expect((await post({ membrane: 'acme', question: 'q', source: { kind: 'chat', ref: 'x' } })).status).toBe(400)
    expect((await post({ membrane: 'acme', question: 'q', source: { kind: 'thread' } })).status).toBe(400)
    expect((await request(app).get('/api/forge/decisions?membrane=acme&status=done')).status).toBe(400)
  })

  it('PATCH edits question, context, options, group and thread; null clears; unknown is 404', async () => {
    const a = await open({ question: 'Name?', group: 'Naming', threadId: 'thread-a', options: ['A'] })
    const url = `/api/forge/decisions/${encodeURIComponent(a.id)}`
    const res = await request(app)
      .patch(url)
      .send({ membrane: 'acme', question: 'Product name?', context: 'For the launch', options: ['Forge', 'Anvil'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      question: 'Product name?',
      context: 'For the launch',
      options: ['Forge', 'Anvil']
    })
    const cleared = await request(app).patch(url).send({ membrane: 'acme', group: null, threadId: '', options: [] })
    expect(cleared.body.group).toBeUndefined()
    expect(cleared.body.threadId).toBeUndefined()
    expect(cleared.body.options).toBeUndefined()
    expect((await request(app).patch(url).send({ membrane: 'acme' })).status).toBe(400)
    expect((await request(app).patch(url).send({ membrane: 'acme', question: '' })).status).toBe(400)
    expect((await request(app).patch(url).send({ membrane: 'beta', group: 'x' })).status).toBe(404)
    const none = `/api/forge/decisions/${encodeURIComponent('forge-decision://acme/none')}`
    expect((await request(app).patch(none).send({ membrane: 'acme', group: 'x' })).status).toBe(404)
  })

  it('groups and assigns many at once', async () => {
    const a = await open({ question: 'One?' })
    const b = await open({ question: 'Two?', group: 'Old' })
    const c = await open({ question: 'Three?' })
    const res = await request(app)
      .post('/api/forge/decisions/group')
      .send({ membrane: 'acme', ids: [a.id, b.id], group: 'Launch', threadId: 'thread-l' })
    expect(res.status).toBe(200)
    expect(res.body.decisions.map((d: Decision) => [d.question, d.group, d.threadId])).toEqual([
      ['One?', 'Launch', 'thread-l'],
      ['Two?', 'Launch', 'thread-l']
    ])
    // A thread alone keeps the group.
    await request(app)
      .post('/api/forge/decisions/group')
      .send({ membrane: 'acme', ids: [b.id], threadId: 'thread-m' })
    const byId = new Map((await list()).map((d) => [d.id, d]))
    expect(byId.get(b.id)).toMatchObject({ group: 'Launch', threadId: 'thread-m' })
    expect(byId.get(c.id)?.group).toBeUndefined()
    const group = (body: object) =>
      request(app)
        .post('/api/forge/decisions/group')
        .send({ membrane: 'acme', ...body })
    expect((await group({ ids: [a.id] })).status).toBe(400)
    expect((await group({ ids: [], group: 'x' })).status).toBe(400)
    expect((await group({ ids: [a.id, 'forge-decision://acme/none'], group: 'x' })).status).toBe(404)
    expect(byId.get(a.id)?.group).toBe('Launch')
  })

  it('resolves many in one call: one message per thread, in the exact format, none for unthreaded', async () => {
    const a1 = await open({
      question: 'Which database?',
      options: ['SQLite', 'Postgres'],
      source: { kind: 'plan', ref: 'plan:engine/plans/index.md', label: 'Index plan' },
      threadId: 'thread-a'
    })
    const b1 = await open({ question: 'Ship on Friday?', threadId: 'thread-b' })
    const loose = await open({ question: 'Paint the shed?' })
    const a2 = await open({
      question: 'Keep the old API?',
      source: { kind: 'node', ref: 'github:github.com/acme/widget#7' },
      threadId: 'thread-a'
    })
    const res = await request(app)
      .post('/api/forge/decisions/resolve')
      .send({
        membrane: 'acme',
        items: [
          { id: a1.id, resolution: 'SQLite' },
          { id: b1.id, resolution: 'No, Monday' },
          { id: loose.id, resolution: 'Green' },
          { id: a2.id, resolution: 'Yes, for one release.\nThen drop it.' }
        ]
      })
    expect(res.status).toBe(200)
    expect(res.body.resolved.map((d: Decision) => [d.status, d.resolution])).toEqual([
      ['resolved', 'SQLite'],
      ['resolved', 'No, Monday'],
      ['resolved', 'Green'],
      ['resolved', 'Yes, for one release.\nThen drop it.']
    ])
    expect(res.body.deliveries).toEqual([
      { threadId: 'thread-a', ids: [a1.id, a2.id], sent: true },
      { threadId: 'thread-b', ids: [b1.id], sent: true }
    ])
    expect(sent).toEqual([
      {
        threadId: 'thread-a',
        text: [
          '[Decisions resolved]',
          '1. Which database?',
          '   → SQLite',
          '   (source: Index plan)',
          '2. Keep the old API?',
          '   → Yes, for one release.',
          '     Then drop it.',
          '   (source: github:github.com/acme/widget#7)'
        ].join('\n')
      },
      { threadId: 'thread-b', text: '[Decisions resolved]\n1. Ship on Friday?\n   → No, Monday' }
    ])
    expect(await list()).toEqual([])
    expect((await list('&status=resolved')).every((d) => d.resolvedAt && d.status === 'resolved')).toBe(true)
    expect(await list('&status=all')).toHaveLength(4)
  })

  it('checks every item before resolving any, and reports a failed delivery without undoing the rest', async () => {
    const a = await open({ question: 'One?', threadId: 'thread-a' })
    const b = await open({ question: 'Two?', threadId: 'thread-gone' })
    const resolve = (items: unknown) =>
      request(app).post('/api/forge/decisions/resolve').send({ membrane: 'acme', items })
    expect((await resolve([{ id: a.id, resolution: '' }])).status).toBe(400)
    expect(
      (
        await resolve([
          { id: a.id, resolution: 'x' },
          { id: a.id, resolution: 'y' }
        ])
      ).status
    ).toBe(400)
    expect(
      (
        await resolve([
          { id: a.id, resolution: 'x' },
          { id: 'forge-decision://acme/none', resolution: 'y' }
        ])
      ).status
    ).toBe(404)
    expect((await resolve([])).status).toBe(400)
    expect(await list()).toHaveLength(2)

    failFor = 'thread-gone'
    const res = await resolve([
      { id: a.id, resolution: 'Yes' },
      { id: b.id, resolution: 'No' }
    ])
    expect(res.body.deliveries).toEqual([
      { threadId: 'thread-a', ids: [a.id], sent: true },
      { threadId: 'thread-gone', ids: [b.id], sent: false, error: 'thread is gone' }
    ])
    expect(await list()).toEqual([])
    expect((await resolve([{ id: a.id, resolution: 'again' }])).status).toBe(409)
  })

  it('close records a resolution and sends nothing', async () => {
    const a = await open({ question: 'One?', threadId: 'thread-a' })
    const closed = await service.decisions.close(a.id, 'Settled in review')
    expect(closed).toMatchObject({ status: 'resolved', resolution: 'Settled in review' })
    expect(sent).toEqual([])
    await expect(service.decisions.close(a.id, 'again')).rejects.toMatchObject({ status: 409 })
    await expect(service.decisions.close('forge-decision://acme/none', 'x')).rejects.toMatchObject({ status: 404 })
    await expect(service.decisions.close(a.id, ' ')).rejects.toMatchObject({ status: 400 })
  })

  it('keeps decisions across a restart', async () => {
    const a = await open({ question: 'One?', group: 'G', threadId: 'thread-a', options: ['x', 'y'] })
    service.stop()
    port.dispose()
    make()
    expect(await list()).toEqual([a])
  })

  it('formats a resolution without a source on two lines', () => {
    expect(formatResolutions([{ question: 'Q?', resolution: ' A ' }])).toBe('[Decisions resolved]\n1. Q?\n   → A')
  })
})

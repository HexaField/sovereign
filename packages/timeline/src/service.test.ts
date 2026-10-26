// Timeline service (bus → store → listeners), its routes and its WS channel.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { createEventBus, type EventBus, type TimelineEntry } from '@sovereign/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTimelineService, type TimelineService } from './service.js'
import { createTimelineRouter } from './routes.js'
import { registerTimelineChannel } from './ws.js'

const T0 = Date.parse('2026-10-26T12:00:00.000Z')
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('timeline service', () => {
  let tmp: string
  let bus: EventBus
  let service: TimelineService
  let now: number

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-svc-'))
    bus = createEventBus(path.join(tmp, 'bus'))
    now = T0
    service = createTimelineService({
      bus,
      dataDir: path.join(tmp, 'data'),
      labelOf: (id) => (id === 't1' ? 'Widget work' : undefined),
      now: () => now
    })
  })
  afterEach(() => {
    service.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const emit = (type: string, payload: unknown, at = T0) =>
    bus.emit({ type, timestamp: new Date(at).toISOString(), source: 'test', payload })

  it('maps the events it knows, stores them under <dataDir>/timeline and tells listeners', async () => {
    const heard: TimelineEntry[] = []
    service.onEntry((e) => heard.push(e))
    service.start()
    emit('chat.stream', { threadId: 't1', text: 'tok' })
    emit('chat.turn.started', { threadId: 't1', via: 'user' }, T0 + 1000)
    emit('chat.turn.ended', { threadId: 't1', via: 'user', durationMs: 3000 }, T0 + 4000)
    await flush()
    // start() itself logs one system line
    expect(heard.map((e) => e.action)).toEqual(['server.started', 'turn.started', 'turn.ended'])
    expect(heard[0]).toMatchObject({ kind: 'system', title: 'Sovereign started' })
    expect(fs.readdirSync(path.join(tmp, 'data', 'timeline'))).toEqual(['2026-10-26.jsonl'])
    expect(service.query({}).entries.map((e) => e.action)).toEqual(['turn.ended', 'turn.started', 'server.started'])
  })

  it('stop() unsubscribes', async () => {
    service.start()
    service.stop()
    emit('chat.turn.started', { threadId: 't1', via: 'user' })
    await flush()
    expect(service.query({}).entries.map((e) => e.action)).toEqual(['server.started'])
  })

  it('a listener that throws does not stop the others', async () => {
    const heard: string[] = []
    service.onEntry(() => {
      throw new Error('boom')
    })
    service.onEntry((e) => heard.push(e.action))
    service.start()
    expect(heard).toEqual(['server.started'])
  })

  it('the WS channel broadcasts each new entry on "timeline"', async () => {
    const sent: Array<{ channel: string; msg: Record<string, unknown> }> = []
    const channels: string[] = []
    registerTimelineChannel(
      {
        registerChannel: (name) => void channels.push(name),
        broadcastToChannel: (channel, msg) => void sent.push({ channel, msg: msg as Record<string, unknown> })
      },
      service
    )
    service.start()
    emit('scheduler.job.started', { job: { id: 'j', name: 'Digest', tags: [] } })
    await flush()
    expect(channels).toEqual(['timeline'])
    expect(sent.map((s) => [s.channel, s.msg.type, (s.msg.entry as TimelineEntry).action])).toEqual([
      ['timeline', 'timeline.entry', 'server.started'],
      ['timeline', 'timeline.entry', 'job.fired']
    ])
  })
})

describe('GET /api/timeline', () => {
  let tmp: string
  let service: TimelineService
  let app: express.Express

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-routes-'))
    const bus = createEventBus(path.join(tmp, 'bus'))
    service = createTimelineService({ bus, dataDir: path.join(tmp, 'data'), labelOf: () => undefined, now: () => T0 })
    for (let i = 0; i < 5; i++) {
      service.record({
        at: new Date(T0 - (5 - i) * 60_000).toISOString(),
        kind: i % 2 ? 'forge' : 'agent',
        action: 'x',
        title: `entry ${i}`,
        origin: i === 4 ? 'user' : 'cron'
      })
    }
    app = express()
    app.use(createTimelineRouter(service, (_req, _res, next) => next()))
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('returns entries newest first', async () => {
    const res = await request(app).get('/api/timeline')
    expect(res.status).toBe(200)
    expect(res.body.entries.map((e: TimelineEntry) => e.title)).toEqual([4, 3, 2, 1, 0].map((i) => `entry ${i}`))
    expect(res.body.more).toBe(false)
  })

  it('takes since, until, kinds, origins, limit and before', async () => {
    const iso = (min: number) => new Date(T0 - min * 60_000).toISOString()
    const titles = async (qs: string) =>
      (await request(app).get(`/api/timeline?${qs}`)).body.entries.map((e: TimelineEntry) => e.title)
    expect(await titles('kinds=forge')).toEqual(['entry 3', 'entry 1'])
    expect(await titles('kinds=forge,agent&origins=user')).toEqual(['entry 4'])
    expect(await titles(`since=${iso(2)}`)).toEqual(['entry 4', 'entry 3'])
    expect(await titles(`until=${iso(2)}`)).toEqual(['entry 2', 'entry 1', 'entry 0'])
    const page = (await request(app).get('/api/timeline?limit=2')).body
    expect(page.more).toBe(true)
    expect(await titles(`limit=2&before=${page.next}`)).toEqual(['entry 2', 'entry 1'])
  })

  it.each([
    ['since=yesterday', /since/],
    ['until=nope', /until/],
    ['kinds=forge,bogus', /kinds/],
    ['origins=aliens', /origins/],
    ['limit=0', /limit/],
    ['limit=1001', /limit/],
    ['limit=ten', /limit/],
    ['before=12345', /before/],
    ['since=2026-10-26T00:00:00Z&since=2026-10-27T00:00:00Z', /since/]
  ])('%s → 400', async (qs, msg) => {
    const res = await request(app).get(`/api/timeline?${qs}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(msg)
  })
})

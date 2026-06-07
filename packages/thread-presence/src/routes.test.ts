import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import express from 'express'
import request from 'supertest'
import { createMuteStore } from './mute-store.js'
import { createThreadPresenceRoutes } from './routes.js'

let tmpDir = ''
let app: express.Express

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-routes-'))
  const muteStore = createMuteStore(tmpDir)
  app = express()
  app.use(express.json())
  app.use(createThreadPresenceRoutes(muteStore))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('thread-presence routes', () => {
  it('GET /api/thread-presence/mutes returns empty list', async () => {
    const res = await request(app).get('/api/thread-presence/mutes')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ mutedThreadIds: [] })
  })

  it('PUT /api/thread-presence/mute/:threadId mutes and unmutes', async () => {
    await request(app).put('/api/thread-presence/mute/t1').send({ muted: true })
    const res = await request(app).get('/api/thread-presence/mutes')
    expect(res.body.mutedThreadIds).toEqual(['t1'])

    await request(app).put('/api/thread-presence/mute/t1').send({ muted: false })
    const res2 = await request(app).get('/api/thread-presence/mutes')
    expect(res2.body.mutedThreadIds).toEqual([])
  })

  it('PUT /api/thread-presence/mutes replaces the full set', async () => {
    await request(app)
      .put('/api/thread-presence/mutes')
      .send({ mutedThreadIds: ['a', 'b'] })
    const res = await request(app).get('/api/thread-presence/mutes')
    expect(res.body.mutedThreadIds).toEqual(['a', 'b'])
  })

  it('PUT with missing body unmutes', async () => {
    await request(app).put('/api/thread-presence/mute/t1').send({ muted: true })
    await request(app).put('/api/thread-presence/mute/t1').send({})
    const res = await request(app).get('/api/thread-presence/mutes')
    expect(res.body.mutedThreadIds).toEqual([])
  })
})

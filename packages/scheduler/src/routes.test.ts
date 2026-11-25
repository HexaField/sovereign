import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventBus } from '@sovereign/core'
import type { BackendRouter } from '@sovereign/core'
import { createScheduler, type Scheduler } from './scheduler.js'
import { createCronService } from './cron-service.js'
import { createSchedulerRoutes } from './routes.js'

const schedule = { kind: 'cron', expr: '0 5 * * *', tz: 'UTC' }

describe('cron routes', () => {
  let dataDir: string
  let server: Server
  let scheduler: Scheduler
  let base: string

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sov-cron-routes-'))
    const bus = createEventBus(dataDir)
    scheduler = createScheduler(bus, dataDir, 60000)
    const routing = { forSession: () => ({ sendMessage: async () => {} }) } as unknown as BackendRouter
    const cronService = createCronService({
      routing,
      scheduler,
      bus,
      threadExists: (key) => key === 'alpha' || key === 'beta'
    })
    const app = express()
    app.use(express.json())
    app.use(createSchedulerRoutes(scheduler, cronService))
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    scheduler.destroy()
    await new Promise((resolve) => server.close(resolve))
    rmSync(dataDir, { recursive: true, force: true })
  })

  describe('POST /api/crons', () => {
    it('creates a cron on an existing thread and answers in the listed shape', async () => {
      const res = await call('POST', '/api/crons', {
        threadKey: 'alpha',
        name: 'Digest',
        schedule,
        prompt: 'Summarise'
      })
      expect(res.status).toBe(201)
      expect(res.body.cron).toMatchObject({ name: 'Digest', threadKey: 'alpha', enabled: true })
      const listed = await call('GET', '/api/crons')
      expect(listed.body.crons).toHaveLength(1)
      expect(listed.body.crons[0]).not.toHaveProperty('issues')
    })

    it('refuses a create with no thread key (400)', async () => {
      for (const body of [
        { schedule, prompt: 'p' },
        { threadKey: '', schedule, prompt: 'p' },
        { threadKey: 7, schedule, prompt: 'p' }
      ]) {
        const res = await call('POST', '/api/crons', body)
        expect(res.status).toBe(400)
        expect(res.body.error).toMatch(/threadKey is required/)
      }
      expect(scheduler.list()).toHaveLength(0)
    })

    it('refuses a create on a thread that does not exist (400)', async () => {
      const res = await call('POST', '/api/crons', { threadKey: 'ghost', schedule, prompt: 'p' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("cron: thread 'ghost' does not exist")
      expect(scheduler.list()).toHaveLength(0)
    })

    it('refuses a missing prompt or a schedule that cannot run (400)', async () => {
      expect((await call('POST', '/api/crons', { threadKey: 'alpha', schedule })).status).toBe(400)
      expect(
        (await call('POST', '/api/crons', { threadKey: 'alpha', schedule: { kind: 'cron', expr: 'x' }, prompt: 'p' }))
          .status
      ).toBe(400)
      expect(scheduler.list()).toHaveLength(0)
    })
  })

  describe('PATCH /api/crons/:id', () => {
    it('edits name, schedule, prompt and enabled; refuses a retarget to no thread or an unknown thread (400)', async () => {
      const { body } = await call('POST', '/api/crons', { threadKey: 'alpha', schedule, prompt: 'p' })
      const id = body.cron.id
      const ok = await call('PATCH', `/api/crons/${id}`, {
        name: 'Renamed',
        schedule: { kind: 'interval', everyMs: 60000 },
        prompt: 'new',
        enabled: false
      })
      expect(ok.status).toBe(200)
      expect(ok.body.cron).toMatchObject({ name: 'Renamed', enabled: false, schedule: { kind: 'interval' } })
      expect(scheduler.get(id)?.payload.prompt).toBe('new')

      for (const threadKey of ['', 'ghost']) {
        const res = await call('PATCH', `/api/crons/${id}`, { threadKey })
        expect(res.status).toBe(400)
      }
      expect(scheduler.get(id)?.payload.threadKey).toBe('alpha')
      expect((await call('PATCH', `/api/crons/${id}`, { threadKey: 'beta' })).status).toBe(200)
      expect(scheduler.get(id)?.payload.threadKey).toBe('beta')
    })

    it('answers 404 for an unknown cron', async () => {
      expect((await call('PATCH', '/api/crons/nope', { enabled: false })).status).toBe(404)
    })
  })

  describe('run and delete', () => {
    it('POST /api/crons/:id/run fires the job; DELETE removes it; both 404 on an unknown id', async () => {
      const { body } = await call('POST', '/api/crons', { threadKey: 'alpha', schedule, prompt: 'p' })
      const id = body.cron.id
      expect((await call('POST', `/api/crons/${id}/run`)).status).toBe(200)
      expect(scheduler.runs(id).length).toBeGreaterThan(0)
      expect((await call('DELETE', `/api/crons/${id}`)).status).toBe(200)
      expect(scheduler.list()).toHaveLength(0)
      expect((await call('POST', '/api/crons/nope/run')).status).toBe(404)
      expect((await call('DELETE', '/api/crons/nope')).status).toBe(404)
    })
  })

  describe('removed global and issue routes', () => {
    it.each([
      ['POST', '/api/crons/x/fix-thread'],
      ['GET', '/api/crons/channel-status'],
      ['DELETE', '/api/crons/cleanup'],
      ['POST', '/api/crons/x/toggle']
    ])('%s %s is gone', async (method, path) => {
      const res = await fetch(base + path, { method })
      expect(res.status).toBe(404)
    })
  })

  describe('raw /api/jobs cannot make or move a cron without a thread', () => {
    it('refuses to create a sovereign.userMessage job (400)', async () => {
      const res = await call('POST', '/api/jobs', {
        name: 'x',
        schedule,
        payload: { kind: 'sovereign.userMessage', threadKey: '', prompt: 'p' }
      })
      expect(res.status).toBe(400)
      expect(scheduler.list()).toHaveLength(0)
    })

    it('refuses to retarget or rewrite a cron through PATCH /api/jobs/:id, still allows enabled (400/200)', async () => {
      const { body } = await call('POST', '/api/crons', { threadKey: 'alpha', schedule, prompt: 'p' })
      const id = body.cron.id
      for (const patch of [
        { payload: { kind: 'sovereign.userMessage', threadKey: 'ghost', prompt: 'p' } },
        { sessionKey: 'ghost' },
        { threadKey: 'ghost' }
      ]) {
        expect((await call('PATCH', `/api/jobs/${id}`, patch)).status).toBe(400)
      }
      expect((await call('PATCH', `/api/jobs/${id}`, { enabled: false })).status).toBe(200)
      expect(scheduler.get(id)?.payload.threadKey).toBe('alpha')
    })
  })
})

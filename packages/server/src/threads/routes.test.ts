import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEventBus } from '@sovereign/core'
import { createThreadManager } from './threads.js'
import { createThreadRoutes } from './routes.js'
import type { ThreadManager } from './types.js'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-routes-'))
}

// Minimal forward handler stub
const forwardHandler = {
  forward: () => ({ success: true })
}

describe('Thread Routes — Model Switching', () => {
  let app: ReturnType<typeof express>
  let dataDir: string
  let tm: ThreadManager
  let sessionsDir: string
  let sessionsPath: string

  beforeEach(() => {
    dataDir = makeTmpDir()
    const bus = createEventBus(dataDir)
    tm = createThreadManager(bus, dataDir)

    // Create a fake sessions.json in a temp HOME
    sessionsDir = path.join(dataDir, '.openclaw/agents/main/sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    sessionsPath = path.join(sessionsDir, 'sessions.json')

    // Override HOME for the duration of tests
    vi.stubEnv('HOME', dataDir)

    app = express()
    app.use(express.json())
    app.use(createThreadRoutes(tm, forwardHandler as any))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('GET /api/models returns available models', async () => {
    const res = await request(app).get('/api/models')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('models')
    expect(res.body).toHaveProperty('defaultModel')
    expect(Array.isArray(res.body.models)).toBe(true)
  })

  it('PATCH /api/threads/:key/model updates session model', async () => {
    // Create thread + session data
    const thread = tm.create({ label: 'test-thread' })
    const sessionKey = `agent:main:thread:${thread.key}`
    fs.writeFileSync(
      sessionsPath,
      JSON.stringify({
        [sessionKey]: {
          model: 'gpt-4o',
          modelProvider: 'github-copilot'
        }
      })
    )

    const res = await request(app)
      .patch(`/api/threads/${encodeURIComponent(thread.key)}/model`)
      .send({ model: 'github-copilot/claude-opus-4.6' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    // Verify sessions.json was updated
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))
    expect(sessions[sessionKey].model).toBe('claude-opus-4.6')
    expect(sessions[sessionKey].modelProvider).toBe('github-copilot')
  })

  it('PATCH /api/threads/:key/model returns 400 without model', async () => {
    const thread = tm.create({ label: 'test' })
    const res = await request(app)
      .patch(`/api/threads/${encodeURIComponent(thread.key)}/model`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('PATCH /api/threads/:key/model returns 404 for unknown thread', async () => {
    const res = await request(app)
      .patch('/api/threads/nonexistent/model')
      .send({ model: 'github-copilot/claude-opus-4.6' })
    expect(res.status).toBe(404)
  })

  it('POST /api/models/reset-gpt is removed (endpoint no longer exists)', async () => {
    const res = await request(app).post('/api/models/reset-gpt')
    expect(res.status).toBe(404)
  })
})

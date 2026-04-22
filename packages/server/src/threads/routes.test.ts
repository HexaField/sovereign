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

  describe('session-info model drift guard', () => {
    it('rewrites unconfigured model to default', async () => {
      const thread = tm.create({ label: 'drift-test' })
      const sessionKey = `agent:main:thread:${thread.key}`

      // Write session with a drifted model
      fs.writeFileSync(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: {
            model: 'gpt-5.2-codex',
            modelProvider: 'openai',
            totalTokens: 100
          }
        })
      )

      // Write config with a different default
      const configDir = path.join(dataDir, '.openclaw')
      fs.writeFileSync(
        path.join(configDir, 'openclaw.json'),
        JSON.stringify({
          agents: {
            defaults: {
              model: { primary: 'github-copilot/claude-opus-4.6' },
              models: { 'github-copilot/claude-opus-4.6': {}, 'anthropic/claude-sonnet-4': {} }
            }
          }
        })
      )

      const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.key)}/session-info`)
      expect(res.status).toBe(200)
      expect(res.body.model).toBe('claude-opus-4.6')
      expect(res.body.modelProvider).toBe('github-copilot')

      // Verify sessions.json was rewritten
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))
      expect(sessions[sessionKey].model).toBe('claude-opus-4.6')
      expect(sessions[sessionKey].modelProvider).toBe('github-copilot')
    })

    it('preserves configured model without rewriting', async () => {
      const thread = tm.create({ label: 'configured-test' })
      const sessionKey = `agent:main:thread:${thread.key}`

      fs.writeFileSync(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: {
            model: 'claude-opus-4.6',
            modelProvider: 'github-copilot',
            totalTokens: 200
          }
        })
      )

      const configDir = path.join(dataDir, '.openclaw')
      fs.writeFileSync(
        path.join(configDir, 'openclaw.json'),
        JSON.stringify({
          agents: {
            defaults: {
              model: { primary: 'github-copilot/claude-opus-4.6' },
              models: { 'github-copilot/claude-opus-4.6': {} }
            }
          }
        })
      )

      const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.key)}/session-info`)
      expect(res.status).toBe(200)
      expect(res.body.model).toBe('claude-opus-4.6')
      expect(res.body.modelProvider).toBe('github-copilot')
    })

    it('returns raw model when config is missing (no crash)', async () => {
      const thread = tm.create({ label: 'no-config-test' })
      const sessionKey = `agent:main:thread:${thread.key}`

      fs.writeFileSync(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: {
            model: 'gpt-5.2-codex',
            modelProvider: 'openai'
          }
        })
      )

      // No openclaw.json exists — fetchModels returns empty
      const configPath = path.join(dataDir, '.openclaw', 'openclaw.json')
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath)

      const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.key)}/session-info`)
      expect(res.status).toBe(200)
      // With no config, models list is empty so guard doesn't fire
      expect(res.body.model).toBe('gpt-5.2-codex')
      expect(res.body.modelProvider).toBe('openai')
    })

    it('returns null model fields when sessions data is missing', async () => {
      const thread = tm.create({ label: 'no-sessions-test' })

      // No sessions.json
      if (fs.existsSync(sessionsPath)) fs.unlinkSync(sessionsPath)

      const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.key)}/session-info`)
      expect(res.status).toBe(200)
      expect(res.body.model).toBeNull()
      expect(res.body.modelProvider).toBeNull()
    })
  })

  it('POST /api/models/reset-gpt is removed (endpoint no longer exists)', async () => {
    const res = await request(app).post('/api/models/reset-gpt')
    expect(res.status).toBe(404)
  })

  it('GET /api/threads respects limit query parameter', async () => {
    // Create 8 threads with deterministic lastActivity via addEvent
    const createdKeys: string[] = []
    const base = 1000000
    for (let i = 1; i <= 8; i++) {
      const th = tm.create({ label: `t-${i}` })
      createdKeys.push(th.key)
      const binding = { orgId: 'o', projectId: 'p', entityType: 'issue', entityRef: `r-${i}` }
      tm.addEvent(th.key, { threadKey: th.key, event: {}, entityBinding: binding as any, timestamp: base + i })
    }

    const res = await request(app).get('/api/threads?limit=6')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.threads)).toBe(true)
    expect(res.body.threads.length).toBe(6)

    // Ensure returned threads are ordered descending by lastActivity
    const lastActs = res.body.threads.map((t: any) => t.lastActivity)
    for (let j = 1; j < lastActs.length; j++) {
      expect(lastActs[j - 1]).toBeGreaterThanOrEqual(lastActs[j])
    }

    // Ensure returned threads are among those created
    for (const t of res.body.threads) {
      expect(createdKeys).toContain(t.key)
    }
  })
})

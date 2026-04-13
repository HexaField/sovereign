import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEventBus } from '@sovereign/core'
import { createThreadManager } from './threads.js'
import { createThreadRoutes, resetGptSessionsToDefault } from './routes.js'
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

  it('POST /api/models/reset-gpt resets GPT sessions', async () => {
    fs.writeFileSync(
      sessionsPath,
      JSON.stringify({
        'agent:main:thread:a': { model: 'gpt-4o', modelProvider: 'github-copilot' },
        'agent:main:thread:b': { model: 'gpt-5-mini', modelProvider: 'github-copilot' },
        'agent:main:thread:c': { model: 'claude-opus-4.6', modelProvider: 'github-copilot' }
      })
    )

    const res = await request(app).post('/api/models/reset-gpt')
    expect(res.status).toBe(200)
    expect(res.body.updated).toHaveLength(2)
    expect(res.body.updated).toContain('agent:main:thread:a')
    expect(res.body.updated).toContain('agent:main:thread:b')

    // Verify file
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))
    expect(sessions['agent:main:thread:a'].model).toBe('claude-opus-4.6')
    expect(sessions['agent:main:thread:b'].model).toBe('claude-opus-4.6')
    expect(sessions['agent:main:thread:c'].model).toBe('claude-opus-4.6') // unchanged
  })
})

describe('resetGptSessionsToDefault', () => {
  let dataDir: string
  let sessionsPath: string

  beforeEach(() => {
    dataDir = makeTmpDir()
    const sessionsDir = path.join(dataDir, '.openclaw/agents/main/sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    sessionsPath = path.join(sessionsDir, 'sessions.json')
    vi.stubEnv('HOME', dataDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('resets GPT model sessions to claude-opus-4.6', async () => {
    fs.writeFileSync(
      sessionsPath,
      JSON.stringify({
        'session-1': { model: 'gpt-5.2-codex', modelProvider: 'github-copilot' },
        'session-2': { model: 'claude-opus-4.6', modelProvider: 'github-copilot' },
        'session-3': { model: 'gpt-4o', modelProvider: 'openai' }
      })
    )

    const result = await resetGptSessionsToDefault()
    expect(result.updated).toHaveLength(2)

    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))
    expect(sessions['session-1'].model).toBe('claude-opus-4.6')
    expect(sessions['session-1'].modelProvider).toBe('github-copilot')
    expect(sessions['session-2'].model).toBe('claude-opus-4.6') // unchanged
    expect(sessions['session-3'].model).toBe('claude-opus-4.6')
    expect(sessions['session-3'].modelProvider).toBe('github-copilot')
  })

  it('handles missing sessions.json gracefully', async () => {
    const result = await resetGptSessionsToDefault()
    expect(result.updated).toHaveLength(0)
  })
})

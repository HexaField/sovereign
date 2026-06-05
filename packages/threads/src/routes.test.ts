import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEventBus } from '@sovereign/core'
import type { AgentBackend, SessionMeta } from '@sovereign/core'
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

/** In-memory stub of the AgentBackend surface needed by thread routes. */
function createStubBackend(initial: Record<string, SessionMeta> = {}): AgentBackend {
  const sessionMetas = new Map<string, SessionMeta>(Object.entries(initial))
  let availableModels: { models: string[]; defaultModel: string | null } = { models: [], defaultModel: null }

  const noop = () => {}
  const noopAsync = async () => {}

  const backend: AgentBackend = {
    kind: 'claude-code',
    connect: noopAsync,
    disconnect: noopAsync,
    status: () => 'connected',
    sendMessage: noopAsync,
    abort: noopAsync,
    switchSession: noopAsync,
    createSession: async () => 'session-key',
    getHistory: async () => ({ turns: [], hasMore: false }),
    getFullHistory: async () => [],
    on: noop as any,
    off: noop as any,
    capabilities: () => ({
      subagents: 'native',
      cron: 'backend-managed',
      steering: false,
      followUp: false,
      compaction: 'automatic-only',
      toolStreaming: true,
      deviceIdentity: true,
      multiProvider: true
    }),
    listSessions: async () => [],
    listSubagents: async () => [],
    getSessionMeta: async (sessionKey: string) => sessionMetas.get(sessionKey) ?? null,
    setSessionModel: async (sessionKey, provider, model) => {
      const existing = sessionMetas.get(sessionKey)
      sessionMetas.set(sessionKey, {
        ...(existing ?? { sessionKey }),
        modelProvider: provider,
        model
      })
    },
    listAvailableModels: async () => availableModels,
    getContextBudget: async () => null
  }
  // expose model-setter helper for tests
  ;(backend as any).__setAvailableModels = (m: { models: string[]; defaultModel: string | null }) => {
    availableModels = m
  }
  ;(backend as any).__getSessions = () => sessionMetas
  return backend
}

describe('Thread Routes — Model Switching', () => {
  let app: ReturnType<typeof express>
  let dataDir: string
  let tm: ThreadManager
  let backend: AgentBackend

  beforeEach(() => {
    dataDir = makeTmpDir()
    const bus = createEventBus(dataDir)
    tm = createThreadManager(bus, dataDir)

    backend = createStubBackend()
    app = express()
    app.use(express.json())
    app.use(createThreadRoutes(tm, forwardHandler as any, { backend }))
  })

  it('GET /api/models returns available models', async () => {
    ;(backend as any).__setAvailableModels({ models: ['m1', 'm2'], defaultModel: 'm1' })
    const res = await request(app).get('/api/models')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('models')
    expect(res.body).toHaveProperty('defaultModel')
    expect(Array.isArray(res.body.models)).toBe(true)
    expect(res.body.models).toEqual(['m1', 'm2'])
  })

  it('PATCH /api/threads/:key/model updates session model via backend', async () => {
    const thread = tm.create({ label: 'test-thread' })
    // Bare-UUID scheme: the session key IS the bare thread id.
    const sessionKey = thread.id
    ;(backend as any).__getSessions().set(sessionKey, {
      sessionKey,
      model: 'gpt-4o',
      modelProvider: 'github-copilot'
    })

    const res = await request(app)
      .patch(`/api/threads/${encodeURIComponent(thread.id)}/model`)
      .send({ model: 'github-copilot/claude-opus-4.6' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const updated = (backend as any).__getSessions().get(sessionKey) as SessionMeta
    expect(updated.model).toBe('claude-opus-4.6')
    expect(updated.modelProvider).toBe('github-copilot')
  })

  it('PATCH /api/threads/:key/model returns 400 without model', async () => {
    const thread = tm.create({ label: 'test' })
    const res = await request(app)
      .patch(`/api/threads/${encodeURIComponent(thread.id)}/model`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('PATCH /api/threads/:key/model returns 404 for unknown thread', async () => {
    const res = await request(app)
      .patch('/api/threads/nonexistent/model')
      .send({ model: 'github-copilot/claude-opus-4.6' })
    expect(res.status).toBe(404)
  })

  describe('session-info reports backend metadata verbatim', () => {
    it('returns the stored model and provider without rewriting', async () => {
      const thread = tm.create({ label: 'drift-test' })
      // Bare-UUID scheme: the session key IS the bare thread id.
      const sessionKey = thread.id
      ;(backend as any).__getSessions().set(sessionKey, {
        sessionKey,
        model: 'gpt-5.2-codex',
        modelProvider: 'openai',
        totalTokens: 100
      })

      const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.id)}/session-info`)
      expect(res.status).toBe(200)
      expect(res.body.model).toBe('gpt-5.2-codex')
      expect(res.body.modelProvider).toBe('openai')
      expect(res.body.totalTokens).toBe(100)
    })

    it('returns null model fields when no session meta is available', async () => {
      const thread = tm.create({ label: 'no-sessions-test' })
      const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.id)}/session-info`)
      expect(res.status).toBe(200)
      expect(res.body.model).toBeNull()
      expect(res.body.modelProvider).toBeNull()
    })
  })

  it('POST /api/models/reset-gpt is removed (endpoint no longer exists)', async () => {
    const res = await request(app).post('/api/models/reset-gpt')
    expect(res.status).toBe(404)
  })
})

/**
 * Subagent-listing routes must be registered BEFORE `/api/threads/:key`
 * (Express matches in registration order; `:key` would otherwise eat
 * the literal segment "active-subagents" / "gateway-sessions" and return
 * "Thread not found").
 */
describe('Thread Routes — Subagent Listing (route-order regression)', () => {
  let app: ReturnType<typeof express>
  let dataDir: string
  let tm: ThreadManager
  let backend: AgentBackend

  /**
   * Helper: build a RoutingBackend-shaped object that wraps a single backend
   * so the route's `('all' in routing)` check passes.
   */
  function asRouting(b: AgentBackend) {
    return {
      all: () => [{ kind: 'claude-code' as const, backend: b }],
      default: () => b,
      forSession: () => b,
      forKind: () => b,
      connectAll: async () => {},
      disconnectAll: async () => {}
    }
  }

  beforeEach(() => {
    dataDir = makeTmpDir()
    const bus = createEventBus(dataDir)
    tm = createThreadManager(bus, dataDir)
    backend = createStubBackend()
    app = express()
    app.use(express.json())
    app.use(createThreadRoutes(tm, forwardHandler as any, { backend: asRouting(backend) as any }))
  })

  it('GET /api/threads/active-subagents is NOT shadowed by /api/threads/:key (returns 200, not 404)', async () => {
    // Pre-fix: GET /api/threads/active-subagents matched `/api/threads/:key`
    // (registered earlier in routes.ts:114) with key="active-subagents",
    // threadManager.get(key) returned undefined → 404 "Thread not found".
    // Post-fix: the static route is registered first and serves a JSON body.
    const res = await request(app).get('/api/threads/active-subagents')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('subagents')
    // 404 body would have been `{ error: 'Thread not found' }` — explicitly
    // assert that error field is absent so a future regression of the route
    // order surfaces here.
    expect(res.body.error).toBeUndefined()
  })

  it('GET /api/threads/gateway-sessions is NOT shadowed by /api/threads/:key (returns 200, not 404)', async () => {
    const res = await request(app).get('/api/threads/gateway-sessions')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('sessions')
    expect(res.body.error).toBeUndefined()
  })

  it('GET /api/threads/active-subagents groups live subagents by parent thread', async () => {
    // Two live subagents under different parents + one idle (must be filtered out).
    ;(backend as any).listSessions = async (filter?: { kind?: string }) => {
      if (filter?.kind !== 'subagent') return []
      return [
        {
          key: 'agent:main:subagent:abc',
          backendSessionId: 'abc',
          kind: 'subagent',
          label: 'Explore',
          lastActivity: Date.now(),
          agentStatus: 'working',
          parentKey: 'agent:main:thread:neural-nets'
        },
        {
          key: 'agent:main:subagent:def',
          backendSessionId: 'def',
          kind: 'subagent',
          label: 'general-purpose',
          lastActivity: Date.now(),
          agentStatus: 'working',
          parentKey: 'agent:main:main'
        },
        {
          key: 'agent:main:subagent:ghi',
          backendSessionId: 'ghi',
          kind: 'subagent',
          label: 'general-purpose',
          lastActivity: Date.now(),
          agentStatus: 'idle', // must be filtered out
          parentKey: 'agent:main:thread:neural-nets'
        }
      ]
    }
    const res = await request(app).get('/api/threads/active-subagents')
    expect(res.status).toBe(200)
    expect(res.body.subagents).toBeDefined()
    expect(res.body.subagents['neural-nets']).toHaveLength(1)
    expect(res.body.subagents['neural-nets'][0]).toMatchObject({
      sessionKey: 'agent:main:subagent:abc',
      label: 'Explore',
      status: 'working'
    })
    expect(res.body.subagents['main']).toHaveLength(1)
    expect(res.body.subagents['main'][0]).toMatchObject({ label: 'general-purpose' })
  })

  it('GET /api/threads/active-subagents returns empty map when no subagents are live', async () => {
    ;(backend as any).listSessions = async () => []
    const res = await request(app).get('/api/threads/active-subagents')
    expect(res.status).toBe(200)
    expect(res.body.subagents).toEqual({})
  })
})

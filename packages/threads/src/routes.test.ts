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

    it('reports the backend default model before the thread has a session', async () => {
      const thread = tm.create({ label: 'no-sessions-test' })
      ;(backend as any).__setAvailableModels({ models: [], defaultModel: 'anthropic/claude-opus-5-5' })
      const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.id)}/session-info`)
      expect(res.status).toBe(200)
      expect(res.body.model).toBe('claude-opus-5-5')
      expect(res.body.modelProvider).toBe('anthropic')
    })

    it('returns null model fields when there is no session and no backend default', async () => {
      const thread = tm.create({ label: 'no-default-test' })
      ;(backend as any).__setAvailableModels({ models: [], defaultModel: null })
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
describe('Thread Routes — context window reaches the session', () => {
  let app: ReturnType<typeof express>
  let tm: ThreadManager
  let windows: Map<string, number | undefined>

  beforeEach(() => {
    const dataDir = makeTmpDir()
    tm = createThreadManager(createEventBus(dataDir), dataDir)
    windows = new Map()
    const backend = createStubBackend()
    backend.setSessionContextWindow = async (sessionKey, value) => {
      windows.set(sessionKey, value)
    }
    app = express()
    app.use(express.json())
    app.use(createThreadRoutes(tm, forwardHandler as any, { backend }))
  })

  it('POST /api/threads with a contextWindow sets it on the not-yet-started session', async () => {
    const res = await request(app).post('/api/threads').send({ label: 'w', contextWindow: 50 })
    expect(res.status).toBe(201)
    expect(windows.get(res.body.thread.id)).toBe(50)
  })

  it('PATCH /api/threads/:key with a contextWindow updates the session too', async () => {
    const created = await request(app).post('/api/threads').send({ label: 'w' })
    const id = created.body.thread.id
    expect(windows.has(id)).toBe(false)
    await request(app).patch(`/api/threads/${id}`).send({ contextWindow: 1_000_000 })
    expect(windows.get(id)).toBe(1_000_000)
  })
})

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

/**
 * `/api/threads/:key/context-health` replaced the retired Cozempic
 * guard-daemon health check with Sovereign's built-in Layer 1/2/3 status.
 */
describe('Thread Routes — Context Management Health (Layers 1/2/3)', () => {
  let app: ReturnType<typeof express>
  let dataDir: string
  let tm: ThreadManager
  let backend: AgentBackend

  function setup(
    getContextManagementConfig?: () => {
      filter?: { enabled?: boolean }
      recycle?: { enabled?: boolean }
      cleanup?: { enabled?: boolean; maxSessionSizeMB?: number; schedule?: string }
    }
  ) {
    dataDir = makeTmpDir()
    const bus = createEventBus(dataDir)
    tm = createThreadManager(bus, dataDir)
    backend = createStubBackend()
    app = express()
    app.use(express.json())
    app.use(createThreadRoutes(tm, forwardHandler as any, { backend, getContextManagementConfig }))
  }

  it('returns 404 for an unknown thread', async () => {
    setup()
    const res = await request(app).get('/api/threads/nonexistent/context-health')
    expect(res.status).toBe(404)
  })

  it('defaults every layer to enabled + zeroed stats when no session and no config getter exist', async () => {
    // Mirrors a brand-new thread: no live backend session yet, and the
    // stub backend never implements getContextManagementStatus — the route
    // must fall back to config-derived enabled flags without throwing.
    setup()
    const thread = tm.create({ label: 'ctx-health-defaults' })
    const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.id)}/context-health`)
    expect(res.status).toBe(200)
    expect(res.body.healthy).toBe(true)
    expect(res.body.layer1).toEqual({
      enabled: true,
      trimCount: 0,
      trimBytesReclaimed: 0,
      dedupCount: 0,
      dedupBytesReclaimed: 0
    })
    expect(res.body.layer2).toEqual({ enabled: true, lastRecycleAt: null, recycleCount: 0 })
    expect(res.body.layer3).toEqual({ enabled: true })
  })

  it('reports healthy=false and the specific disabled layer when config disables it', async () => {
    setup(() => ({ filter: { enabled: false }, recycle: { enabled: true }, cleanup: { enabled: true } }))
    const thread = tm.create({ label: 'ctx-health-layer1-disabled' })
    const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.id)}/context-health`)
    expect(res.status).toBe(200)
    expect(res.body.healthy).toBe(false)
    expect(res.body.layer1.enabled).toBe(false)
    expect(res.body.layer2.enabled).toBe(true)
    expect(res.body.layer3.enabled).toBe(true)
  })

  it('surfaces live Layer 1 filter stats + Layer 2 recycle count from the backend', async () => {
    setup()
    const thread = tm.create({ label: 'ctx-health-live' })
    const sessionKey = thread.id
    const lastRecycleAt = Date.now() - 60_000
    ;(backend as any).__getSessions().set(sessionKey, { sessionKey, lastRecycleAt })
    ;(backend as any).getContextManagementStatus = async (key: string) => {
      expect(key).toBe(sessionKey)
      return {
        filter: {
          trimCount: 4,
          trimBytesReclaimed: 2048,
          dedupCount: 2,
          dedupBytesReclaimed: 512,
          signatureStripCount: 1,
          seenHashes: 6,
          turnCounter: 10
        },
        recycleCount: 3,
        lastRecycleAt
      }
    }

    const res = await request(app).get(`/api/threads/${encodeURIComponent(thread.id)}/context-health`)
    expect(res.status).toBe(200)
    expect(res.body.layer1).toMatchObject({
      enabled: true,
      trimCount: 4,
      trimBytesReclaimed: 2048,
      dedupCount: 2,
      dedupBytesReclaimed: 512
    })
    expect(res.body.layer2).toMatchObject({ enabled: true, recycleCount: 3, lastRecycleAt })
  })
})

describe('Thread Routes — rename and delete', () => {
  let app: ReturnType<typeof express>
  let tm: ThreadManager
  let backend: AgentBackend
  let aborted: string[]

  beforeEach(() => {
    const dataDir = makeTmpDir()
    tm = createThreadManager(createEventBus(dataDir), dataDir)
    aborted = []
    backend = createStubBackend()
    backend.abort = async (sessionKey: string) => {
      aborted.push(sessionKey)
    }
    app = express()
    app.use(express.json())
    app.use(createThreadRoutes(tm, forwardHandler as any, { backend }))
  })

  it('PATCH /api/threads/:key renames the thread (trimmed) and persists it', async () => {
    const thread = tm.create({ label: 'old name' })
    const res = await request(app).patch(`/api/threads/${thread.id}`).send({ label: '  new name  ' })
    expect(res.status).toBe(200)
    expect(res.body.thread.label).toBe('new name')
    expect(tm.get(thread.id)?.label).toBe('new name')
  })

  it('PATCH /api/threads/:key rejects an empty or non-string label', async () => {
    const thread = tm.create({ label: 'keep me' })
    expect((await request(app).patch(`/api/threads/${thread.id}`).send({ label: '   ' })).status).toBe(400)
    expect((await request(app).patch(`/api/threads/${thread.id}`).send({ label: 42 })).status).toBe(400)
    expect(tm.get(thread.id)?.label).toBe('keep me')
  })

  it('DELETE /api/threads/:key removes the thread from the active list', async () => {
    const thread = tm.create({ label: 'doomed' })
    const res = await request(app).delete(`/api/threads/${thread.id}`)
    expect(res.status).toBe(200)
    const list = await request(app).get('/api/threads')
    expect(list.body.threads.map((t: { id: string }) => t.id)).not.toContain(thread.id)
    expect(aborted).toEqual([])
  })

  it('DELETE /api/threads/:key stops a turn still running on the thread', async () => {
    const thread = tm.create({ label: 'busy' })
    thread.agentStatus = 'working'
    await request(app).delete(`/api/threads/${thread.id}`)
    expect(aborted).toEqual([thread.id])
  })

  it('DELETE /api/threads/:key stops the thread’s live subagents but not its idle ones', async () => {
    const stopped: string[] = []
    backend.listSubagents = async () => [
      { sessionKey: 'child-working', label: 'working child', status: 'working' },
      { sessionKey: 'child-idle', label: 'idle child', status: 'idle' }
    ]
    backend.stopSubagent = async (childKey: string) => {
      stopped.push(childKey)
    }
    const thread = tm.create({ label: 'parent' })
    await request(app).delete(`/api/threads/${thread.id}`)
    await new Promise((r) => setImmediate(r))
    expect(stopped).toEqual(['child-working'])
  })

  it('DELETE /api/threads/:key refuses a presence thread with 409', async () => {
    const thread = tm.create({ label: 'p', presence: 'gateway' })
    const res = await request(app).delete(`/api/threads/${thread.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('A presence thread cannot be deleted')
    const list = await request(app).get('/api/threads')
    expect(list.body.threads.map((t: { id: string }) => t.id)).toContain(thread.id)
  })

  it('DELETE /api/threads/:key returns 404 for an unknown thread', async () => {
    expect((await request(app).delete('/api/threads/nope')).status).toBe(404)
  })
})

describe('Thread Routes — pin to top', () => {
  let dataDir: string
  let app: ReturnType<typeof express>
  let tm: ThreadManager
  let bus: ReturnType<typeof createEventBus>

  function mount(manager: ThreadManager): ReturnType<typeof express> {
    const a = express()
    a.use(express.json())
    a.use(createThreadRoutes(manager, forwardHandler as any, { backend: createStubBackend() }))
    return a
  }

  beforeEach(() => {
    dataDir = makeTmpDir()
    bus = createEventBus(dataDir)
    tm = createThreadManager(bus, dataDir)
    app = mount(tm)
  })

  it('PATCH { pinned: true } stamps pinnedAt, and GET /api/threads carries it', async () => {
    const thread = tm.create({ label: 'a' })
    const before = Date.now()
    const res = await request(app).patch(`/api/threads/${thread.id}`).send({ pinned: true })
    expect(res.status).toBe(200)
    expect(res.body.thread.pinnedAt).toBeGreaterThanOrEqual(before)
    const list = await request(app).get('/api/threads')
    const listed = list.body.threads.find((t: { id: string }) => t.id === thread.id)
    expect(listed.pinnedAt).toBe(res.body.thread.pinnedAt)
  })

  it('PATCH { pinned: false } clears pinnedAt', async () => {
    const thread = tm.create({ label: 'a' })
    await request(app).patch(`/api/threads/${thread.id}`).send({ pinned: true })
    const res = await request(app).patch(`/api/threads/${thread.id}`).send({ pinned: false })
    expect(res.status).toBe(200)
    expect(res.body.thread.pinnedAt).toBeUndefined()
    expect(tm.get(thread.id)?.pinnedAt).toBeUndefined()
  })

  it('pinning an already pinned thread keeps its original pinnedAt', async () => {
    const thread = tm.create({ label: 'a' })
    const first = await request(app).patch(`/api/threads/${thread.id}`).send({ pinned: true })
    await new Promise((r) => setTimeout(r, 5))
    const again = await request(app).patch(`/api/threads/${thread.id}`).send({ pinned: true })
    expect(again.body.thread.pinnedAt).toBe(first.body.thread.pinnedAt)
  })

  it('a pin-only PATCH does not touch lastActivity', async () => {
    const thread = tm.create({ label: 'a' })
    thread.lastActivity = 1_000
    await request(app).patch(`/api/threads/${thread.id}`).send({ pinned: true })
    expect(tm.get(thread.id)?.lastActivity).toBe(1_000)
  })

  it('rejects a non-boolean pinned with 400 and leaves the thread alone', async () => {
    const thread = tm.create({ label: 'a' })
    for (const pinned of ['yes', 1, null, {}]) {
      const res = await request(app).patch(`/api/threads/${thread.id}`).send({ pinned })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('pinned must be a boolean')
    }
    expect(tm.get(thread.id)?.pinnedAt).toBeUndefined()
  })

  it('returns 404 for an unknown thread', async () => {
    expect((await request(app).patch('/api/threads/nope').send({ pinned: true })).status).toBe(404)
  })

  it('a pin survives a reload of the thread store', async () => {
    const pinned = tm.create({ label: 'a' })
    const plain = tm.create({ label: 'b' })
    const res = await request(app).patch(`/api/threads/${pinned.id}`).send({ pinned: true })
    const reloaded = createThreadManager(createEventBus(dataDir), dataDir)
    expect(reloaded.get(pinned.id)?.pinnedAt).toBe(res.body.thread.pinnedAt)
    expect(reloaded.get(plain.id)?.pinnedAt).toBeUndefined()
    const list = await request(mount(reloaded)).get('/api/threads')
    const listed = list.body.threads.find((t: { id: string }) => t.id === pinned.id)
    expect(listed.pinnedAt).toBe(res.body.thread.pinnedAt)
  })

  it('broadcasts the pin as pinnedAt in the thread.updated patch (null once unpinned)', async () => {
    const patches: Array<Record<string, unknown>> = []
    bus.on('thread.updated', (e) => {
      patches.push((e.payload as { patch: Record<string, unknown> }).patch)
    })
    const thread = tm.create({ label: 'a' })
    await request(app).patch(`/api/threads/${thread.id}`).send({ pinned: true })
    await request(app).patch(`/api/threads/${thread.id}`).send({ pinned: false })
    expect(patches).toHaveLength(2)
    expect(typeof patches[0].pinnedAt).toBe('number')
    expect(patches[0]).not.toHaveProperty('pinned')
    expect(patches[1].pinnedAt).toBeNull()
  })
})

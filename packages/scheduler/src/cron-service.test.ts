import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventBus } from '@sovereign/core'
import type { AgentBackend, BackendCapabilities, BackendRouter } from '@sovereign/core'
import { createScheduler } from './scheduler.js'
import { createCronService } from './cron-service.js'
import { createBackendEmitter } from '@sovereign/primitives'

type RoutingBackend = BackendRouter

function stubRouter(backend: AgentBackend): BackendRouter {
  return { forSession: () => backend }
}

function makeStubBackend(sends: Array<{ sessionKey: string; text: string }>): AgentBackend {
  const emitter = createBackendEmitter('claude-code')
  const caps: BackendCapabilities = {
    subagents: 'native',
    cron: 'sovereign-managed',
    steering: false,
    followUp: false,
    compaction: 'automatic-only',
    toolStreaming: true,
    deviceIdentity: false,
    multiProvider: false
  }
  return {
    kind: 'claude-code',
    connect: async () => {},
    disconnect: async () => {},
    status: () => 'connected',
    sendMessage: async (sessionKey, text) => {
      sends.push({ sessionKey, text })
    },
    abort: async () => {},
    switchSession: async () => {},
    createSession: async () => 'agent:main:thread:t1',
    getHistory: async () => ({ turns: [], hasMore: false }),
    getFullHistory: async () => [],
    on: emitter.on,
    off: emitter.off,
    capabilities: () => caps,
    listSessions: async () => [],
    listSubagents: async () => [],
    getSessionMeta: async () => null,
    setSessionModel: async () => {},
    listAvailableModels: async () => ({ models: [], defaultModel: null }),
    getContextBudget: async () => null
  }
}

describe('createCronService — Sovereign-native user-message cron', () => {
  let dataDir: string
  let routing: RoutingBackend

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'sov-cron-'))
    routing = stubRouter(makeStubBackend([]))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('creates a Sovereign-managed cron job', () => {
    const bus = createEventBus(dataDir)
    const scheduler = createScheduler(bus, dataDir, 60000)
    const service = createCronService({ routing, scheduler, bus })
    const result = service.createUserMessageCron({
      threadKey: 't1',
      schedule: { kind: 'oneshot', at: new Date(Date.now() + 60000).toISOString() },
      prompt: 'do the thing',
      label: 'my-cron'
    })
    expect(result.id).toBeTruthy()
    expect(result.schedule).toMatch(/at /)
    scheduler.destroy()
  })

  it('routes a fired cron job into the bound thread via routing.forSession', async () => {
    const bus = createEventBus(dataDir)
    const scheduler = createScheduler(bus, dataDir, 60000)
    const sends: Array<{ sessionKey: string; text: string }> = []
    const stub = makeStubBackend(sends)
    routing = stubRouter(stub)
    const service = createCronService({ routing, scheduler, bus })
    service.createUserMessageCron({
      threadKey: 't1',
      schedule: { kind: 'oneshot', at: new Date(Date.now() - 1000).toISOString() },
      prompt: 'now please',
      label: 'now-cron'
    })

    scheduler.tick()
    await new Promise((r) => setTimeout(r, 10))

    expect(sends).toHaveLength(1)
    expect(sends[0].sessionKey).toBe('agent:main:thread:t1')
    expect(sends[0].text).toContain('[Cron: now-cron]')
    expect(sends[0].text).toContain('now please')
    scheduler.destroy()
  })

  it('list() surfaces Sovereign-managed jobs alongside backend-managed ones', async () => {
    const bus = createEventBus(dataDir)
    const scheduler = createScheduler(bus, dataDir, 60000)
    const service = createCronService({ routing, scheduler, bus })
    service.createUserMessageCron({
      threadKey: 't2',
      schedule: { kind: 'cron', expr: '0 * * * *' },
      prompt: 'hourly',
      label: 'h'
    })
    const out = await service.list(true)
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0].sessionKey).toBe('agent:main:thread:t2')
    scheduler.destroy()
  })
})

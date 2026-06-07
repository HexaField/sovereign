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
    createSession: async () => 't1',
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
    expect(sends[0].sessionKey).toBe('t1')
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
    expect(out[0].sessionKey).toBe('t2')
    scheduler.destroy()
  })

  /**
   * Regression suite for the schedule-projection bug.
   *
   * Pre-fix: `sovereignJobToCronJob` projected schedule as
   *   `j.schedule.kind === 'oneshot' ? { kind: 'at', at } : { kind: j.schedule.kind }`
   * which silently dropped `expr` / `tz` / `everyMs` for non-oneshot schedules
   * and renamed the oneshot kind to 'at'.
   *
   * Real-world impact: `mcp__sovereign__cron_list` returned schedules with no
   * discriminator fields, breaking any consumer that needed to introspect or
   * re-emit them (including the cleanup route at scheduler/routes.ts:151 which
   * filters on `kind === 'oneshot'`).
   *
   * Post-fix: the projection passes the schedule through verbatim, preserving
   * all discriminated-union fields and using consistent kind names
   * (`oneshot` / `interval` / `cron`) end-to-end.
   */
  describe('list() schedule projection — preserve discriminated-union fields', () => {
    it('preserves expr + tz for a kind=cron job', async () => {
      const bus = createEventBus(dataDir)
      const scheduler = createScheduler(bus, dataDir, 60000)
      const service = createCronService({ routing, scheduler, bus })
      service.createUserMessageCron({
        threadKey: 't-cron',
        schedule: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' },
        prompt: 'every 5 min',
        label: 'cron-job'
      })
      const out = await service.list(true)
      const job = out.find((j) => j.sessionKey === 't-cron')
      expect(job).toBeDefined()
      expect(job!.schedule).toMatchObject({ kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' })
      scheduler.destroy()
    })

    it('preserves everyMs for a kind=interval job', async () => {
      const bus = createEventBus(dataDir)
      const scheduler = createScheduler(bus, dataDir, 60000)
      const service = createCronService({ routing, scheduler, bus })
      service.createUserMessageCron({
        threadKey: 't-interval',
        schedule: { kind: 'interval', everyMs: 60000 },
        prompt: 'every minute',
        label: 'interval-job'
      })
      const out = await service.list(true)
      const job = out.find((j) => j.sessionKey === 't-interval')
      expect(job).toBeDefined()
      // The reported bug: schedule round-tripped as `{kind:'interval'}` with
      // `everyMs` dropped. Post-fix the field is preserved.
      expect(job!.schedule).toMatchObject({ kind: 'interval', everyMs: 60000 })
      scheduler.destroy()
    })

    it('preserves at + uses kind="oneshot" (not "at") for a kind=oneshot job', async () => {
      const bus = createEventBus(dataDir)
      const scheduler = createScheduler(bus, dataDir, 60000)
      const service = createCronService({ routing, scheduler, bus })
      const fireAt = new Date(Date.now() + 60000).toISOString()
      service.createUserMessageCron({
        threadKey: 't-oneshot',
        schedule: { kind: 'oneshot', at: fireAt },
        prompt: 'in a minute',
        label: 'oneshot-job'
      })
      const out = await service.list(true)
      const job = out.find((j) => j.sessionKey === 't-oneshot')
      expect(job).toBeDefined()
      // Pre-fix output was `{kind:'at', at}` — the discriminator was renamed,
      // breaking the cleanup path that filters on `kind === 'oneshot'`.
      // Post-fix kind is consistent with the input shape.
      expect(job!.schedule).toMatchObject({ kind: 'oneshot', at: fireAt })
      scheduler.destroy()
    })

    it('round-trip: schedule shape from list() matches what was passed to createUserMessageCron', async () => {
      const bus = createEventBus(dataDir)
      const scheduler = createScheduler(bus, dataDir, 60000)
      const service = createCronService({ routing, scheduler, bus })
      const inputs = [
        { threadKey: 'r-cron', schedule: { kind: 'cron' as const, expr: '0 9 * * *', tz: 'Australia/Melbourne' } },
        { threadKey: 'r-interval', schedule: { kind: 'interval' as const, everyMs: 30000 } },
        {
          threadKey: 'r-oneshot',
          schedule: { kind: 'oneshot' as const, at: new Date(Date.now() + 120000).toISOString() }
        }
      ]
      for (const input of inputs) {
        service.createUserMessageCron({ ...input, prompt: 'p', label: input.threadKey })
      }
      const out = await service.list(true)
      for (const input of inputs) {
        const job = out.find((j) => j.sessionKey === `${input.threadKey}`)
        expect(job, `missing projected job for ${input.threadKey}`).toBeDefined()
        // Every field on the input schedule must be present on the projection,
        // with identical values. Catches both "dropped fields" and "renamed
        // kind" regressions in one assertion per input.
        for (const [k, v] of Object.entries(input.schedule)) {
          expect((job!.schedule as Record<string, unknown>)[k], `${input.threadKey}.schedule.${k}`).toEqual(v)
        }
      }
      scheduler.destroy()
    })
  })

  // Regression: a fired cron used to call routing.forSession(k).sendMessage(k, t)
  // directly, bypassing the chat module's queue + WS broadcast. Result: the
  // cron's user message didn't appear in the open thread until the user
  // manually refreshed. The new injection hook routes the same call through
  // `chatModule.handleSend` so the synthetic user chat.turn + queue events
  // fire live.
  describe('chat injection on fire', () => {
    it('routes through injectChatMessage when provided, NOT through routing.sendMessage', async () => {
      const bus = createEventBus(dataDir)
      const scheduler = createScheduler(bus, dataDir, 50)
      const sends: Array<{ sessionKey: string; text: string }> = []
      const injected: Array<{ threadId: string; text: string; kind?: string }> = []
      const backend = makeStubBackend(sends)
      const service = createCronService({
        routing: stubRouter(backend),
        scheduler,
        bus,
        injectChatMessage: async (threadId, text, opts) => {
          injected.push({ threadId, text, kind: opts?.kind })
        }
      })
      service.createUserMessageCron({
        threadKey: 'inject-thread',
        schedule: { kind: 'oneshot', at: new Date(Date.now() - 1000).toISOString() },
        prompt: 'hello from cron',
        label: 'L'
      })
      scheduler.tick()
      await new Promise((r) => setTimeout(r, 50))
      expect(injected.length).toBe(1)
      expect(injected[0].threadId).toBe('inject-thread')
      expect(injected[0].text).toContain('hello from cron')
      // Regression: opts.kind === 'cron' must flow through so the chat
      // module can synthesize a SYSTEM-role chat.turn (matches what the
      // SDK persists for `[Cron: …]` inputs — without this the live
      // bubble briefly renders as a user turn and flips on refresh).
      expect(injected[0].kind).toBe('cron')
      expect(sends.length).toBe(0)
      scheduler.destroy()
    })

    it('falls back to direct routing.sendMessage when injectChatMessage is omitted', async () => {
      const bus = createEventBus(dataDir)
      const scheduler = createScheduler(bus, dataDir, 50)
      const sends: Array<{ sessionKey: string; text: string }> = []
      const backend = makeStubBackend(sends)
      const service = createCronService({ routing: stubRouter(backend), scheduler, bus })
      service.createUserMessageCron({
        threadKey: 'direct-thread',
        schedule: { kind: 'oneshot', at: new Date(Date.now() - 1000).toISOString() },
        prompt: 'hello',
        label: 'L'
      })
      scheduler.tick()
      await new Promise((r) => setTimeout(r, 50))
      expect(sends.length).toBe(1)
      expect(sends[0].sessionKey).toBe('direct-thread')
      scheduler.destroy()
    })
  })
})

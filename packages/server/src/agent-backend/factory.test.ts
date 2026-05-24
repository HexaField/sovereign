import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentBackend, AgentBackendKind, BackendCapabilities } from '@sovereign/core'
import { createBackend } from './factory.js'
import { createSessionsRegistry } from './shared/sessions-registry.js'
import { createBackendEmitter } from './shared/event-emitter.js'

function makeStub(kind: AgentBackendKind): AgentBackend {
  const emitter = createBackendEmitter(kind)
  const capabilities: BackendCapabilities = {
    subagents: 'native',
    cron: 'backend-managed',
    steering: false,
    followUp: false,
    compaction: 'automatic-only',
    toolStreaming: true,
    deviceIdentity: false,
    multiProvider: false
  }
  let status: 'connected' | 'disconnected' = 'disconnected'
  return {
    kind,
    connect: async () => {
      status = 'connected'
    },
    disconnect: async () => {
      status = 'disconnected'
    },
    status: () => status,
    sendMessage: async () => {},
    abort: async () => {},
    switchSession: async () => {},
    createSession: async () => `${kind}-session`,
    getHistory: async () => ({ turns: [], hasMore: false }),
    getFullHistory: async () => [],
    on: emitter.on,
    off: emitter.off,
    capabilities: () => capabilities,
    listSessions: async () => [],
    listSubagents: async () => [],
    getSessionMeta: async () => null,
    setSessionModel: async () => {},
    listAvailableModels: async () => ({ models: [], defaultModel: null }),
    getContextBudget: async () => null,
    // Expose emitter for test injection.
    __emit: emitter.emit
  } as AgentBackend & { __emit: any }
}

describe('createBackend / RoutingBackend', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'sov-factory-'))
  })

  it('routes a registered session to the owning backend', () => {
    const registry = createSessionsRegistry(dataDir, { debounceMs: 0 })
    const oc = makeStub('openclaw')
    const pi = makeStub('pi')
    registry.upsert({ threadKey: 'pi-thread', sessionKey: 'agent:main:thread:pi-thread', backendKind: 'pi' })

    const routing = createBackend({
      enabled: ['openclaw', 'pi'],
      default: 'openclaw',
      registry,
      factories: { openclaw: () => oc, pi: () => pi }
    })

    expect(routing.forSession('agent:main:thread:pi-thread').kind).toBe('pi')
    expect(routing.forSession('agent:main:thread:other').kind).toBe('openclaw')
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('throws if the default backend is not enabled', () => {
    const registry = createSessionsRegistry(dataDir, { debounceMs: 0 })
    expect(() =>
      createBackend({
        enabled: ['openclaw'],
        default: 'pi',
        registry,
        factories: { openclaw: () => makeStub('openclaw') }
      })
    ).toThrow(/SOVEREIGN_DEFAULT_BACKEND/)
  })

  it('multiplexes events from every enabled backend', async () => {
    const registry = createSessionsRegistry(dataDir, { debounceMs: 0 })
    const oc = makeStub('openclaw') as AgentBackend & { __emit: any }
    const pi = makeStub('pi') as AgentBackend & { __emit: any }
    const routing = createBackend({
      enabled: ['openclaw', 'pi'],
      default: 'openclaw',
      registry,
      factories: { openclaw: () => oc, pi: () => pi }
    })

    const seen: any[] = []
    routing.on('chat.stream', (d) => seen.push(d))

    oc.__emit('chat.stream', { sessionKey: 'k1', text: 'from oc' })
    pi.__emit('chat.stream', { sessionKey: 'k2', text: 'from pi' })

    expect(seen.find((e) => e.text === 'from oc' && e.backendKind === 'openclaw')).toBeDefined()
    expect(seen.find((e) => e.text === 'from pi' && e.backendKind === 'pi')).toBeDefined()
  })

  it('connectAll / disconnectAll cycles every backend', async () => {
    const registry = createSessionsRegistry(dataDir, { debounceMs: 0 })
    const oc = makeStub('openclaw')
    const pi = makeStub('pi')
    const routing = createBackend({
      enabled: ['openclaw', 'pi'],
      default: 'openclaw',
      registry,
      factories: { openclaw: () => oc, pi: () => pi }
    })
    await routing.connectAll()
    expect(routing.statusAll().openclaw).toBe('connected')
    expect(routing.statusAll().pi).toBe('connected')
    expect(routing.statusAll()['claude-code']).toBe('disabled')

    await routing.disconnectAll()
    expect(routing.statusAll().openclaw).toBe('disconnected')
    expect(routing.statusAll().pi).toBe('disconnected')
  })

  it('falls back to OpenClaw for an unmapped agent: key when OpenClaw is enabled', () => {
    const registry = createSessionsRegistry(dataDir, { debounceMs: 0 })
    const routing = createBackend({
      enabled: ['openclaw', 'pi'],
      default: 'pi',
      registry,
      factories: { openclaw: () => makeStub('openclaw'), pi: () => makeStub('pi') }
    })
    expect(routing.forSession('agent:main:thread:legacy').kind).toBe('openclaw')
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentBackend, AgentBackendKind, BackendCapabilities } from '@sovereign/core'
import { createBackend } from './factory.js'
import { createSessionsRegistry } from '@sovereign/primitives'
import { createBackendEmitter } from '@sovereign/primitives'

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
    const cc = makeStub('claude-code')
    const pi = makeStub('pi')
    registry.upsert({ threadKey: 'pi-thread', sessionKey: 'agent:main:thread:pi-thread', backendKind: 'pi' })

    const routing = createBackend({
      enabled: ['claude-code', 'pi'],
      default: 'claude-code',
      registry,
      factories: { 'claude-code': () => cc, pi: () => pi }
    })

    expect(routing.forSession('agent:main:thread:pi-thread').kind).toBe('pi')
    expect(routing.forSession('agent:main:thread:other').kind).toBe('claude-code')
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('throws if the default backend is not enabled', () => {
    const registry = createSessionsRegistry(dataDir, { debounceMs: 0 })
    expect(() =>
      createBackend({
        enabled: ['claude-code'],
        default: 'pi',
        registry,
        factories: { 'claude-code': () => makeStub('claude-code') }
      })
    ).toThrow(/SOVEREIGN_DEFAULT_BACKEND/)
  })

  it('multiplexes events from every enabled backend', async () => {
    const registry = createSessionsRegistry(dataDir, { debounceMs: 0 })
    const cc = makeStub('claude-code') as AgentBackend & { __emit: any }
    const pi = makeStub('pi') as AgentBackend & { __emit: any }
    const routing = createBackend({
      enabled: ['claude-code', 'pi'],
      default: 'claude-code',
      registry,
      factories: { 'claude-code': () => cc, pi: () => pi }
    })

    const seen: any[] = []
    routing.on('chat.stream', (d) => seen.push(d))

    cc.__emit('chat.stream', { sessionKey: 'k1', text: 'from cc' })
    pi.__emit('chat.stream', { sessionKey: 'k2', text: 'from pi' })

    expect(seen.find((e) => e.text === 'from cc' && e.backendKind === 'claude-code')).toBeDefined()
    expect(seen.find((e) => e.text === 'from pi' && e.backendKind === 'pi')).toBeDefined()
  })

  it('connectAll / disconnectAll cycles every backend', async () => {
    const registry = createSessionsRegistry(dataDir, { debounceMs: 0 })
    const cc = makeStub('claude-code')
    const pi = makeStub('pi')
    const routing = createBackend({
      enabled: ['claude-code', 'pi'],
      default: 'claude-code',
      registry,
      factories: { 'claude-code': () => cc, pi: () => pi }
    })
    await routing.connectAll()
    const connected = routing.statusAll()
    expect(connected['claude-code']).toBe('connected')
    expect(connected.pi).toBe('connected')

    await routing.disconnectAll()
    const disconnected = routing.statusAll()
    expect(disconnected['claude-code']).toBe('disconnected')
    expect(disconnected.pi).toBe('disconnected')
  })

  it('routes unmapped agent: keys to the configured default', () => {
    const registry = createSessionsRegistry(dataDir, { debounceMs: 0 })
    const routing = createBackend({
      enabled: ['claude-code', 'pi'],
      default: 'pi',
      registry,
      factories: { 'claude-code': () => makeStub('claude-code'), pi: () => makeStub('pi') }
    })
    expect(routing.forSession('agent:main:thread:legacy').kind).toBe('pi')
  })
})

import { describe, it, expect, vi } from 'vitest'
import { parseLiteralTarget, startWaker } from './waker.js'
import type { EventBus } from '@sovereign/core'

// ── parseLiteralTarget ────────────────────────────────────────────────────────

describe('parseLiteralTarget', () => {
  it('decodes literal:string: targets', () => {
    expect(parseLiteralTarget('literal:string:Hello%20World')).toBe('Hello World')
    expect(parseLiteralTarget('literal:string:Hex')).toBe('Hex')
    expect(parseLiteralTarget('literal:string:')).toBe('')
  })

  it('decodes literal:json: targets and extracts .data', () => {
    const expr = {
      author: 'did:key:z6Mktest',
      timestamp: '2026-01-01T00:00:00.000Z',
      data: 'Josh',
      proof: { key: 'x', signature: 'y' }
    }
    const encoded = 'literal:json:' + encodeURIComponent(JSON.stringify(expr))
    expect(parseLiteralTarget(encoded)).toBe('Josh')
  })

  it('returns null for unrecognised schemes', () => {
    expect(parseLiteralTarget('did:key:z6Mktest')).toBeNull()
    expect(parseLiteralTarget('https://example.com')).toBeNull()
    expect(parseLiteralTarget('')).toBeNull()
  })

  it('returns null for malformed json', () => {
    expect(parseLiteralTarget('literal:json:not-valid-json')).toBeNull()
  })

  it('returns null when json .data is absent', () => {
    const encoded = 'literal:json:' + encodeURIComponent(JSON.stringify({ author: 'x' }))
    expect(parseLiteralTarget(encoded)).toBeNull()
  })

  it('does NOT accept the old literal:// double-slash scheme', () => {
    // Executors migrate this on startup — we must not silently support stale data
    expect(parseLiteralTarget('literal://string:Hello')).toBeNull()
    expect(parseLiteralTarget('literal://json:anything')).toBeNull()
  })

  it('trims whitespace from decoded strings', () => {
    expect(parseLiteralTarget('literal:string:Hello%20')).toBe('Hello')
  })
})

// ── buildMentionQuery (via waker integration) ─────────────────────────────────

function makeMockBus(): EventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
    once: vi.fn(() => () => {}),
    replay: vi.fn(),
    history: vi.fn(() => [])
  } as unknown as EventBus
}

function makeMockClientManager(did: string, profileLinks: Array<{ predicate: string; target: string }> = []) {
  const agent = {
    did,
    perspective: {
      links: profileLinks.map((l) => ({
        data: { source: 'flux://profile', predicate: l.predicate, target: l.target }
      }))
    }
  }
  const mockClient = {
    agent: {
      me: vi.fn().mockResolvedValue(agent),
      status: vi.fn(),
      addAgentStatusChangedListener: vi.fn(),
      addUpdatedListener: vi.fn(),
      addAppChangedListener: vi.fn()
    },
    perspective: {
      all: vi.fn().mockResolvedValue([]),
      queryLinks: vi.fn().mockResolvedValue([])
    },
    runtime: {
      addMessageCallback: vi.fn(),
      addNotificationTriggeredCallback: vi.fn()
    }
  }
  return {
    getClient: vi.fn().mockReturnValue(mockClient),
    isConnected: vi.fn().mockReturnValue(true),
    onConnected: vi.fn(),
    setToken: vi.fn(),
    close: vi.fn(),
    _mockClient: mockClient
  }
}

describe('startWaker — agent identity', () => {
  it('uses configuredAgentName when provided, overriding profile names', async () => {
    const bus = makeMockBus()
    const profileLinks = [{ predicate: 'sioc://has_given_name', target: 'literal:string:Josh' }]
    const manager = makeMockClientManager('did:key:z6MkTest', profileLinks)

    startWaker(manager as any, bus, undefined, 'Hex')

    // Give the async onConnected a tick to run
    await new Promise((r) => setTimeout(r, 10))

    // perspective.all() was called (auto-discover), no perspectives so no subscriptions
    expect(manager._mockClient.perspective.all).toHaveBeenCalled()
    // agent.me() was called to resolve identity
    expect(manager._mockClient.agent.me).toHaveBeenCalled()
  })

  it('starts without crashing when no perspectives are joined', async () => {
    const bus = makeMockBus()
    const manager = makeMockClientManager('did:key:z6MkTest')

    expect(() => startWaker(manager as any, bus)).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))
  })
})

describe('startWaker — WatcherController', () => {
  it('getWatched returns empty list initially', () => {
    const bus = makeMockBus()
    const manager = makeMockClientManager('did:key:z6MkTest')
    const controller = startWaker(manager as any, bus)
    expect(controller.getWatched()).toEqual([])
  })

  it('watchPerspective adds an entry, unwatchPerspective removes it', async () => {
    const bus = makeMockBus()
    const manager = makeMockClientManager('did:key:z6MkTest')
    const controller = startWaker(manager as any, bus)

    await new Promise((r) => setTimeout(r, 10))

    controller.watchPerspective('uuid-1', 'my-thread', 'My Neighbourhood')
    expect(controller.getWatched()).toHaveLength(1)
    expect(controller.getWatched()[0]).toMatchObject({
      uuid: 'uuid-1',
      threadKey: 'my-thread',
      label: 'My Neighbourhood'
    })

    controller.unwatchPerspective('uuid-1')
    expect(controller.getWatched()).toEqual([])
  })

  it('watchPerspective uses default label when none provided', () => {
    const bus = makeMockBus()
    const manager = makeMockClientManager('did:key:z6MkTest')
    const controller = startWaker(manager as any, bus)

    controller.watchPerspective('uuid-2', 'thread-key')
    const entry = controller.getWatched()[0]
    expect(entry.label).toBeTruthy()
    expect(entry.autoDiscovered).toBe(false)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connectionStatus, statusText, setConnectionStatus, setBackendStatus, initConnectionStore } from './store.js'

function createMockWs() {
  const handlers = new Map<string, Set<(msg: any) => void>>()
  return {
    connected: () => true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on(type: string, handler: (msg: any) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => {
        handlers.get(type)?.delete(handler)
      }
    },
    send: vi.fn(),
    close: vi.fn(),
    _emit(type: string, msg: any) {
      handlers.get(type)?.forEach((h) => h(msg))
    }
  }
}

describe('§3.1 Connection Store', () => {
  // The store splits liveness into two signals: `wsStatus` (browser ↔ Sovereign)
  // and `backendStatus` (Sovereign ↔ agent backend). `setConnectionStatus` is
  // a backcompat alias for `setWsStatus`. The combined `connectionStatus()`
  // returns 'connected' only when BOTH are connected; backend errors collapse
  // to 'disconnected' visually so the user sees a single binary live/dead chip.
  beforeEach(() => {
    setConnectionStatus('disconnected')
    setBackendStatus('disconnected')
  })

  it('MUST expose connectionStatus: Accessor<ConnectionStatus>', () => {
    expect(connectionStatus()).toBe('disconnected')
  })

  it('MUST expose statusText: Accessor<string> derived from connectionStatus', () => {
    expect(statusText()).toBe('Disconnected')
  })

  it('MUST map connecting to Connecting…', () => {
    setConnectionStatus('connecting')
    expect(statusText()).toBe('Connecting…')
  })

  it('MUST map connected to Connected (when both ws AND backend are connected)', () => {
    setConnectionStatus('connected')
    setBackendStatus('connected')
    expect(statusText()).toBe('Connected')
  })

  it('MUST map disconnected to Disconnected', () => {
    setConnectionStatus('disconnected')
    expect(statusText()).toBe('Disconnected')
  })

  it('MUST map error to Connection error (ws-level error)', () => {
    setConnectionStatus('error')
    expect(statusText()).toBe('Connection error')
  })

  it('MUST collapse backend errors to Disconnected when ws is connected', () => {
    setConnectionStatus('connected')
    setBackendStatus('error')
    expect(statusText()).toBe('Disconnected')
  })

  it('MUST subscribe to chat WS channel for backend.status messages', () => {
    setConnectionStatus('connected') // ws side must be up for combined status to reflect backend
    const ws = createMockWs()
    const unsub = initConnectionStore(ws as any)
    ws._emit('backend.status', { type: 'backend.status', status: 'connected' })
    expect(connectionStatus()).toBe('connected')
    unsub()
  })

  it('MUST update connectionStatus when backend.status messages arrive', () => {
    setConnectionStatus('connected')
    const ws = createMockWs()
    const unsub = initConnectionStore(ws as any)
    // backend 'error' collapses to 'disconnected' visually.
    ws._emit('backend.status', { type: 'backend.status', status: 'error' })
    expect(connectionStatus()).toBe('disconnected')
    ws._emit('backend.status', { type: 'backend.status', status: 'connecting' })
    expect(connectionStatus()).toBe('connecting')
    unsub()
  })
})

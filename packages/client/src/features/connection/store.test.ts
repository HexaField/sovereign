import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connectionStatus, statusText, setConnectionStatus, initConnectionStore } from './store.js'

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
  beforeEach(() => {
    setConnectionStatus('disconnected')
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

  it('MUST map connected to Connected', () => {
    setConnectionStatus('connected')
    expect(statusText()).toBe('Connected')
  })

  it('MUST map disconnected to Disconnected', () => {
    setConnectionStatus('disconnected')
    expect(statusText()).toBe('Disconnected')
  })

  it('MUST map error to Connection error', () => {
    setConnectionStatus('error')
    expect(statusText()).toBe('Connection error')
  })

  it('MUST subscribe to chat WS channel for backend.status messages', () => {
    const ws = createMockWs()
    const unsub = initConnectionStore(ws as any)
    ws._emit('backend.status', { type: 'backend.status', status: 'connected' })
    expect(connectionStatus()).toBe('connected')
    unsub()
  })

  it('MUST update connectionStatus when backend.status messages arrive', () => {
    const ws = createMockWs()
    const unsub = initConnectionStore(ws as any)
    ws._emit('backend.status', { type: 'backend.status', status: 'error' })
    expect(connectionStatus()).toBe('error')
    ws._emit('backend.status', { type: 'backend.status', status: 'connecting' })
    expect(connectionStatus()).toBe('connecting')
    unsub()
  })
})

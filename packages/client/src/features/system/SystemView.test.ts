import { describe, it, expect, vi } from 'vitest'

// Mock window for ws/index.ts which uses window.location at module scope
Object.defineProperty(globalThis, 'window', {
  value: { location: { protocol: 'https:', host: 'localhost:5801' } },
  writable: true
})

// Mock ws store to avoid real WebSocket
vi.mock('../../ws/index.js', () => ({
  wsStore: {
    connected: () => false,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on: vi.fn(() => () => {}),
    send: vi.fn(),
    close: vi.fn()
  }
}))

// Mock fetch for any component that calls it at import time
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) }))

import { SYSTEM_TABS } from './SystemView.jsx'

describe('SystemView SYSTEM_TABS', () => {
  it('includes a threads tab', () => {
    const ids = SYSTEM_TABS.map((t) => t.id)
    expect(ids).toContain('threads')
  })

  it('includes threads in tab IDs', () => {
    const ids = SYSTEM_TABS.map((t) => t.id)
    expect(ids).toContain('threads')
  })

  it('every tab has id, label, and component', () => {
    for (const tab of SYSTEM_TABS) {
      expect(tab.id).toBeTruthy()
      expect(tab.label).toBeTruthy()
      expect(tab.component).toBeDefined()
    }
  })

  it('has expected core tabs', () => {
    const ids = SYSTEM_TABS.map((t) => t.id)
    expect(ids).toContain('overview')
    expect(ids).toContain('architecture')
    expect(ids).toContain('logs')
    expect(ids).toContain('health')
    expect(ids).toContain('threads')
  })
})

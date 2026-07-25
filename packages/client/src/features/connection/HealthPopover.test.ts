import { describe, it, expect, vi } from 'vitest'

vi.mock('../../ws/index.js', () => ({
  wsStore: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    send: vi.fn(),
    connected: () => true
  }
}))

vi.mock('./store.js', () => ({
  connectionStatus: () => 'connected',
  wsStatus: () => 'connected',
  backendStatus: () => 'connected'
}))

vi.mock('../threads/store.js', () => ({
  threadKey: () => ''
}))

describe('HealthPopover.buildOpenUrl', () => {
  it('forces plain HTTP + supplied hostname + port + path', async () => {
    const { buildOpenUrl } = await import('./HealthPopover.js')
    expect(buildOpenUrl(13010, '/', 'host.example.net')).toBe('http://host.example.net:13010/')
    expect(buildOpenUrl(8180, '/', '10.0.0.1')).toBe('http://10.0.0.1:8180/')
  })

  it('prepends a slash to path if missing', async () => {
    const { buildOpenUrl } = await import('./HealthPopover.js')
    expect(buildOpenUrl(13010, 'launcher', 'localhost')).toBe('http://localhost:13010/launcher')
  })

  it('preserves multi-segment paths as-is', async () => {
    const { buildOpenUrl } = await import('./HealthPopover.js')
    expect(buildOpenUrl(8180, '/dapp/index.html', 'localhost')).toBe('http://localhost:8180/dapp/index.html')
  })
})

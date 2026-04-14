import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DevicesTab', () => {
  describe('§6.6 — Devices Tab', () => {
    it('exports the component and restart helpers', async () => {
      const mod = await import('./DevicesTab.js')
      expect(typeof mod.default).toBe('function')
      expect(typeof mod.fetchDevices).toBe('function')
      expect(typeof mod.requestGatewayRestart).toBe('function')
      expect(typeof mod.waitForGatewayReconnect).toBe('function')
    })

    it('requestGatewayRestart posts to the gateway restart endpoint and returns the success payload', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'accepted', message: 'gateway restarted', command: 'openclaw gateway restart' })
      })
      vi.stubGlobal('fetch', fetchMock)

      const { requestGatewayRestart } = await import('./DevicesTab.js')
      const result = await requestGatewayRestart()

      expect(fetchMock).toHaveBeenCalledWith('/api/system/gateway/restart', {
        method: 'POST',
        headers: { Accept: 'application/json' }
      })
      expect(result).toEqual({
        status: 'accepted',
        message: 'gateway restarted',
        command: 'openclaw gateway restart'
      })
    })

    it('requestGatewayRestart surfaces server errors', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({ error: 'Gateway restart already in progress' })
        })
      )

      const { requestGatewayRestart } = await import('./DevicesTab.js')

      await expect(requestGatewayRestart()).rejects.toThrow('Gateway restart already in progress')
    })

    it('waitForGatewayReconnect returns connected once the current device reconnects', async () => {
      const { waitForGatewayReconnect } = await import('./DevicesTab.js')
      const fetchDevicesFn = vi
        .fn()
        .mockResolvedValueOnce({
          devices: [{ isCurrent: true, connectionStatus: 'connecting' }]
        })
        .mockResolvedValueOnce({
          devices: [{ isCurrent: true, connectionStatus: 'connected' }]
        })

      const result = await waitForGatewayReconnect({
        pollMs: 1,
        timeoutMs: 50,
        fetchDevicesFn: fetchDevicesFn as any
      })

      expect(result).toBe('connected')
      expect(fetchDevicesFn).toHaveBeenCalledTimes(2)
    })

    it('waitForGatewayReconnect returns timeout when reconnect is not observed in time', async () => {
      const { waitForGatewayReconnect } = await import('./DevicesTab.js')
      const fetchDevicesFn = vi.fn().mockResolvedValue({
        devices: [{ isCurrent: true, connectionStatus: 'connecting' }]
      })

      const result = await waitForGatewayReconnect({
        pollMs: 1,
        timeoutMs: 5,
        fetchDevicesFn: fetchDevicesFn as any
      })

      expect(result).toBe('timeout')
      expect(fetchDevicesFn).toHaveBeenCalled()
    })
  })
})

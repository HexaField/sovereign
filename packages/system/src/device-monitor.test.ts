import { describe, it, expect } from 'vitest'
import { createDeviceMonitor } from './device-monitor.js'

describe('DeviceMonitor', () => {
  it('collects local device metrics when tailscale unavailable', async () => {
    // No tailscale → falls back to local-only collection
    const monitor = createDeviceMonitor({ cacheTtlMs: 1000 })
    const devices = await monitor.getMetrics()
    expect(devices.length).toBeGreaterThanOrEqual(1)
    const local = devices.find((d) => d.local)
    expect(local).toBeDefined()
    expect(local!.online).toBe(true)
    expect(local!.collectedAt).toBeGreaterThan(0)

    // CPU metrics present
    expect(local!.cpu).toBeDefined()
    expect(local!.cpu!.cores).toBeGreaterThan(0)
    expect(local!.cpu!.loadAvg).toHaveLength(3)

    // Memory metrics present
    expect(local!.memory).toBeDefined()
    expect(local!.memory!.totalBytes).toBeGreaterThan(0)
    expect(local!.memory!.usedBytes).toBeGreaterThan(0)
    expect(local!.memory!.usedBytes).toBeLessThanOrEqual(local!.memory!.totalBytes)
  })

  it('returns cached results within TTL', async () => {
    const monitor = createDeviceMonitor({ cacheTtlMs: 60_000 })
    const first = await monitor.getMetrics()
    const second = await monitor.getMetrics()
    // Same reference — served from cache, not re-collected
    expect(first).toBe(second)
  })

  it('refresh bypasses cache', async () => {
    const monitor = createDeviceMonitor({ cacheTtlMs: 60_000 })
    const first = await monitor.getMetrics()
    const refreshed = await monitor.refresh()
    // New collection — different reference
    expect(refreshed).not.toBe(first)
  })

  it('applies overrides to discovered devices', async () => {
    // Overrides should apply even if tailscale discovery fails (local fallback)
    const hostname = require('os').hostname()
    const monitor = createDeviceMonitor({
      overrides: {
        [hostname]: { label: 'Custom Label', watchServices: ['test-service'] }
      },
      cacheTtlMs: 1000
    })
    const devices = await monitor.getMetrics()
    const local = devices.find((d) => d.local)
    expect(local).toBeDefined()
    // Override label applied
    expect(local!.hostname).toBe('Custom Label')
  })

  it('collects storage mounts on the local device', async () => {
    const monitor = createDeviceMonitor({ cacheTtlMs: 1000 })
    const devices = await monitor.getMetrics()
    const local = devices.find((d) => d.local)
    expect(local).toBeDefined()
    // Storage may not exist on all test environments — just verify the shape
    if (local!.storage && local!.storage.length > 0) {
      expect(local!.storage[0].mount).toBeDefined()
      expect(local!.storage[0].totalBytes).toBeGreaterThan(0)
      expect(local!.storage[0].usedBytes).toBeGreaterThanOrEqual(0)
    }
  })

  it('works with no config at all', async () => {
    const monitor = createDeviceMonitor()
    const devices = await monitor.getMetrics()
    // Should get at least the local device
    expect(devices.length).toBeGreaterThanOrEqual(1)
    expect(devices[0].online).toBe(true)
  })
})

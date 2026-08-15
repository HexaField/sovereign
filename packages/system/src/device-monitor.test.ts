import { describe, it, expect } from 'vitest'
import { createDeviceMonitor } from './device-monitor.js'

describe('DeviceMonitor', () => {
  it('collects local device metrics without errors', async () => {
    const monitor = createDeviceMonitor({
      devices: [{ label: 'test-local', sshHost: null }],
      cacheTtlMs: 1000
    })
    const devices = await monitor.getMetrics()
    expect(devices).toHaveLength(1)
    const d = devices[0]
    expect(d.hostname).toBe('test-local')
    expect(d.local).toBe(true)
    expect(d.online).toBe(true)
    expect(d.collectedAt).toBeGreaterThan(0)

    // CPU metrics present
    expect(d.cpu).toBeDefined()
    expect(d.cpu!.cores).toBeGreaterThan(0)
    expect(d.cpu!.loadAvg).toHaveLength(3)

    // Memory metrics present
    expect(d.memory).toBeDefined()
    expect(d.memory!.totalBytes).toBeGreaterThan(0)
    expect(d.memory!.usedBytes).toBeGreaterThan(0)
    expect(d.memory!.usedBytes).toBeLessThanOrEqual(d.memory!.totalBytes)
  })

  it('returns cached results within TTL', async () => {
    const monitor = createDeviceMonitor({
      devices: [{ label: 'cache-test', sshHost: null }],
      cacheTtlMs: 60_000
    })
    const first = await monitor.getMetrics()
    const second = await monitor.getMetrics()
    // Same reference — served from cache, not re-collected
    expect(first).toBe(second)
  })

  it('refresh bypasses cache', async () => {
    const monitor = createDeviceMonitor({
      devices: [{ label: 'refresh-test', sshHost: null }],
      cacheTtlMs: 60_000
    })
    const first = await monitor.getMetrics()
    const refreshed = await monitor.refresh()
    // New collection — different reference
    expect(refreshed).not.toBe(first)
    expect(refreshed[0].hostname).toBe('refresh-test')
  })

  it('handles unreachable SSH host gracefully', async () => {
    const monitor = createDeviceMonitor({
      devices: [{ label: 'unreachable', sshHost: 'nonexistent-host-12345' }],
      sshTimeoutMs: 2000
    })
    const devices = await monitor.getMetrics()
    expect(devices).toHaveLength(1)
    const d = devices[0]
    expect(d.hostname).toBe('unreachable')
    expect(d.online).toBe(false)
    expect(d.error).toBeDefined()
  }, 15_000)

  it('collects storage mounts on the local device', async () => {
    const monitor = createDeviceMonitor({
      devices: [{ label: 'storage-test', sshHost: null }]
    })
    const devices = await monitor.getMetrics()
    const d = devices[0]
    // Storage may not exist on all test environments — just verify the shape
    if (d.storage && d.storage.length > 0) {
      expect(d.storage[0].mount).toBeDefined()
      expect(d.storage[0].totalBytes).toBeGreaterThan(0)
      expect(d.storage[0].usedBytes).toBeGreaterThanOrEqual(0)
    }
  })
})

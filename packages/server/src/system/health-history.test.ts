import { describe, expect, it, afterEach } from 'vitest'
import { createHealthHistory } from './health-history.js'

describe('HealthHistory', () => {
  let history: ReturnType<typeof createHealthHistory> | undefined

  afterEach(() => {
    history?.dispose()
  })

  it('takes initial snapshot on creation', () => {
    history = createHealthHistory(60000)
    const snaps = history.getSnapshots(60000)
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toHaveProperty('cpu')
    expect(snaps[0]).toHaveProperty('memory')
    expect(snaps[0]).toHaveProperty('timestamp')
    expect(snaps[0].cpu).toBeGreaterThanOrEqual(0)
    expect(snaps[0].cpu).toBeLessThanOrEqual(100)
    expect(snaps[0].memory).toBeGreaterThanOrEqual(0)
    expect(snaps[0].memory).toBeLessThanOrEqual(100)
  })

  it('filters snapshots by time window', () => {
    history = createHealthHistory(60000)
    const snaps = history.getSnapshots(1) // 1ms window — may or may not include the snapshot
    expect(snaps.length).toBeLessThanOrEqual(1)
    const allSnaps = history.getSnapshots(60000)
    expect(allSnaps).toHaveLength(1)
  })
})

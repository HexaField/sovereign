import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRetentionJob } from './retention.js'
import type { EventBus, BusEvent, BusHandler } from '@sovereign/core'

function createMockBus(): EventBus & { fire(event: BusEvent): void } {
  const handlers = new Map<string, BusHandler[]>()
  return {
    emit: vi.fn(),
    on(pattern: string, handler: BusHandler) {
      if (!handlers.has(pattern)) handlers.set(pattern, [])
      handlers.get(pattern)!.push(handler)
      return () => {}
    },
    once: vi.fn().mockReturnValue(() => {}),
    replay: vi.fn() as any,
    history: vi.fn().mockReturnValue([]),
    fire(event: BusEvent) {
      const fns = handlers.get(event.type) ?? []
      for (const fn of fns) fn(event)
    }
  }
}

describe('§8.10 Configuration & Retention', () => {
  let dataDir: string
  let bus: ReturnType<typeof createMockBus>

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-retention-test-'))
    bus = createMockBus()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('§8.10 MUST register config under recordings.* and voice.*', () => {
    const job = createRetentionJob(bus, {
      retentionDays: 30,
      autoTranscribe: true,
      autoSummarize: true,
      maxSizeBytes: 100 * 1024 * 1024
    })
    const config = job.getConfig()
    expect(config.retentionDays).toBe(30)
    expect(config.autoTranscribe).toBe(true)
    expect(config.autoSummarize).toBe(true)
    expect(config.maxSizeBytes).toBe(100 * 1024 * 1024)
  })

  it('§8.10 MUST run daily cleanup scheduler when retentionDays is set', async () => {
    const job = createRetentionJob(bus, { retentionDays: 1 })

    // Create an old meeting file
    const meetingsDir = path.join(dataDir, 'meetings', 'org1')
    fs.mkdirSync(meetingsDir, { recursive: true })
    const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() // 2 days ago
    fs.writeFileSync(path.join(meetingsDir, 'old.json'), JSON.stringify({ createdAt: oldDate }))
    fs.writeFileSync(path.join(meetingsDir, 'old.webm'), 'audio')

    // Create a recent meeting
    fs.writeFileSync(path.join(meetingsDir, 'new.json'), JSON.stringify({ createdAt: new Date().toISOString() }))

    const removed = await job.runCleanup('org1', dataDir)
    expect(removed).toBe(1)
    expect(fs.existsSync(path.join(meetingsDir, 'old.json'))).toBe(false)
    expect(fs.existsSync(path.join(meetingsDir, 'old.webm'))).toBe(false)
    expect(fs.existsSync(path.join(meetingsDir, 'new.json'))).toBe(true)
  })

  it('§8.10 MUST take effect immediately via config.changed bus event', () => {
    const job = createRetentionJob(bus, { retentionDays: 30 })
    expect(job.getConfig().retentionDays).toBe(30)

    bus.fire({
      type: 'config.changed',
      timestamp: new Date().toISOString(),
      source: 'config',
      payload: { retentionDays: 7 }
    })

    expect(job.getConfig().retentionDays).toBe(7)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runCleanup } from './retention.js'

describe('§8.10 Retention cleanup', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-retention-test-'))
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('is a no-op when retentionDays is unset', async () => {
    const removed = await runCleanup('org1', dataDir)
    expect(removed).toBe(0)
  })

  it('removes meetings/recordings older than retentionDays, keeps recent ones', async () => {
    // Create an old meeting file
    const meetingsDir = path.join(dataDir, 'meetings', 'org1')
    fs.mkdirSync(meetingsDir, { recursive: true })
    const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() // 2 days ago
    fs.writeFileSync(path.join(meetingsDir, 'old.json'), JSON.stringify({ createdAt: oldDate }))
    fs.writeFileSync(path.join(meetingsDir, 'old.webm'), 'audio')

    // Create a recent meeting
    fs.writeFileSync(path.join(meetingsDir, 'new.json'), JSON.stringify({ createdAt: new Date().toISOString() }))

    const removed = await runCleanup('org1', dataDir, 1)
    expect(removed).toBe(1)
    expect(fs.existsSync(path.join(meetingsDir, 'old.json'))).toBe(false)
    expect(fs.existsSync(path.join(meetingsDir, 'old.webm'))).toBe(false)
    expect(fs.existsSync(path.join(meetingsDir, 'new.json'))).toBe(true)
  })

  it('never touches speakers.json', async () => {
    const meetingsDir = path.join(dataDir, 'meetings', 'org1')
    fs.mkdirSync(meetingsDir, { recursive: true })
    fs.writeFileSync(path.join(meetingsDir, 'speakers.json'), JSON.stringify({ foo: 'bar' }))

    const removed = await runCleanup('org1', dataDir, 1)
    expect(removed).toBe(0)
    expect(fs.existsSync(path.join(meetingsDir, 'speakers.json'))).toBe(true)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionsRegistry } from './sessions-registry.js'

describe('SessionsRegistry', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'sov-registry-'))
  })

  it('persists upserted records to disk', async () => {
    const reg = createSessionsRegistry(dataDir, { debounceMs: 0 })
    reg.upsert({
      threadKey: 'thread-a',
      sessionKey: 'agent:main:thread:a',
      backendKind: 'openclaw',
      backendSessionId: 'oc-1'
    })
    reg.flush()

    const filePath = join(dataDir, 'agent-backend', 'sessions.json')
    expect(existsSync(filePath)).toBe(true)
    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(data['thread-a'].sessionKey).toBe('agent:main:thread:a')
    expect(data['thread-a'].backendKind).toBe('openclaw')
    expect(data['thread-a'].backendSessionId).toBe('oc-1')
  })

  it('reloads records on a new instance', () => {
    const a = createSessionsRegistry(dataDir, { debounceMs: 0 })
    a.upsert({
      threadKey: 'tk',
      sessionKey: 'agent:main:thread:tk',
      backendKind: 'pi',
      backendSessionId: 'pi-uuid'
    })
    a.flush()

    const b = createSessionsRegistry(dataDir, { debounceMs: 0 })
    const record = b.getByThread('tk')
    expect(record).toBeDefined()
    expect(record!.backendKind).toBe('pi')
    expect(b.getBySession('agent:main:thread:tk')?.threadKey).toBe('tk')
  })

  it('removes records by threadKey', () => {
    const reg = createSessionsRegistry(dataDir, { debounceMs: 0 })
    reg.upsert({
      threadKey: 't',
      sessionKey: 'agent:main:thread:t',
      backendKind: 'openclaw'
    })
    reg.remove('t')
    reg.flush()
    expect(reg.getByThread('t')).toBeUndefined()
    expect(reg.getBySession('agent:main:thread:t')).toBeUndefined()
  })

  it('filters list by backendKind', () => {
    const reg = createSessionsRegistry(dataDir, { debounceMs: 0 })
    reg.upsert({ threadKey: 'oc1', sessionKey: 'k1', backendKind: 'openclaw' })
    reg.upsert({ threadKey: 'pi1', sessionKey: 'k2', backendKind: 'pi' })
    reg.upsert({ threadKey: 'cc1', sessionKey: 'k3', backendKind: 'claude-code' })

    expect(reg.list({ backendKind: 'openclaw' })).toHaveLength(1)
    expect(reg.list({ backendKind: 'pi' })).toHaveLength(1)
    expect(reg.list({ backendKind: 'claude-code' })).toHaveLength(1)
    expect(reg.list()).toHaveLength(3)
  })

  it('preserves createdAt across updates and bumps updatedAt', async () => {
    const reg = createSessionsRegistry(dataDir, { debounceMs: 0 })
    const first = reg.upsert({ threadKey: 't', sessionKey: 'k', backendKind: 'openclaw' })
    await new Promise((r) => setTimeout(r, 5))
    const second = reg.upsert({ threadKey: 't', sessionKey: 'k', backendKind: 'openclaw', label: 'new label' })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    expect(second.label).toBe('new label')
    rmSync(dataDir, { recursive: true, force: true })
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createActiveSessions } from './active-sessions.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-sessions-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('createActiveSessions', () => {
  it('starts empty', () => {
    const as = createActiveSessions({ dataDir: tmpDir })
    expect(as.list()).toEqual([])
  })

  it('upsert + remove persists synchronously', () => {
    const as = createActiveSessions({ dataDir: tmpDir })
    as.upsert({
      sessionKey: 'agent:main:thread:a',
      threadKey: 'a',
      backendKind: 'claude-code',
      backendSessionId: 'uuid-a',
      agentStatus: 'working',
      lastTransitionAt: Date.now()
    })
    const filePath = path.join(tmpDir, 'agent-backend', 'active-sessions.json')
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw.version).toBe(1)
    expect(Object.keys(raw.data)).toContain('agent:main:thread:a')

    as.remove('agent:main:thread:a')
    const afterRemove = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(Object.keys(afterRemove.data)).not.toContain('agent:main:thread:a')
  })

  it('records in-flight queue id + prompt text', () => {
    const as = createActiveSessions({ dataDir: tmpDir })
    as.upsert({
      sessionKey: 's',
      threadKey: 't',
      backendKind: 'claude-code',
      backendSessionId: 'u',
      agentStatus: 'working',
      lastTransitionAt: 0
    })
    as.setInFlight('s', { queueId: 'q-1', promptText: 'hello' })
    const got = as.get('s')!
    expect(got.inFlightQueueId).toBe('q-1')
    expect(got.inFlightPromptText).toBe('hello')
  })

  it('subagent add/remove preserves uniqueness', () => {
    const as = createActiveSessions({ dataDir: tmpDir })
    as.upsert({
      sessionKey: 's',
      threadKey: 't',
      backendKind: 'claude-code',
      backendSessionId: 'u',
      agentStatus: 'working',
      lastTransitionAt: 0
    })
    as.addSubagent('s', { agentId: 'a1', startedAt: 0 })
    as.addSubagent('s', { agentId: 'a1', startedAt: 0 }) // dup
    as.addSubagent('s', { agentId: 'a2', startedAt: 0 })
    expect(as.get('s')?.subagents?.map((s) => s.agentId)).toEqual(['a1', 'a2'])
    as.removeSubagent('s', 'a1')
    expect(as.get('s')?.subagents?.map((s) => s.agentId)).toEqual(['a2'])
  })

  it('rehydrates from disk on construction', () => {
    const a = createActiveSessions({ dataDir: tmpDir })
    a.upsert({
      sessionKey: 's',
      threadKey: 't',
      backendKind: 'claude-code',
      backendSessionId: 'u',
      agentStatus: 'working',
      lastTransitionAt: 123
    })
    a.flush()
    const b = createActiveSessions({ dataDir: tmpDir })
    expect(b.get('s')?.lastTransitionAt).toBe(123)
  })
})

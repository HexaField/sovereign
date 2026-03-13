import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEventBus } from '@template/core'
import { createThreadManager } from './threads.js'
import { createForwardHandler } from './forward.js'
import type { ThreadManager, ForwardedMessage } from './types.js'
import type { BusEvent } from '@template/core'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-forward-'))
}

describe('§5.4 Message Forwarding (Server)', () => {
  let dataDir: string
  let bus: ReturnType<typeof createEventBus>
  let tm: ThreadManager
  let fh: ReturnType<typeof createForwardHandler>
  let forwardedEvents: BusEvent[]

  beforeEach(() => {
    dataDir = makeTmpDir()
    bus = createEventBus(dataDir)
    tm = createThreadManager(bus, dataDir)
    fh = createForwardHandler(bus, tm)
    forwardedEvents = []
    bus.on('thread.message.forwarded', (e) => {
      forwardedEvents.push(e)
    })
  })

  function makeMessage(overrides?: Partial<ForwardedMessage>): ForwardedMessage {
    return {
      originalContent: '# Hello\nThis is a test message.',
      originalRole: 'user',
      originalTimestamp: Date.now(),
      sourceThread: 'main',
      sourceThreadLabel: 'Main',
      ...overrides
    }
  }

  it('MUST preserve original message content (markdown) in ForwardedMessage', () => {
    tm.create({ label: 'main' })
    tm.create({ label: 'target' })
    const msg = makeMessage()
    const result = fh.forward('main', 'target', msg)
    expect(result.success).toBe(true)
    const payload = forwardedEvents[0].payload as Record<string, unknown>
    const forwarded = payload.message as ForwardedMessage
    expect(forwarded.originalContent).toBe('# Hello\nThis is a test message.')
  })

  it('MUST preserve original author role (user/assistant/system)', () => {
    tm.create({ label: 'main' })
    tm.create({ label: 'target' })
    const msg = makeMessage({ originalRole: 'assistant' })
    fh.forward('main', 'target', msg)
    const payload = forwardedEvents[0].payload as Record<string, unknown>
    expect((payload.message as ForwardedMessage).originalRole).toBe('assistant')
  })

  it('MUST preserve original timestamp', () => {
    tm.create({ label: 'main' })
    tm.create({ label: 'target' })
    const ts = 1700000000000
    const msg = makeMessage({ originalTimestamp: ts })
    fh.forward('main', 'target', msg)
    const payload = forwardedEvents[0].payload as Record<string, unknown>
    expect((payload.message as ForwardedMessage).originalTimestamp).toBe(ts)
  })

  it('MUST preserve source thread key and label', () => {
    tm.create({ label: 'main' })
    tm.create({ label: 'target' })
    const msg = makeMessage({ sourceThread: 'main', sourceThreadLabel: 'Main' })
    fh.forward('main', 'target', msg)
    const payload = forwardedEvents[0].payload as Record<string, unknown>
    const forwarded = payload.message as ForwardedMessage
    expect(forwarded.sourceThread).toBe('main')
    expect(forwarded.sourceThreadLabel).toBe('Main')
  })

  it('MUST preserve file attachments from the original message', () => {
    tm.create({ label: 'main' })
    tm.create({ label: 'target' })
    const msg = makeMessage({ attachments: ['file1.txt', 'file2.png'] })
    fh.forward('main', 'target', msg)
    const payload = forwardedEvents[0].payload as Record<string, unknown>
    expect((payload.message as ForwardedMessage).attachments).toEqual(['file1.txt', 'file2.png'])
  })

  it('MUST deliver forwarded message to target thread backend session', () => {
    tm.create({ label: 'main' })
    tm.create({ label: 'target' })
    const msg = makeMessage()
    const result = fh.forward('main', 'target', msg)
    expect(result.success).toBe(true)
    const payload = forwardedEvents[0].payload as Record<string, unknown>
    expect(payload.targetThread).toBe('target')
  })

  it('MUST emit thread.message.forwarded bus event with { sourceThread, targetThread, messageId }', () => {
    tm.create({ label: 'main' })
    tm.create({ label: 'target' })
    const msg = makeMessage()
    fh.forward('main', 'target', msg)
    expect(forwardedEvents).toHaveLength(1)
    const payload = forwardedEvents[0].payload as Record<string, unknown>
    expect(payload.sourceThread).toBe('main')
    expect(payload.targetThread).toBe('target')
  })

  it('MUST support forwarding across workspaces (project A to project B)', () => {
    const e1 = { orgId: 'org1', projectId: 'projA', entityType: 'issue' as const, entityRef: '1' }
    const e2 = { orgId: 'org1', projectId: 'projB', entityType: 'issue' as const, entityRef: '2' }
    tm.create({ entities: [e1] })
    tm.create({ entities: [e2] })
    const msg = makeMessage({ sourceThread: 'org1/projA/issue:1' })
    const result = fh.forward('org1/projA/issue:1', 'org1/projB/issue:2', msg)
    expect(result.success).toBe(true)
  })

  it('MUST accept optional commentary to accompany the forwarded message', () => {
    tm.create({ label: 'main' })
    tm.create({ label: 'target' })
    const msg = makeMessage({ commentary: 'Check this out!' })
    fh.forward('main', 'target', msg)
    const payload = forwardedEvents[0].payload as Record<string, unknown>
    expect((payload.message as ForwardedMessage).commentary).toBe('Check this out!')
  })
})

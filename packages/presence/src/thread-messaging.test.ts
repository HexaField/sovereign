// Thread-to-thread messaging regression tests.
//
// Covers:
//   1. forwardToInternal reports delivered:false when sendToThread absent
//   2. forwardToInternal reports delivered:false when no internal thread exists
//   3. forwardToInternal reports delivered:true on success
//   4. forwardToInternal catches sendToThread errors gracefully
//   5. reply_text catches postAssistantTurn errors and returns the reason
//   6. reply_text returns no-target-thread when no presenceThreadId

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createPresenceModule } from './module.js'
import { createResponseTools } from './response-tools.js'
import { createLastOriginTracker } from './last-origin.js'

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function makeBus() {
  const emitter = new EventEmitter()
  return {
    emit(event: { type: string; [k: string]: unknown }) {
      emitter.emit(event.type, event)
    },
    on(type: string, handler: (event: { payload: unknown }) => void) {
      emitter.on(type, handler)
      return () => emitter.off(type, handler)
    },
    off(type: string, handler: (event: { payload: unknown }) => void) {
      emitter.off(type, handler)
    }
  } as any
}

function makeThreadManager(options?: { internalId?: string; gatewayId?: string }) {
  const internalId = options?.internalId ?? 'internal-1'
  const gatewayId = options?.gatewayId ?? 'gateway-1'
  return {
    getPresenceThread: vi.fn((role: string) => {
      if (role === 'internal' && internalId) return { id: internalId, label: 'presence-internal' }
      if (role === 'gateway' && gatewayId) return { id: gatewayId, label: 'presence' }
      return null
    }),
    create: vi.fn(),
    get: vi.fn((id: string) => ({ id, label: 'test' })),
    list: vi.fn(() => []),
    touch: vi.fn(),
    delete: vi.fn(),
    update: vi.fn()
  } as any
}

/* ------------------------------------------------------------------ */
/* forwardToInternal                                                   */
/* ------------------------------------------------------------------ */

describe('forwardToInternal', () => {
  it('returns delivered:false when sendToThread unavailable', async () => {
    const bus = makeBus()
    const tm = makeThreadManager()
    const mod = createPresenceModule({
      bus,
      threadManager: tm,
      dataDir: '/tmp/presence-test-' + Date.now(),
      chat: {
        postAssistantTurn: vi.fn()
        // sendToThread deliberately absent
      },
      autoCreate: false
    })

    const result = await mod.forwardToInternal('hello')
    expect(result.delivered).toBe(false)
    mod.dispose()
  })

  it('returns delivered:false when no internal thread exists', async () => {
    const bus = makeBus()
    const tm = makeThreadManager()
    // Patch: no internal thread
    tm.getPresenceThread = vi.fn((role: string) => {
      if (role === 'gateway') return { id: 'gateway-1', label: 'presence' }
      return null
    })
    const mod = createPresenceModule({
      bus,
      threadManager: tm,
      dataDir: '/tmp/presence-test-' + Date.now(),
      chat: {
        postAssistantTurn: vi.fn(),
        sendToThread: vi.fn(async () => {})
      },
      autoCreate: false
    })

    const result = await mod.forwardToInternal('hello')
    expect(result.delivered).toBe(false)
    mod.dispose()
  })

  it('returns delivered:true when sendToThread succeeds', async () => {
    const bus = makeBus()
    const tm = makeThreadManager()
    const sendToThread = vi.fn(async () => {})
    const mod = createPresenceModule({
      bus,
      threadManager: tm,
      dataDir: '/tmp/presence-test-' + Date.now(),
      chat: {
        postAssistantTurn: vi.fn(),
        sendToThread
      },
      autoCreate: false
    })

    const result = await mod.forwardToInternal('hello')
    expect(result.delivered).toBe(true)
    expect(sendToThread).toHaveBeenCalledWith('internal-1', 'hello', expect.objectContaining({ modality: 'text' }))
    mod.dispose()
  })

  it('catches sendToThread errors and returns delivered:false', async () => {
    const bus = makeBus()
    const tm = makeThreadManager()
    const sendToThread = vi.fn(async () => {
      throw new Error('send blew up')
    })
    const mod = createPresenceModule({
      bus,
      threadManager: tm,
      dataDir: '/tmp/presence-test-' + Date.now(),
      chat: {
        postAssistantTurn: vi.fn(),
        sendToThread
      },
      autoCreate: false
    })

    const result = await mod.forwardToInternal('hello')
    expect(result.delivered).toBe(false)
    mod.dispose()
  })
})

/* ------------------------------------------------------------------ */
/* reply_text error handling                                            */
/* ------------------------------------------------------------------ */

describe('reply_text error handling', () => {
  const GATEWAY_ID = 'gateway-thread'

  function makeReplyTools(overrides?: { postAssistantTurn?: (...args: any[]) => void }) {
    const bus = makeBus()
    const lastOrigin = createLastOriginTracker(bus, () => GATEWAY_ID)
    const postAssistantTurn = overrides?.postAssistantTurn ?? vi.fn()
    const tools = createResponseTools({
      bus,
      lastOrigin,
      chat: { postAssistantTurn },
      presenceThreadId: () => GATEWAY_ID
    })
    return { tools, postAssistantTurn, lastOrigin }
  }

  it('returns delivered:false with reason when postAssistantTurn throws', async () => {
    const { tools } = makeReplyTools({
      postAssistantTurn: () => {
        throw new Error('inject failed')
      }
    })

    const result = await tools.reply_text('boom')
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('inject failed')
    expect(result.threadId).toBe(GATEWAY_ID)
  })

  it('returns delivered:true on successful post', async () => {
    const { tools, postAssistantTurn } = makeReplyTools()

    const result = await tools.reply_text('all good')
    expect(result.delivered).toBe(true)
    expect(result.threadId).toBe(GATEWAY_ID)
    expect(postAssistantTurn).toHaveBeenCalledWith(GATEWAY_ID, 'all good')
  })

  it('returns no-target-thread when presenceThreadId returns null', async () => {
    const bus = makeBus()
    const lastOrigin = createLastOriginTracker(bus, () => null as any)
    const tools = createResponseTools({
      bus,
      lastOrigin,
      chat: { postAssistantTurn: vi.fn() },
      presenceThreadId: () => null
    })

    const result = await tools.reply_text('orphan message')
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('no-target-thread')
    expect(result.threadId).toBeNull()
    lastOrigin.dispose()
  })
})

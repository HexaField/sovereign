import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { createResponseTools, renderInboundEnvelope } from './response-tools.js'
import { createLastOriginTracker } from './last-origin.js'
import type { MessageOrigin } from '@sovereign/core'

function makeBus() {
  const emitter = new EventEmitter()
  return {
    emit(event: { type: string; payload: unknown }) {
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

// In the two-thread model, `presenceThreadId` passed to createResponseTools
// is the GATEWAY thread (the default target for reply_text). The
// last-origin tracker uses it as a filter for "only track origins on this
// thread" — the internal thread in production wiring. The tests collapse
// both roles to a single id since the lower-level tracker logic is the same.
const GATEWAY_ID = 'gateway-thread-id'

function makeTools() {
  const bus = makeBus()
  const lastOrigin = createLastOriginTracker(bus, () => GATEWAY_ID)
  const wsSent: Array<{ deviceId: string; payload: unknown; kind: 'json' | 'binary' }> = []
  const chatSent: Array<{ threadId: string; content: string }> = []
  const ad4mPosted: Array<{ perspectiveUuid: string; channelAddress: string; body: string }> = []
  const ws = {
    sendBinaryTo(deviceId: string, _channel: string, payload: Buffer) {
      wsSent.push({ deviceId, payload, kind: 'binary' })
      return true
    },
    sendTo(deviceId: string, payload: Record<string, unknown>) {
      wsSent.push({ deviceId, payload, kind: 'json' })
      return true
    }
  }
  const tools = createResponseTools({
    lastOrigin,
    voice: {
      async synthesize(text: string) {
        return { audio: Buffer.from(`audio:${text}`), durationMs: 10 }
      }
    },
    ws,
    ad4m: {
      async postChildMessage(perspectiveUuid, channelAddress, body) {
        ad4mPosted.push({ perspectiveUuid, channelAddress, body })
        return { messageAddress: 'msg-' + ad4mPosted.length }
      }
    },
    chat: {
      postAssistantTurn(threadId, content) {
        chatSent.push({ threadId, content })
      }
    },
    presenceThreadId: () => GATEWAY_ID
  })
  return { tools, bus, wsSent, chatSent, ad4mPosted, lastOrigin }
}

describe('Response tools', () => {
  it('reply_voice uses last voice origin deviceId by default', async () => {
    const { tools, bus, wsSent } = makeTools()
    bus.emit({
      type: 'chat.message.origin',
      payload: { threadId: GATEWAY_ID, origin: { modality: 'voice', deviceId: 'dev-a' } satisfies MessageOrigin }
    })
    const result = await tools.reply_voice('hello')
    expect(result.delivered).toBe(true)
    expect(result.audio).toBe(true)
    expect(result.deviceId).toBe('dev-a')
    expect(wsSent).toHaveLength(1)
    expect(wsSent[0].deviceId).toBe('dev-a')
    expect(wsSent[0].kind).toBe('binary')
  })

  it('reply_voice respects explicit deviceId override', async () => {
    const { tools, bus, wsSent } = makeTools()
    bus.emit({
      type: 'chat.message.origin',
      payload: { threadId: GATEWAY_ID, origin: { modality: 'voice', deviceId: 'default' } satisfies MessageOrigin }
    })
    await tools.reply_voice('hi', { deviceId: 'override' })
    expect(wsSent[0].deviceId).toBe('override')
  })

  it('reply_voice returns no-target-device when no origin recorded', async () => {
    const { tools } = makeTools()
    const result = await tools.reply_voice('hello')
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('no-target-device')
  })

  it('reply_ad4m uses last ad4m origin perspective/channel by default', async () => {
    const { tools, bus, ad4mPosted } = makeTools()
    bus.emit({
      type: 'chat.message.origin',
      payload: {
        threadId: GATEWAY_ID,
        origin: {
          modality: 'ad4m',
          ad4m: { perspectiveUuid: 'p-1', channelAddress: 'c-1', messageAddress: 'm-1' }
        } satisfies MessageOrigin
      }
    })
    const result = await tools.reply_ad4m('there')
    expect(result.delivered).toBe(true)
    expect(result.messageAddress).toBe('msg-1')
    expect(ad4mPosted[0]).toEqual({ perspectiveUuid: 'p-1', channelAddress: 'c-1', body: 'there' })
  })

  it('reply_ad4m respects explicit overrides', async () => {
    const { tools, ad4mPosted } = makeTools()
    await tools.reply_ad4m('x', { perspectiveUuid: 'p-z', channelAddress: 'c-z' })
    expect(ad4mPosted[0]).toEqual({ perspectiveUuid: 'p-z', channelAddress: 'c-z', body: 'x' })
  })

  it('reply_text defaults to the gateway thread', async () => {
    const { tools, chatSent } = makeTools()
    await tools.reply_text('hi from presence')
    expect(chatSent).toEqual([{ threadId: GATEWAY_ID, content: 'hi from presence' }])
  })

  it('reply_text can target another thread when threadId given', async () => {
    const { tools, chatSent } = makeTools()
    await tools.reply_text('cross-post', { threadId: 'other-thread' })
    expect(chatSent[0].threadId).toBe('other-thread')
  })

  it('reply_webhook always returns not-implemented', async () => {
    const { tools } = makeTools()
    const result = await tools.reply_webhook('x', { source: 's' })
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('not-implemented')
  })
})

describe('renderInboundEnvelope', () => {
  it('renders a voice envelope', () => {
    const out = renderInboundEnvelope({ modality: 'voice', deviceId: 'd-1' }, 'hello')
    expect(out).toBe('[presence:inbound modality=voice deviceId=d-1]\nhello')
  })

  it('renders an ad4m envelope', () => {
    const out = renderInboundEnvelope(
      { modality: 'ad4m', ad4m: { perspectiveUuid: 'p', channelAddress: 'c', messageAddress: 'm' } },
      'hey'
    )
    expect(out).toContain('modality=ad4m')
    expect(out).toContain('perspectiveUuid=p')
    expect(out).toContain('channelAddress=c')
    expect(out).toContain('messageAddress=m')
    expect(out.endsWith('\nhey')).toBe(true)
  })
})

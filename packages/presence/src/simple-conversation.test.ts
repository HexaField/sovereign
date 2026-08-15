import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { createSimpleConversation } from './simple-conversation.js'

function makeBus() {
  const emitter = new EventEmitter()
  return {
    emit(event: { type: string; timestamp?: string; source?: string; payload?: unknown }) {
      emitter.emit(event.type, event)
    },
    on(type: string, handler: (event: any) => void) {
      emitter.on(type, handler)
      return () => emitter.off(type, handler)
    },
    off(type: string, handler: (event: any) => void) {
      emitter.off(type, handler)
    }
  } as any
}

const GATEWAY = 'gw-thread-1'

describe('SimpleConversation', () => {
  it('starts empty', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })
    expect(store.getEntries()).toEqual([])
    store.shutdown()
  })

  it('collects user messages on the gateway thread', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Hello Hex' }
    })

    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].role).toBe('user')
    expect(entries[0].text).toBe('Hello Hex')
    expect(entries[0].modality).toBe('text')
    store.shutdown()
  })

  it('captures voice modality from user messages', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Check the deploy', origin: { modality: 'voice' } }
    })

    expect(store.getEntries()[0].modality).toBe('voice')
    store.shutdown()
  })

  it('ignores user messages on non-gateway threads', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: 'other-thread', text: 'Should not appear' }
    })

    expect(store.getEntries()).toHaveLength(0)
    store.shutdown()
  })

  it('collects Hex replies from presence.reply events', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:01Z',
      source: 'presence',
      payload: { modality: 'voice', text: 'Looking into it now, sir.' }
    })

    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].role).toBe('hex')
    expect(entries[0].text).toBe('Looking into it now, sir.')
    expect(entries[0].modality).toBe('voice')
    store.shutdown()
  })

  it('collects text replies from presence.reply events', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:01Z',
      source: 'presence',
      payload: { modality: 'text', text: 'Build succeeded.' }
    })

    expect(store.getEntries()[0].modality).toBe('text')
    store.shutdown()
  })

  it('maintains chronological order across user and hex entries', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Run the tests' }
    })
    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:05Z',
      source: 'presence',
      payload: { modality: 'voice', text: 'All tests pass, sir.' }
    })
    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:10Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Ship it' }
    })

    const entries = store.getEntries()
    expect(entries).toHaveLength(3)
    expect(entries.map((e) => e.role)).toEqual(['user', 'hex', 'user'])
    expect(entries.map((e) => e.text)).toEqual(['Run the tests', 'All tests pass, sir.', 'Ship it'])
    store.shutdown()
  })

  it('emits presence.simple-conversation.updated on each entry', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    const updates: any[] = []
    bus.on('presence.simple-conversation.updated', (e: any) => updates.push(e.payload))

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Hello' }
    })

    expect(updates).toHaveLength(1)
    expect(updates[0].entry.role).toBe('user')
    expect(updates[0].total).toBe(1)
    store.shutdown()
  })

  it('caps at MAX_ENTRIES (200)', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    for (let i = 0; i < 210; i++) {
      bus.emit({
        type: 'chat.message.sent',
        timestamp: new Date(i * 1000).toISOString(),
        source: 'chat',
        payload: { threadId: GATEWAY, text: `msg-${i}` }
      })
    }

    const entries = store.getEntries()
    expect(entries).toHaveLength(200)
    // Oldest should start at 10 (0-9 evicted)
    expect(entries[0].text).toBe('msg-10')
    expect(entries[199].text).toBe('msg-209')
    store.shutdown()
  })

  it('shutdown clears entries and stops listening', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: GATEWAY }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'Before shutdown' }
    })
    expect(store.getEntries()).toHaveLength(1)

    store.shutdown()
    expect(store.getEntries()).toHaveLength(0)

    // Events after shutdown should not accumulate
    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:01:00Z',
      source: 'chat',
      payload: { threadId: GATEWAY, text: 'After shutdown' }
    })
    expect(store.getEntries()).toHaveLength(0)
  })

  it('handles null gatewayThreadId gracefully', () => {
    const bus = makeBus()
    const store = createSimpleConversation({ bus, config: () => ({ gatewayThreadId: null }) })

    bus.emit({
      type: 'chat.message.sent',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'chat',
      payload: { threadId: 'any-thread', text: 'Should not appear' }
    })

    expect(store.getEntries()).toHaveLength(0)

    // Hex replies still accumulate (they carry no thread filter)
    bus.emit({
      type: 'presence.reply',
      timestamp: '2026-01-01T00:00:01Z',
      source: 'presence',
      payload: { modality: 'text', text: 'Reply without gateway' }
    })
    expect(store.getEntries()).toHaveLength(1)
    store.shutdown()
  })
})

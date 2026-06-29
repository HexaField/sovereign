import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
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

describe('LastOriginTracker', () => {
  it('tracks most recent origin per modality', () => {
    const bus = makeBus()
    const tracker = createLastOriginTracker(bus, () => 'presence-id')
    bus.emit({
      type: 'chat.message.origin',
      payload: { threadId: 'presence-id', origin: { modality: 'voice', deviceId: 'a' } satisfies MessageOrigin }
    })
    bus.emit({
      type: 'chat.message.origin',
      payload: { threadId: 'presence-id', origin: { modality: 'voice', deviceId: 'b' } satisfies MessageOrigin }
    })
    expect(tracker.get('voice')?.deviceId).toBe('b')
    expect(tracker.get('ad4m')).toBeNull()
  })

  it('ignores origins from non-presence threads', () => {
    const bus = makeBus()
    const tracker = createLastOriginTracker(bus, () => 'presence-id')
    bus.emit({
      type: 'chat.message.origin',
      payload: { threadId: 'other-thread', origin: { modality: 'voice', deviceId: 'a' } }
    })
    expect(tracker.get('voice')).toBeNull()
  })

  it('tracks all threads when internalThreadId returns null', () => {
    const bus = makeBus()
    const tracker = createLastOriginTracker(bus, () => null)
    bus.emit({
      type: 'chat.message.origin',
      payload: { threadId: 'any-thread', origin: { modality: 'voice', deviceId: 'a' } }
    })
    expect(tracker.get('voice')?.deviceId).toBe('a')
  })
})

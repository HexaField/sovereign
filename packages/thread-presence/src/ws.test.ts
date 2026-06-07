import { describe, it, expect, vi } from 'vitest'
import type { EventBus, BusEvent, WsChannelOptions } from '@sovereign/core'
import { createPresenceTracker } from './presence.js'
import { registerPresenceWs, type WsHandler } from './ws.js'

function fakeBus(): EventBus {
  const listeners = new Map<string, Array<(e: BusEvent) => void>>()
  return {
    emit(event: BusEvent) {
      for (const fn of listeners.get(event.type) ?? []) fn(event)
      for (const fn of listeners.get('*') ?? []) fn(event)
    },
    on(type: string, fn: (e: BusEvent) => void) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type)!.push(fn)
      return () => {
        const arr = listeners.get(type)
        if (arr)
          listeners.set(
            type,
            arr.filter((x) => x !== fn)
          )
      }
    }
  } as EventBus
}

function fakeWsHandler(): { handler: WsHandler; opts: { current?: WsChannelOptions } } {
  const opts: { current?: WsChannelOptions } = {}
  return {
    handler: {
      registerChannel(_name: string, options: WsChannelOptions) {
        opts.current = options
      }
    },
    opts
  }
}

describe('registerPresenceWs', () => {
  it('records focus on thread.focus message', () => {
    const presence = createPresenceTracker()
    const bus = fakeBus()
    const { handler, opts } = fakeWsHandler()
    registerPresenceWs(handler, presence, bus)
    opts.current!.onMessage!('thread.focus', { threadId: 't1' }, 'd1')
    expect(presence.isThreadFocused('t1')).toBe(true)
  })

  it('blurs the device on empty threadId', () => {
    const presence = createPresenceTracker()
    const bus = fakeBus()
    const { handler, opts } = fakeWsHandler()
    registerPresenceWs(handler, presence, bus)
    opts.current!.onMessage!('thread.focus', { threadId: 't1' }, 'd1')
    opts.current!.onMessage!('thread.focus', { threadId: '' }, 'd1')
    expect(presence.isThreadFocused('t1')).toBe(false)
  })

  it('clears focus on thread.blur', () => {
    const presence = createPresenceTracker()
    const bus = fakeBus()
    const { handler, opts } = fakeWsHandler()
    registerPresenceWs(handler, presence, bus)
    opts.current!.onMessage!('thread.focus', { threadId: 't1' }, 'd1')
    opts.current!.onMessage!('thread.blur', {}, 'd1')
    expect(presence.isThreadFocused('t1')).toBe(false)
  })

  it('clears focus on WS disconnect (bus event)', () => {
    const presence = createPresenceTracker()
    const bus = fakeBus()
    const { handler, opts } = fakeWsHandler()
    registerPresenceWs(handler, presence, bus)
    opts.current!.onMessage!('thread.focus', { threadId: 't1' }, 'd1')
    bus.emit({
      type: 'ws.disconnected',
      timestamp: new Date().toISOString(),
      source: 'ws',
      payload: { deviceId: 'd1' }
    })
    expect(presence.isThreadFocused('t1')).toBe(false)
  })

  it('clears focus via channel onDisconnect callback', () => {
    const presence = createPresenceTracker()
    const bus = fakeBus()
    const { handler, opts } = fakeWsHandler()
    registerPresenceWs(handler, presence, bus)
    opts.current!.onMessage!('thread.focus', { threadId: 't1' }, 'd1')
    opts.current!.onDisconnect!('d1')
    expect(presence.isThreadFocused('t1')).toBe(false)
  })

  it('invokes onFocus callback for cross-module wiring', () => {
    const presence = createPresenceTracker()
    const bus = fakeBus()
    const { handler, opts } = fakeWsHandler()
    const cb = vi.fn()
    registerPresenceWs(handler, presence, bus, cb)
    opts.current!.onMessage!('thread.focus', { threadId: 't1' }, 'd1')
    expect(cb).toHaveBeenCalledWith('t1', 'd1')
  })
})

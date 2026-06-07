import { describe, it, expect } from 'vitest'
import { createPresenceTracker } from './presence.js'

describe('PresenceTracker', () => {
  it('starts empty', () => {
    const p = createPresenceTracker()
    expect(p.focusedThreads().size).toBe(0)
    expect(p.isThreadFocused('t1')).toBe(false)
    expect(p.devicesFocusedOn('t1')).toEqual([])
  })

  it('records a single device focus', () => {
    const p = createPresenceTracker()
    p.setFocus('d1', 't1')
    expect(p.isThreadFocused('t1')).toBe(true)
    expect(p.devicesFocusedOn('t1')).toEqual(['d1'])
    expect(p.focusedThreads()).toEqual(new Set(['t1']))
  })

  it('lets one device replace its own focus when switching threads', () => {
    const p = createPresenceTracker()
    p.setFocus('d1', 't1')
    p.setFocus('d1', 't2')
    expect(p.isThreadFocused('t1')).toBe(false)
    expect(p.isThreadFocused('t2')).toBe(true)
    expect(p.devicesFocusedOn('t2')).toEqual(['d1'])
  })

  it('aggregates multiple devices on the same thread', () => {
    const p = createPresenceTracker()
    p.setFocus('d1', 't1')
    p.setFocus('d2', 't1')
    expect(p.devicesFocusedOn('t1').sort()).toEqual(['d1', 'd2'])
    expect(p.isThreadFocused('t1')).toBe(true)
  })

  it('blur removes only that device', () => {
    const p = createPresenceTracker()
    p.setFocus('d1', 't1')
    p.setFocus('d2', 't1')
    p.blur('d1')
    expect(p.devicesFocusedOn('t1')).toEqual(['d2'])
    expect(p.isThreadFocused('t1')).toBe(true)
  })

  it('clearDevice and blur behave the same', () => {
    const p = createPresenceTracker()
    p.setFocus('d1', 't1')
    p.clearDevice('d1')
    expect(p.isThreadFocused('t1')).toBe(false)
  })

  it('ignores empty deviceId / threadId', () => {
    const p = createPresenceTracker()
    p.setFocus('', 't1')
    p.setFocus('d1', '')
    expect(p.focusedThreads().size).toBe(0)
  })

  it('snapshot returns a flat device→thread map', () => {
    const p = createPresenceTracker()
    p.setFocus('d1', 't1')
    p.setFocus('d2', 't2')
    expect(p.snapshot()).toEqual({ d1: 't1', d2: 't2' })
  })
})

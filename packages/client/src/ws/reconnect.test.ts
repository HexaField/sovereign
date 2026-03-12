import { describe, it, expect } from 'vitest'
import { createReconnector } from './reconnect.js'

describe('Reconnector', () => {
  it('starts with initial delay of 1s', () => {
    const r = createReconnector({ jitter: false })
    expect(r.nextDelay()).toBe(1000)
  })

  it('uses exponential backoff on repeated failures', () => {
    const r = createReconnector({ jitter: false })
    expect(r.nextDelay()).toBe(1000)
    expect(r.nextDelay()).toBe(2000)
    expect(r.nextDelay()).toBe(4000)
    expect(r.nextDelay()).toBe(8000)
  })

  it('caps delay at max 30s', () => {
    const r = createReconnector({ jitter: false })
    for (let i = 0; i < 20; i++) r.nextDelay()
    expect(r.nextDelay()).toBe(30000)
  })

  it('adds jitter to delay', () => {
    const r = createReconnector({ jitter: true })
    const delays = Array.from({ length: 10 }, () => {
      r.reset()
      return r.nextDelay()
    })
    // With jitter, not all delays should be identical
    const unique = new Set(delays)
    expect(unique.size).toBeGreaterThan(1)
  })

  it('fires attempt count increments', () => {
    const r = createReconnector()
    expect(r.attempt).toBe(0)
    r.nextDelay()
    expect(r.attempt).toBe(1)
    r.nextDelay()
    expect(r.attempt).toBe(2)
  })

  it('stop/reset resets backoff', () => {
    const r = createReconnector({ jitter: false })
    r.nextDelay()
    r.nextDelay()
    r.reset()
    expect(r.attempt).toBe(0)
    expect(r.nextDelay()).toBe(1000)
  })

  it('resets backoff after successful connection', () => {
    const r = createReconnector({ jitter: false })
    r.nextDelay()
    r.nextDelay()
    r.nextDelay()
    r.reset()
    expect(r.nextDelay()).toBe(1000)
  })
})

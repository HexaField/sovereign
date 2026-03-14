import { describe, it, expect } from 'vitest'
import { createSubscriptionTracker } from './subscriptions.js'

describe('SubscriptionTracker', () => {
  it('subscribes device to channels', () => {
    const t = createSubscriptionTracker()
    t.subscribe('d1', ['status', 'files'])
    expect(t.getSubscriptions('d1')).toEqual(expect.arrayContaining(['status', 'files']))
  })

  it('unsubscribes device from channels', () => {
    const t = createSubscriptionTracker()
    t.subscribe('d1', ['status', 'files'])
    t.unsubscribe('d1', ['files'])
    expect(t.getSubscriptions('d1')).toEqual(['status'])
  })

  it('returns subscriptions for a device', () => {
    const t = createSubscriptionTracker()
    t.subscribe('d1', ['a', 'b'])
    expect(t.getSubscriptions('d1')).toEqual(expect.arrayContaining(['a', 'b']))
    expect(t.getSubscriptions('d2')).toEqual([])
  })

  it('returns subscribers for a channel', () => {
    const t = createSubscriptionTracker()
    t.subscribe('d1', ['status'])
    t.subscribe('d2', ['status'])
    t.subscribe('d3', ['files'])
    expect(t.getSubscribers('status')).toEqual(expect.arrayContaining(['d1', 'd2']))
    expect(t.getSubscribers('status')).toHaveLength(2)
  })

  it('filters subscribers by scope', () => {
    const t = createSubscriptionTracker()
    t.subscribe('d1', ['files'], { projectId: 'p1' })
    t.subscribe('d2', ['files'], { projectId: 'p2' })
    t.subscribe('d3', ['files'])
    expect(t.getSubscribers('files', { projectId: 'p1' })).toEqual(['d1', 'd3'])
  })

  it('removes all subscriptions for device on disconnect', () => {
    const t = createSubscriptionTracker()
    t.subscribe('d1', ['a', 'b', 'c'])
    const removed = t.removeDevice('d1')
    expect(removed).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    expect(t.getSubscriptions('d1')).toEqual([])
  })

  it('returns removed channels on removeDevice', () => {
    const t = createSubscriptionTracker()
    t.subscribe('d1', ['x'])
    const removed = t.removeDevice('d1')
    expect(removed).toEqual(['x'])
  })
})

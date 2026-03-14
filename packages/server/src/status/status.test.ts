import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEventBus } from '@sovereign/core'
import type { EventBus, ModuleStatus } from '@sovereign/core'
import type { StatusUpdate } from './types.js'
import { createStatusAggregator, type StatusAggregator } from './status.js'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const makeBus = () => createEventBus(mkdtempSync(join(tmpdir(), 'status-test-')))

const emitEvent = (bus: EventBus, type: string, payload: unknown = {}) => {
  bus.emit({ type, timestamp: new Date().toISOString(), source: 'test', payload })
}

describe('Status Aggregator (Server)', () => {
  let bus: EventBus
  let agg: StatusAggregator

  beforeEach(() => {
    vi.useFakeTimers()
    bus = makeBus()
  })

  afterEach(() => {
    agg?.destroy()
    vi.useRealTimers()
  })

  it('collects status from all registered modules', () => {
    const modules = [
      { name: 'scheduler', status: (): ModuleStatus => ({ name: 'scheduler', status: 'ok' }) },
      { name: 'notifications', status: (): ModuleStatus => ({ name: 'notifications', status: 'degraded' }) }
    ]
    agg = createStatusAggregator(bus, { modules })
    const s = agg.getStatus()
    expect(s.modules).toEqual([
      { name: 'scheduler', status: 'ok' },
      { name: 'notifications', status: 'degraded' }
    ])
  })

  it('emits status.update event on the bus when module status changes', () => {
    const handler = vi.fn()
    bus.on('status.update', handler)
    agg = createStatusAggregator(bus, { modules: [] })
    emitEvent(bus, 'scheduler.job.started')
    vi.advanceTimersByTime(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('pushes StatusUpdate to connected WS clients', () => {
    const push = vi.fn()
    agg = createStatusAggregator(bus, { modules: [], pushToClients: push })
    emitEvent(bus, 'scheduler.job.started')
    vi.advanceTimersByTime(200)
    expect(push).toHaveBeenCalledTimes(1)
    const update: StatusUpdate = push.mock.calls[0][0]
    expect(update.type).toBe('status.update')
    expect(update.payload.activeJobs).toBe(1)
  })

  it('includes activeJobs count from scheduler', () => {
    agg = createStatusAggregator(bus, { modules: [] })
    emitEvent(bus, 'scheduler.job.started')
    emitEvent(bus, 'scheduler.job.started')
    expect(agg.getStatus().activeJobs).toBe(2)
    emitEvent(bus, 'scheduler.job.completed')
    expect(agg.getStatus().activeJobs).toBe(1)
    emitEvent(bus, 'scheduler.job.failed')
    expect(agg.getStatus().activeJobs).toBe(0)
  })

  it('includes unreadNotifications count from notifications module', () => {
    agg = createStatusAggregator(bus, { modules: [] })
    emitEvent(bus, 'notification.created')
    emitEvent(bus, 'notification.created')
    expect(agg.getStatus().unreadNotifications).toBe(2)
    emitEvent(bus, 'notification.read')
    expect(agg.getStatus().unreadNotifications).toBe(1)
  })

  it('includes per-module status', () => {
    let currentStatus: ModuleStatus['status'] = 'ok'
    const modules = [{ name: 'auth', status: (): ModuleStatus => ({ name: 'auth', status: currentStatus }) }]
    agg = createStatusAggregator(bus, { modules })
    expect(agg.getStatus().modules[0].status).toBe('ok')
    currentStatus = 'error'
    expect(agg.getStatus().modules[0].status).toBe('error')
  })

  it('emits update within 1 second of a module status change', () => {
    const push = vi.fn()
    agg = createStatusAggregator(bus, { modules: [], pushToClients: push })
    emitEvent(bus, 'scheduler.job.started')
    // Should not have fired yet (debounced)
    expect(push).not.toHaveBeenCalled()
    // Advance to within 1 second
    vi.advanceTimersByTime(200)
    expect(push).toHaveBeenCalledTimes(1)
    // Rapid changes should debounce
    emitEvent(bus, 'scheduler.job.started')
    emitEvent(bus, 'scheduler.job.started')
    emitEvent(bus, 'scheduler.job.completed')
    vi.advanceTimersByTime(200)
    expect(push).toHaveBeenCalledTimes(2) // one debounced batch
  })
})

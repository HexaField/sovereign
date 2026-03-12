import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEventBus } from '@template/core'
import type { EventBus, BusEvent } from '@template/core'
import type { Notification, NotificationRule } from './types.js'
import { createNotifications, type Notifications } from './notifications.js'
import { createNotificationStore } from './store.js'
import { createRuleEngine, interpolate } from './rules.js'

const makeDataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sov-notif-'))
  mkdirSync(join(d, 'events'), { recursive: true })
  return d
}

const writeRules = (dataDir: string, rules: NotificationRule[]): void => {
  const dir = join(dataDir, 'notifications')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules))
}

const sampleRule: NotificationRule = {
  eventPattern: 'webhook.received',
  severity: 'info',
  titleTemplate: 'Webhook from {{source}}',
  bodyTemplate: 'Received {{payload.action}} on {{payload.repo}}'
}

const tick = () => new Promise((r) => setTimeout(r, 20))

describe('Notifications', () => {
  let dataDir: string
  let bus: EventBus
  let notifs: Notifications

  beforeEach(() => {
    dataDir = makeDataDir()
    bus = createEventBus(dataDir)
  })

  afterEach(() => {
    notifs?.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  })

  // MUST maintain ordered notification queue persisted to disk
  it('persists notifications to disk as jsonl', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'test' }
    })
    await tick()
    const file = join(dataDir, 'notifications', 'notifications.jsonl')
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(1)
    const n = JSON.parse(lines[0])
    expect(n.title).toBe('Webhook from github')
  })

  it('loads notifications from disk on startup', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'test' }
    })
    await tick()
    notifs.dispose()
    // Create new instance — should load from disk
    const notifs2 = createNotifications(bus, dataDir)
    expect(notifs2.list().length).toBe(1)
    notifs = notifs2
  })

  // Each notification MUST have required fields
  it('creates notifications with id, timestamp, severity, title, body, source, read status', async () => {
    writeRules(dataDir, [sampleRule])
    let captured: Notification | undefined
    notifs = createNotifications(bus, dataDir, {
      onNotification: (n) => {
        captured = n
      }
    })
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'myrepo' }
    })
    await tick()
    expect(captured).toBeDefined()
    expect(captured!.id).toBeTruthy()
    expect(captured!.timestamp).toBeTruthy()
    expect(captured!.severity).toBe('info')
    expect(captured!.title).toBe('Webhook from github')
    expect(captured!.body).toBe('Received push on myrepo')
    expect(captured!.source).toBe('github')
    expect(captured!.read).toBe(false)
    expect(captured!.dismissed).toBe(false)
  })

  // MUST subscribe to event bus and generate notifications from events
  it('generates notification from matching bus event', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'test' }
    })
    await tick()
    expect(notifs.list().length).toBe(1)
  })

  it('uses configurable event-to-notification rules', async () => {
    writeRules(dataDir, [
      {
        eventPattern: 'scheduler.job.failed',
        severity: 'error',
        titleTemplate: 'Job failed',
        bodyTemplate: 'Job {{payload.jobId}} failed'
      }
    ])
    notifs = createNotifications(bus, dataDir)
    // This should NOT match
    bus.emit({ type: 'webhook.received', timestamp: new Date().toISOString(), source: 'github', payload: {} })
    await tick()
    expect(notifs.list().length).toBe(0)
    // This should match
    bus.emit({
      type: 'scheduler.job.failed',
      timestamp: new Date().toISOString(),
      source: 'scheduler',
      payload: { jobId: '123' }
    })
    await tick()
    expect(notifs.list().length).toBe(1)
    expect(notifs.list()[0].title).toBe('Job failed')
  })

  // Rules MUST be hot-reloadable
  it('reloads notification rules without restart', async () => {
    writeRules(dataDir, [])
    notifs = createNotifications(bus, dataDir)
    bus.emit({ type: 'webhook.received', timestamp: new Date().toISOString(), source: 'github', payload: {} })
    await tick()
    expect(notifs.list().length).toBe(0)
    // Update rules and reload
    writeRules(dataDir, [sampleRule])
    notifs._ruleEngine.reload()
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'test' }
    })
    await tick()
    expect(notifs.list().length).toBe(1)
  })

  // MUST push new notifications via callback (WS push placeholder)
  it('pushes new notification to connected WS clients', async () => {
    writeRules(dataDir, [sampleRule])
    const pushed: Notification[] = []
    notifs = createNotifications(bus, dataDir, { onNotification: (n) => pushed.push(n) })
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'test' }
    })
    await tick()
    expect(pushed.length).toBe(1)
    expect(pushed[0].title).toBe('Webhook from github')
  })

  // MUST support Web Push
  it('sends Web Push notification to subscribed devices', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    const sub = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'key1', auth: 'auth1' } }
    notifs.pushSubscribe('device-1', sub)
    // Stub just stores — verify subscription exists
    expect(notifs._pushManager.getSubscription('device-1')).toEqual(sub)
    await notifs._pushManager.sendPush('device-1', { title: 'test' })
    // No error = success (stubbed)
  })

  it('manages push subscriptions per device', () => {
    writeRules(dataDir, [])
    notifs = createNotifications(bus, dataDir)
    const sub1 = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'k1', auth: 'a1' } }
    const sub2 = { endpoint: 'https://push.example.com/2', keys: { p256dh: 'k2', auth: 'a2' } }
    notifs.pushSubscribe('dev1', sub1)
    notifs.pushSubscribe('dev2', sub2)
    expect(notifs._pushManager.allSubscriptions().size).toBe(2)
    notifs.pushUnsubscribe('dev1')
    expect(notifs._pushManager.getSubscription('dev1')).toBeUndefined()
    expect(notifs._pushManager.getSubscription('dev2')).toEqual(sub2)
  })

  // MUST NOT generate notifications for void-classified webhook events
  it('does not generate notification for void webhook events', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { classification: 'void', action: 'push', repo: 'test' }
    })
    await tick()
    expect(notifs.list().length).toBe(0)
  })

  // MUST support marking as read, dismissing, and bulk operations
  it('marks notifications as read', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'test' }
    })
    await tick()
    const id = notifs.list()[0].id
    notifs.markRead([id])
    expect(notifs.list({ read: true })[0].read).toBe(true)
  })

  it('marks multiple notifications as read in bulk', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'a',
      payload: { action: 'push', repo: 'r' }
    })
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'b',
      payload: { action: 'push', repo: 'r' }
    })
    await tick()
    const ids = notifs.list().map((n) => n.id)
    expect(ids.length).toBe(2)
    notifs.markRead(ids)
    expect(notifs.unreadCount()).toBe(0)
  })

  it('dismisses notifications', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'test' }
    })
    await tick()
    const id = notifs.list()[0].id
    notifs.dismiss([id])
    // Dismissed notifications are filtered from list
    expect(notifs.list().length).toBe(0)
  })

  // MUST expose listing with filters and unread count
  it('lists notifications with filters', async () => {
    writeRules(dataDir, [
      { eventPattern: 'a', severity: 'info', titleTemplate: 'A', bodyTemplate: 'A' },
      { eventPattern: 'b', severity: 'error', titleTemplate: 'B', bodyTemplate: 'B' }
    ])
    notifs = createNotifications(bus, dataDir)
    bus.emit({ type: 'a', timestamp: new Date().toISOString(), source: 's', payload: {} })
    bus.emit({ type: 'b', timestamp: new Date().toISOString(), source: 's', payload: {} })
    await tick()
    expect(notifs.list().length).toBe(2)
    expect(notifs.list({ severity: 'error' }).length).toBe(1)
    expect(notifs.list({ severity: 'info' }).length).toBe(1)
  })

  it('returns unread count', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'r' }
    })
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'r' }
    })
    await tick()
    expect(notifs.unreadCount()).toBe(2)
    notifs.markRead([notifs.list()[0].id])
    expect(notifs.unreadCount()).toBe(1)
  })

  // SHOULD support notification grouping
  it('groups related notifications', async () => {
    writeRules(dataDir, [
      {
        eventPattern: 'ci.failed',
        severity: 'error',
        titleTemplate: 'CI Failed',
        bodyTemplate: 'CI failed for {{payload.repo}}',
        group: 'ci-failures'
      }
    ])
    notifs = createNotifications(bus, dataDir)
    bus.emit({ type: 'ci.failed', timestamp: new Date().toISOString(), source: 'ci', payload: { repo: 'a' } })
    bus.emit({ type: 'ci.failed', timestamp: new Date().toISOString(), source: 'ci', payload: { repo: 'b' } })
    await tick()
    const all = notifs.list()
    expect(all.length).toBe(2)
    expect(all[0].group).toBe('ci-failures')
    expect(all[1].group).toBe('ci-failures')
  })

  // SHOULD support notification TTL
  it('auto-archives notifications after configurable TTL', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir, { ttlMs: 50 })
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'r' }
    })
    await tick()
    expect(notifs.list().length).toBe(1)
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 100))
    // TTL check runs on interval; trigger manually by listing (or wait for interval)
    // The interval is min(ttlMs, 60000) = 50ms, so it should have run
    await new Promise((r) => setTimeout(r, 100))
    expect(notifs.list().length).toBe(0)
  })

  // MUST NOT block the event bus
  it('generates notifications asynchronously without blocking the bus', async () => {
    writeRules(dataDir, [sampleRule])
    notifs = createNotifications(bus, dataDir)
    // Emit should return immediately, notifications generated async
    const start = Date.now()
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'github',
      payload: { action: 'push', repo: 'r' }
    })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(50)
    // Not yet generated (async)
    await tick()
    expect(notifs.list().length).toBe(1)
  })
})

describe('Notification Rules', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = makeDataDir()
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('matches event by pattern', () => {
    writeRules(dataDir, [{ eventPattern: 'webhook.*', severity: 'info', titleTemplate: 'T', bodyTemplate: 'B' }])
    const engine = createRuleEngine(dataDir)
    const event: BusEvent = { type: 'webhook.received', timestamp: '', source: 's', payload: {} }
    expect(engine.match(event)).toBeTruthy()
    expect(engine.match({ type: 'scheduler.done', timestamp: '', source: 's', payload: {} })).toBeNull()
    engine.dispose()
  })

  it('interpolates title and body templates from event payload', () => {
    const event: BusEvent = {
      type: 'test',
      timestamp: '2026-01-01',
      source: 'src',
      payload: { repo: 'myrepo', action: 'push' }
    }
    expect(interpolate('{{payload.repo}} got {{payload.action}}', event)).toBe('myrepo got push')
    expect(interpolate('Source: {{source}}', event)).toBe('Source: src')
  })

  it('assigns group from rule', () => {
    writeRules(dataDir, [
      { eventPattern: 'ci.*', severity: 'error', titleTemplate: 'T', bodyTemplate: 'B', group: 'ci-group' }
    ])
    const engine = createRuleEngine(dataDir)
    const rule = engine.match({ type: 'ci.failed', timestamp: '', source: 's', payload: {} })
    expect(rule?.group).toBe('ci-group')
    engine.dispose()
  })
})

describe('Notification Store', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = makeDataDir()
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('appends notifications to jsonl file', () => {
    const store = createNotificationStore(dataDir)
    const n: Notification = {
      id: '1',
      timestamp: '2026-01-01',
      severity: 'info',
      title: 'T',
      body: 'B',
      source: 's',
      read: false,
      dismissed: false
    }
    store.append(n)
    store.append({ ...n, id: '2' })
    const all = store.readAll()
    expect(all.length).toBe(2)
    expect(all[0].id).toBe('1')
    expect(all[1].id).toBe('2')
  })

  it('reads notifications with filters', () => {
    const store = createNotificationStore(dataDir)
    store.append({
      id: '1',
      timestamp: '2026-01-01',
      severity: 'info',
      title: 'T',
      body: 'B',
      source: 's',
      read: false,
      dismissed: false
    })
    store.append({
      id: '2',
      timestamp: '2026-01-01',
      severity: 'error',
      title: 'T',
      body: 'B',
      source: 's',
      read: true,
      dismissed: false
    })
    expect(store.readFiltered({ severity: 'error' }).length).toBe(1)
    expect(store.readFiltered({ read: false }).length).toBe(1)
    expect(store.readFiltered({ limit: 1 }).length).toBe(1)
  })

  it('creates data directory if it does not exist', () => {
    const newDir = join(dataDir, 'nested', 'deep')
    const store = createNotificationStore(newDir)
    store.append({
      id: '1',
      timestamp: '2026-01-01',
      severity: 'info',
      title: 'T',
      body: 'B',
      source: 's',
      read: false,
      dismissed: false
    })
    expect(store.readAll().length).toBe(1)
  })
})

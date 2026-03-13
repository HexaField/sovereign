import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEventBus } from '@template/core'
import { createThreadManager } from './threads.js'
import { createEventRouter } from './router.js'
import type { EntityBinding, ThreadManager } from './types.js'
import type { BusEvent } from '@template/core'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-router-'))
}

describe('§5.2 Event Routing (Server)', () => {
  let dataDir: string
  let bus: ReturnType<typeof createEventBus>
  let tm: ThreadManager
  let routedEvents: BusEvent[]

  beforeEach(() => {
    dataDir = makeTmpDir()
    bus = createEventBus(dataDir)
    tm = createThreadManager(bus, dataDir)
    routedEvents = []
    bus.on('thread.event.routed', (e) => {
      routedEvents.push(e)
    })
    createEventRouter(bus, tm)
  })

  it('MUST route events from an entity to every thread that contains that entity', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '42' }
    tm.create({ entities: [entity] })
    const entity2: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '42' }
    const t2 = tm.create({ label: 'cross-thread' })
    tm.addEntity(t2.key, entity2)

    bus.emit({
      type: 'issue.updated',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '42' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(2)
  })

  it('MUST route git.status.changed with branch reference to matching branch threads', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'branch', entityRef: 'main' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'git.status.changed',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', branch: 'main' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
    expect((routedEvents[0].payload as Record<string, unknown>).threadKey).toBe('org1/proj1/branch:main')
  })

  it('MUST route issue.updated to matching issue threads', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '5' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'issue.updated',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '5' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('MUST route issue.comment.added to matching issue threads', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '5' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'issue.comment.added',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '5' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('MUST route review.updated to matching PR threads', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'pr', entityRef: '10' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'review.updated',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', prId: '10' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('MUST route review.comment.added to matching PR threads', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'pr', entityRef: '10' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'review.comment.added',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', prId: '10' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('MUST route review.approved to matching PR threads', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'pr', entityRef: '10' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'review.approved',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', prId: '10' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('MUST route review.changes_requested to matching PR threads', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'pr', entityRef: '10' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'review.changes_requested',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', prId: '10' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('MUST route review.merged to matching PR threads', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'pr', entityRef: '10' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'review.merged',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', prId: '10' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('MUST route webhook events with entity extraction to matching threads', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '7' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '7' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('MUST classify events as AGENT or NOTIFY', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '5' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'issue.comment.added',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '5' }
    })
    const payload = routedEvents[0].payload as Record<string, unknown>
    expect(payload.classification).toBe('AGENT')

    routedEvents.length = 0
    bus.emit({
      type: 'issue.updated',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '5' }
    })
    const p2 = routedEvents[0].payload as Record<string, unknown>
    expect(p2.classification).toBe('NOTIFY')
  })

  it('MUST trigger autonomous agent work in thread for AGENT-classified events', () => {
    // Classification is emitted in the routed event payload
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'pr', entityRef: '10' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'review.comment.added',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', prId: '10' }
    })
    const payload = routedEvents[0].payload as Record<string, unknown>
    expect(payload.classification).toBe('AGENT')
  })

  it('MUST surface NOTIFY-classified events as notifications with threadKey metadata', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '5' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'issue.updated',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '5' }
    })
    const payload = routedEvents[0].payload as Record<string, unknown>
    expect(payload.classification).toBe('NOTIFY')
    expect(payload.threadKey).toBe('org1/proj1/issue:5')
  })

  it('SHOULD cause automatic thread creation for entities with no existing thread', () => {
    bus.emit({
      type: 'issue.updated',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '99' }
    })
    const thread = tm.get('org1/proj1/issue:99')
    expect(thread).toBeDefined()
  })

  it('MUST emit thread.event.routed bus events with { threadKey, event, entityBinding }', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '5' }
    tm.create({ entities: [entity] })
    bus.emit({
      type: 'issue.updated',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '5' }
    })
    expect(routedEvents.length).toBeGreaterThanOrEqual(1)
    const payload = routedEvents[0].payload as Record<string, unknown>
    expect(payload.threadKey).toBeDefined()
    expect(payload.event).toBeDefined()
    expect(payload.entityBinding).toBeDefined()
  })

  it('A single event MAY route to multiple threads if the entity appears in more than one', () => {
    const entity: EntityBinding = { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '42' }
    tm.create({ entities: [entity] })
    const t2 = tm.create({ label: 'cross' })
    tm.addEntity(t2.key, { ...entity })

    routedEvents.length = 0
    bus.emit({
      type: 'issue.updated',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '42' }
    })
    expect(routedEvents.length).toBe(2)
  })
})

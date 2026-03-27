// Threads — Thread Registry, auto-creation, entity management

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { ThreadInfo, EntityBinding, ThreadEvent, ThreadFilter, ThreadManager, EntityType } from './types.js'

function entityKey(entity: EntityBinding): string {
  return `${entity.orgId}/${entity.projectId}/${entity.entityType}:${entity.entityRef}`
}

function generateThreadKey(entities?: EntityBinding[], label?: string): string {
  if (entities && entities.length > 0) {
    return entityKey(entities[0])
  }
  return label ?? `thread-${Date.now()}`
}

function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function createThreadManager(bus: EventBus, dataDir: string): ThreadManager {
  const registryPath = path.join(dataDir, 'threads', 'registry.json')
  const threads = new Map<string, ThreadInfo>()
  const events = new Map<string, ThreadEvent[]>()

  // Load from disk
  if (fs.existsSync(registryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
      if (Array.isArray(data.threads)) {
        for (const t of data.threads) threads.set(t.key, t)
      }
      if (data.events) {
        for (const [k, v] of Object.entries(data.events)) {
          events.set(k, v as ThreadEvent[])
        }
      }
    } catch {
      /* fresh start */
    }
  }

  function persist(): void {
    const data = {
      threads: [...threads.values()],
      events: Object.fromEntries(events)
    }
    atomicWrite(registryPath, JSON.stringify(data, null, 2))
  }

  function create(opts: { label?: string; entities?: EntityBinding[]; orgId?: string }): ThreadInfo {
    const key = generateThreadKey(opts.entities, opts.label)
    if (threads.has(key)) return threads.get(key)!

    const now = Date.now()
    const thread: ThreadInfo = {
      key,
      orgId: opts.orgId ?? '_global',
      entities: opts.entities ?? [],
      label: opts.label,
      lastActivity: now,
      unreadCount: 0,
      agentStatus: 'idle',
      createdAt: now,
      archived: false
    }
    threads.set(key, thread)
    persist()
    bus.emit({ type: 'thread.created', timestamp: new Date().toISOString(), source: 'threads', payload: { thread } })
    return thread
  }

  function get(key: string): ThreadInfo | undefined {
    return threads.get(key)
  }

  function createIfNotExists(opts: {
    key: string
    label?: string
    orgId?: string
    parentThreadKey?: string
    isSubagent?: boolean
  }): ThreadInfo {
    if (threads.has(opts.key)) return threads.get(opts.key)!

    const now = Date.now()
    const thread: ThreadInfo = {
      key: opts.key,
      orgId: opts.orgId ?? '_global',
      entities: [],
      label: opts.label,
      lastActivity: now,
      unreadCount: 0,
      agentStatus: 'idle',
      createdAt: now,
      archived: false,
      parentThreadKey: opts.parentThreadKey,
      isSubagent: opts.isSubagent
    }
    threads.set(opts.key, thread)
    persist()
    bus.emit({ type: 'thread.created', timestamp: new Date().toISOString(), source: 'threads', payload: { thread } })
    return thread
  }

  function list(filter?: ThreadFilter): ThreadInfo[] {
    let results = [...threads.values()]
    if (filter) {
      if (filter.orgId)
        results = results.filter((t) => t.orgId === filter.orgId || t.entities.some((e) => e.orgId === filter.orgId))
      if (filter.projectId) results = results.filter((t) => t.entities.some((e) => e.projectId === filter.projectId))
      if (filter.entityType) results = results.filter((t) => t.entities.some((e) => e.entityType === filter.entityType))
      if (filter.archived !== undefined) results = results.filter((t) => t.archived === filter.archived)
      if (filter.active) results = results.filter((t) => !t.archived)
    }
    results.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    return results
  }

  function update(key: string, patch: { label?: string; orgId?: string }): ThreadInfo | undefined {
    const thread = threads.get(key)
    if (!thread) return undefined
    if (patch.label !== undefined) thread.label = patch.label
    if (patch.orgId !== undefined) thread.orgId = patch.orgId
    thread.lastActivity = Date.now()
    persist()
    bus.emit({
      type: 'thread.updated',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadKey: key, patch }
    })
    return thread
  }

  function del(key: string): boolean {
    const thread = threads.get(key)
    if (!thread) return false
    thread.archived = true
    persist()
    bus.emit({
      type: 'thread.deleted',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadKey: key }
    })
    return true
  }

  function addEntity(key: string, entity: EntityBinding): ThreadInfo | undefined {
    const thread = threads.get(key)
    if (!thread) return undefined
    const exists = thread.entities.some((e) => entityKey(e) === entityKey(entity))
    if (!exists) {
      thread.entities.push(entity)
      thread.lastActivity = Date.now()
      persist()
      bus.emit({
        type: 'thread.entity.added',
        timestamp: new Date().toISOString(),
        source: 'threads',
        payload: { threadKey: key, entity }
      })
    }
    return thread
  }

  function removeEntity(key: string, entityType: EntityType, entityRef: string): ThreadInfo | undefined {
    const thread = threads.get(key)
    if (!thread) return undefined
    thread.entities = thread.entities.filter((e) => !(e.entityType === entityType && e.entityRef === entityRef))
    thread.lastActivity = Date.now()
    persist()
    bus.emit({
      type: 'thread.entity.removed',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadKey: key, entityType, entityRef }
    })
    return thread
  }

  function getEntities(key: string): EntityBinding[] {
    return threads.get(key)?.entities ?? []
  }

  function getThreadsForEntity(entity: EntityBinding): ThreadInfo[] {
    return [...threads.values()].filter((t) =>
      t.entities.some(
        (e) =>
          e.entityType === entity.entityType &&
          e.entityRef === entity.entityRef &&
          e.orgId === entity.orgId &&
          e.projectId === entity.projectId
      )
    )
  }

  function addEvent(key: string, event: ThreadEvent): void {
    if (!events.has(key)) events.set(key, [])
    events.get(key)!.push(event)
    const thread = threads.get(key)
    if (thread) {
      thread.lastActivity = event.timestamp
      persist()
    }
  }

  function touch(key: string): void {
    const thread = threads.get(key)
    if (thread) {
      thread.lastActivity = Date.now()
      persist()
    }
  }

  function getEvents(key: string, opts?: { limit?: number; offset?: number; since?: number }): ThreadEvent[] {
    let evts = events.get(key) ?? []
    if (opts?.since) evts = evts.filter((e) => e.timestamp >= opts.since!)
    const offset = opts?.offset ?? 0
    const limit = opts?.limit ?? 50
    return evts.slice(offset, offset + limit)
  }

  // Auto-create threads on bus events
  bus.on('worktree.created', (event) => {
    const p = event.payload as { orgId: string; projectId: string; branch: string }
    const entity: EntityBinding = { orgId: p.orgId, projectId: p.projectId, entityType: 'branch', entityRef: p.branch }
    const existing = getThreadsForEntity(entity)
    if (existing.length === 0) create({ entities: [entity] })
  })

  bus.on('issue.created', (event) => {
    const p = event.payload as { orgId: string; projectId: string; issueId: string }
    const entity: EntityBinding = { orgId: p.orgId, projectId: p.projectId, entityType: 'issue', entityRef: p.issueId }
    const existing = getThreadsForEntity(entity)
    if (existing.length === 0) create({ entities: [entity] })
  })

  bus.on('review.created', (event) => {
    const p = event.payload as { orgId: string; projectId: string; prId: string }
    const entity: EntityBinding = { orgId: p.orgId, projectId: p.projectId, entityType: 'pr', entityRef: p.prId }
    const existing = getThreadsForEntity(entity)
    if (existing.length === 0) create({ entities: [entity] })
  })

  return {
    create,
    createIfNotExists,
    get,
    update,
    list,
    delete: del,
    addEntity,
    removeEntity,
    getEntities,
    getThreadsForEntity,
    addEvent,
    touch,
    getEvents
  }
}

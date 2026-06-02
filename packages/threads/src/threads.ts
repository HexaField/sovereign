// Threads — Thread Registry, auto-creation, entity management
//
// Storage layout (post-membrane migration):
//
//   <dataDir>/threads.json          - thread metadata, new shape
//   <dataDir>/threads/events.json   - per-thread event log
//   <dataDir>/threads/registry.json - LEGACY. Read once at boot if
//                                     threads.json doesn't exist, then
//                                     superseded. Left on disk for
//                                     rollback safety, never re-written.
//
// Each `ThreadInfo` holds `membraneId` (the social/privacy context, see
// @sovereign/membranes) and `workspaceIds` (the code contexts attached
// to the thread). The legacy `orgId` field has been removed; on first
// boot the migration below reads it, infers `membraneId` via
// `membranes.json`, and persists the new shape.

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

/**
 * Build `orgId → membraneId` lookup from `<dataDir>/membranes.json`.
 * First membrane that contains the orgId in its `workspaceIds` wins —
 * deterministic, source order preserved.
 */
function buildOrgToMembraneMap(dataDir: string): Map<string, string> {
  const file = path.join(dataDir, 'membranes.json')
  const map = new Map<string, string>()
  if (!fs.existsSync(file)) return map
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const membranes: Array<{ id: string; workspaceIds?: string[] }> = parsed?.membranes ?? []
    for (const m of membranes) {
      for (const orgId of m.workspaceIds ?? []) {
        if (!map.has(orgId)) map.set(orgId, m.id)
      }
    }
  } catch {
    /* tolerate corrupt file */
  }
  return map
}

/**
 * Take a legacy thread record (with `orgId`) and return the new shape.
 *
 * Mapping rules:
 *   - `orgId === '_global'` or undefined → `workspaceIds = []` (global)
 *   - any other orgId → `workspaceIds = [orgId]`
 *   - `membraneId` resolved via the orgId→membrane lookup; if no match,
 *     leave undefined (UI shows under "Unassigned" / personal default).
 */
function migrateLegacyThread(t: any, orgToMembrane: Map<string, string>): ThreadInfo {
  const legacyOrgId: string | undefined = t.orgId
  const workspaceIds: string[] = !legacyOrgId || legacyOrgId === '_global' ? [] : [legacyOrgId]
  const membraneId: string | undefined = t.membraneId ?? (legacyOrgId ? orgToMembrane.get(legacyOrgId) : undefined)
  return {
    key: t.key,
    membraneId,
    workspaceIds: Array.isArray(t.workspaceIds) ? t.workspaceIds : workspaceIds,
    entities: t.entities ?? [],
    label: t.label,
    lastActivity: t.lastActivity ?? Date.now(),
    unreadCount: t.unreadCount ?? 0,
    agentStatus: t.agentStatus ?? 'idle',
    createdAt: t.createdAt ?? Date.now(),
    archived: !!t.archived
  }
}

export function createThreadManager(bus: EventBus, dataDir: string): ThreadManager {
  const threadsPath = path.join(dataDir, 'threads.json')
  const eventsPath = path.join(dataDir, 'threads', 'events.json')
  const legacyRegistryPath = path.join(dataDir, 'threads', 'registry.json')

  const threads = new Map<string, ThreadInfo>()
  const events = new Map<string, ThreadEvent[]>()

  // ── Load threads ────────────────────────────────────────────────────
  //
  // Order of precedence:
  //   1. threads.json (new shape, post-migration)
  //   2. legacy registry.json (one-time migration into threads.json)
  //   3. empty (fresh install)
  if (fs.existsSync(threadsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(threadsPath, 'utf-8'))
      const orgMap = buildOrgToMembraneMap(dataDir)
      let normaliseCount = 0
      for (const t of data.threads ?? []) {
        // Defensive: a hand-edited threads.json may still have orgId. Normalise.
        if (t && Object.prototype.hasOwnProperty.call(t, 'orgId')) normaliseCount++
        threads.set(t.key, migrateLegacyThread(t, orgMap))
      }
      // If any record carried a legacy `orgId`, rewrite the file once so
      // subsequent reads start clean. The in-memory state was already
      // normalised by `migrateLegacyThread`, so this is just disk hygiene.
      if (normaliseCount > 0) {
        persistThreadsImmediate()
        // eslint-disable-next-line no-console
        console.log(`[threads] normalised ${normaliseCount} threads (stripped legacy orgId field) in ${threadsPath}`)
      }
    } catch {
      /* fresh start */
    }
  } else if (fs.existsSync(legacyRegistryPath)) {
    try {
      const orgMap = buildOrgToMembraneMap(dataDir)
      const legacy = JSON.parse(fs.readFileSync(legacyRegistryPath, 'utf-8'))
      let migrated = 0
      for (const t of legacy.threads ?? []) {
        threads.set(t.key, migrateLegacyThread(t, orgMap))
        migrated++
      }
      if (migrated > 0) {
        persistThreadsImmediate()
        // eslint-disable-next-line no-console
        console.log(`[threads] one-time migration: rewrote ${migrated} legacy threads into ${threadsPath}`)
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[threads] legacy thread migration failed:', err)
    }
  }

  // ── Load events ─────────────────────────────────────────────────────
  //
  // Prefer the new split file. Fall back to legacy `registry.json.events`
  // for a single boot, then persist into the new file on first event write.
  if (fs.existsSync(eventsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(eventsPath, 'utf-8'))
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) events.set(k, v as ThreadEvent[])
      }
    } catch {
      /* ignore */
    }
  } else if (fs.existsSync(legacyRegistryPath)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyRegistryPath, 'utf-8'))
      if (legacy.events && typeof legacy.events === 'object') {
        for (const [k, v] of Object.entries(legacy.events)) {
          if (Array.isArray(v)) events.set(k, v as ThreadEvent[])
        }
        persistEventsImmediate()
      }
    } catch {
      /* ignore */
    }
  }

  function persistThreadsImmediate(): void {
    atomicWrite(threadsPath, JSON.stringify({ version: 1, threads: [...threads.values()] }, null, 2))
  }

  function persistEventsImmediate(): void {
    atomicWrite(eventsPath, JSON.stringify(Object.fromEntries(events), null, 2))
  }

  function persist(): void {
    persistThreadsImmediate()
  }

  function persistEvents(): void {
    persistEventsImmediate()
  }

  function create(opts: {
    label?: string
    entities?: EntityBinding[]
    membraneId?: string
    workspaceIds?: string[]
  }): ThreadInfo {
    const key = generateThreadKey(opts.entities, opts.label)
    if (threads.has(key)) return threads.get(key)!

    // If no explicit workspaceIds but entities are bound, derive the
    // workspace from the first entity's orgId — a sensible default that
    // matches the pre-membrane behaviour.
    const derivedWorkspaceIds =
      opts.workspaceIds ?? (opts.entities && opts.entities.length > 0 ? [opts.entities[0].orgId] : [])

    const now = Date.now()
    const thread: ThreadInfo = {
      key,
      membraneId: opts.membraneId,
      workspaceIds: derivedWorkspaceIds,
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

  function list(filter?: ThreadFilter): ThreadInfo[] {
    let results = [...threads.values()]
    if (filter) {
      if (filter.workspaceId !== undefined) {
        const w = filter.workspaceId
        results = results.filter((t) => {
          if (w === '_global') {
            return t.workspaceIds.length === 0 && t.entities.length === 0
          }
          return t.workspaceIds.includes(w) || t.entities.some((e) => e.orgId === w)
        })
      }
      if (filter.membraneId !== undefined) results = results.filter((t) => t.membraneId === filter.membraneId)
      if (filter.projectId) results = results.filter((t) => t.entities.some((e) => e.projectId === filter.projectId))
      if (filter.entityType) results = results.filter((t) => t.entities.some((e) => e.entityType === filter.entityType))
      if (filter.archived !== undefined) results = results.filter((t) => t.archived === filter.archived)
      if (filter.active) results = results.filter((t) => !t.archived)
    }
    results.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    return results
  }

  function update(
    key: string,
    patch: { label?: string; membraneId?: string; workspaceIds?: string[] }
  ): ThreadInfo | undefined {
    const thread = threads.get(key)
    if (!thread) return undefined
    if (patch.label !== undefined) thread.label = patch.label
    if (patch.membraneId !== undefined) thread.membraneId = patch.membraneId
    if (patch.workspaceIds !== undefined) thread.workspaceIds = patch.workspaceIds
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
    persistEvents()
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

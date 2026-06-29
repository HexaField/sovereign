// Threads — Registry, auto-creation, entity management.
//
// Identity model (post-UUID refactor):
//   - Every thread has a UUID `id` (primary key, used everywhere internally)
//   - `label` is the human-readable display name (mutable, not unique)
//   - The OpenClaw "key" / "main" concepts are GONE — there is no special
//     singleton root thread. New users see an empty thread list.
//
// Storage:
//   <dataDir>/threads.json          v2 — { version: 2, threads: ThreadInfo[] }
//   <dataDir>/threads/events.json   per-thread event log keyed by thread.id
//   <dataDir>/threads/registry.json LEGACY pre-membrane file; read once on
//                                   cold boot if threads.json is missing.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EventBus } from '@sovereign/core'
import type { ThreadInfo, EntityBinding, ThreadEvent, ThreadFilter, ThreadManager, EntityType } from './types.js'

const SCHEMA_VERSION = 2

function entityRefKey(entity: EntityBinding): string {
  return `${entity.orgId}/${entity.projectId}/${entity.entityType}:${entity.entityRef}`
}

function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, filePath)
}

/**
 * Build `orgId → membraneId` lookup from `<dataDir>/membranes.json` for the
 * membrane-inference fallback during the legacy migration. First membrane
 * that contains the orgId in its `workspaceIds` wins.
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
 * Take any legacy thread record (v1 with `key`, or pre-membrane with
 * `orgId`) and project it onto the v2 shape (id + label, no key).
 *
 * - If the input already has `id`, treat as v2 — pass-through.
 * - Otherwise mint a UUID and use the old `key` as the initial `label`.
 *
 * Note: the canonical one-shot migration lives at
 * `bin/sovereign-migrate-threads.mjs` and re-keys every dependent file
 * (sessions registry, claude-code-state, scheduler payloads). This
 * in-process fallback exists so a developer can drop a v1 file into a
 * fresh data dir and have something usable. For real installs, run the
 * external migration once.
 */
function projectToV2(raw: any, orgToMembrane: Map<string, string>): ThreadInfo {
  const legacyOrgId: string | undefined = raw.orgId
  const workspaceIds: string[] = Array.isArray(raw.workspaceIds)
    ? raw.workspaceIds
    : !legacyOrgId || legacyOrgId === '_global'
      ? []
      : [legacyOrgId]
  const membraneId: string | undefined = raw.membraneId ?? (legacyOrgId ? orgToMembrane.get(legacyOrgId) : undefined)
  return {
    id: raw.id ?? randomUUID(),
    label: raw.label ?? raw.key ?? 'untitled',
    membraneId,
    workspaceIds,
    entities: raw.entities ?? [],
    lastActivity: raw.lastActivity ?? Date.now(),
    unreadCount: raw.unreadCount ?? 0,
    agentStatus: raw.agentStatus ?? 'idle',
    createdAt: raw.createdAt ?? Date.now(),
    archived: !!raw.archived
  }
}

export function createThreadManager(bus: EventBus, dataDir: string): ThreadManager {
  const threadsPath = path.join(dataDir, 'threads.json')
  const eventsPath = path.join(dataDir, 'threads', 'events.json')
  const legacyRegistryPath = path.join(dataDir, 'threads', 'registry.json')

  /** Primary store, keyed by Thread.id (UUID). */
  const threads = new Map<string, ThreadInfo>()
  /** Per-thread events, keyed by Thread.id. */
  const events = new Map<string, ThreadEvent[]>()

  // ── Load threads ────────────────────────────────────────────────────
  if (fs.existsSync(threadsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(threadsPath, 'utf-8'))
      const orgMap = buildOrgToMembraneMap(dataDir)
      let recoveryCount = 0
      for (const raw of data.threads ?? []) {
        const projected = projectToV2(raw, orgMap)
        // Defensive: any record without an `id` is v1; count the recovery so
        // we can disk-rewrite once.
        if (!raw?.id) recoveryCount++
        threads.set(projected.id, projected)
      }
      if (recoveryCount > 0) {
        persistThreadsImmediate()
        // eslint-disable-next-line no-console
        console.log(`[threads] in-process recovery: minted UUIDs for ${recoveryCount} legacy records → ${threadsPath}`)
      }
    } catch {
      /* fresh start */
    }
  } else if (fs.existsSync(legacyRegistryPath)) {
    try {
      const orgMap = buildOrgToMembraneMap(dataDir)
      const legacy = JSON.parse(fs.readFileSync(legacyRegistryPath, 'utf-8'))
      let migrated = 0
      for (const raw of legacy.threads ?? []) {
        const projected = projectToV2(raw, orgMap)
        threads.set(projected.id, projected)
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

  // ── Load events (keyed by Thread.id) ────────────────────────────────
  if (fs.existsSync(eventsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(eventsPath, 'utf-8'))
      for (const [id, v] of Object.entries(data)) {
        if (Array.isArray(v)) events.set(id, v as ThreadEvent[])
      }
    } catch {
      /* ignore */
    }
  } else if (fs.existsSync(legacyRegistryPath)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyRegistryPath, 'utf-8'))
      if (legacy.events && typeof legacy.events === 'object') {
        for (const [k, v] of Object.entries(legacy.events)) {
          // Legacy event keys may be `<key>`; try to resolve via label.
          const thread = [...threads.values()].find((t) => t.label === k)
          const id = thread?.id ?? k
          if (Array.isArray(v)) events.set(id, v as ThreadEvent[])
        }
        persistEventsImmediate()
      }
    } catch {
      /* ignore */
    }
  }

  function persistThreadsImmediate(): void {
    atomicWrite(threadsPath, JSON.stringify({ version: SCHEMA_VERSION, threads: [...threads.values()] }, null, 2))
  }

  function persistEventsImmediate(): void {
    atomicWrite(eventsPath, JSON.stringify(Object.fromEntries(events), null, 2))
  }

  // ── Public API ──────────────────────────────────────────────────────

  function create(opts: {
    label: string
    entities?: EntityBinding[]
    membraneId?: string
    workspaceIds?: string[]
    contextWindow?: number
  }): ThreadInfo {
    if (!opts.label?.trim()) {
      throw new Error('ThreadManager.create: label is required (UUID model — labels carry the display name)')
    }
    // If the caller bound the thread to entities but didn't pre-pick a
    // workspace, default to the first entity's orgId — preserves the
    // pre-refactor auto-association behaviour.
    const derivedWorkspaceIds =
      opts.workspaceIds ?? (opts.entities && opts.entities.length > 0 ? [opts.entities[0].orgId] : [])

    const now = Date.now()
    const thread: ThreadInfo = {
      id: randomUUID(),
      label: opts.label.trim(),
      membraneId: opts.membraneId,
      workspaceIds: derivedWorkspaceIds,
      entities: opts.entities ?? [],
      contextWindow: opts.contextWindow,
      lastActivity: now,
      unreadCount: 0,
      agentStatus: 'idle',
      createdAt: now,
      archived: false
    }
    threads.set(thread.id, thread)
    persistThreadsImmediate()
    bus.emit({
      type: 'thread.created',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { thread }
    })
    return thread
  }

  function get(id: string): ThreadInfo | undefined {
    return threads.get(id)
  }

  function getByLabel(label: string): ThreadInfo | undefined {
    return [...threads.values()].find((t) => t.label === label)
  }

  function resolve(idOrLabel: string): ThreadInfo | undefined {
    return threads.get(idOrLabel) ?? getByLabel(idOrLabel)
  }

  function list(filter?: ThreadFilter): ThreadInfo[] {
    let results = [...threads.values()]
    if (filter) {
      if (filter.workspaceId !== undefined) {
        const w = filter.workspaceId
        results = results.filter((t) => {
          if (w === '_global') return t.workspaceIds.length === 0 && t.entities.length === 0
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
    id: string,
    patch: { label?: string; membraneId?: string; workspaceIds?: string[]; contextWindow?: number }
  ): ThreadInfo | undefined {
    const thread = threads.get(id)
    if (!thread) return undefined
    if (patch.label !== undefined) thread.label = patch.label
    if (patch.membraneId !== undefined) thread.membraneId = patch.membraneId
    if (patch.workspaceIds !== undefined) thread.workspaceIds = patch.workspaceIds
    if (patch.contextWindow !== undefined) thread.contextWindow = patch.contextWindow
    thread.lastActivity = Date.now()
    persistThreadsImmediate()
    bus.emit({
      type: 'thread.updated',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadId: id, patch }
    })
    return thread
  }

  function del(id: string): boolean {
    const thread = threads.get(id)
    if (!thread) return false
    thread.archived = true
    persistThreadsImmediate()
    bus.emit({
      type: 'thread.deleted',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadId: id }
    })
    return true
  }

  function addEntity(id: string, entity: EntityBinding): ThreadInfo | undefined {
    const thread = threads.get(id)
    if (!thread) return undefined
    const exists = thread.entities.some((e) => entityRefKey(e) === entityRefKey(entity))
    if (!exists) {
      thread.entities.push(entity)
      thread.lastActivity = Date.now()
      persistThreadsImmediate()
      bus.emit({
        type: 'thread.entity.added',
        timestamp: new Date().toISOString(),
        source: 'threads',
        payload: { threadId: id, entity }
      })
    }
    return thread
  }

  function removeEntity(id: string, entityType: EntityType, entityRef: string): ThreadInfo | undefined {
    const thread = threads.get(id)
    if (!thread) return undefined
    thread.entities = thread.entities.filter((e) => !(e.entityType === entityType && e.entityRef === entityRef))
    thread.lastActivity = Date.now()
    persistThreadsImmediate()
    bus.emit({
      type: 'thread.entity.removed',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadId: id, entityType, entityRef }
    })
    return thread
  }

  function getEntities(id: string): EntityBinding[] {
    return threads.get(id)?.entities ?? []
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

  function addEvent(id: string, event: ThreadEvent): void {
    if (!events.has(id)) events.set(id, [])
    events.get(id)!.push(event)
    const thread = threads.get(id)
    if (thread) {
      thread.lastActivity = event.timestamp
      persistThreadsImmediate()
    }
    persistEventsImmediate()
  }

  function touch(id: string): void {
    const thread = threads.get(id)
    if (!thread) return
    thread.lastActivity = Date.now()
    persistThreadsImmediate()
    // Broadcast so connected clients re-sort the thread dropdown and
    // re-render "Nm ago" without polling.
    bus.emit({
      type: 'thread.updated',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadId: id, patch: { lastActivity: thread.lastActivity }, thread }
    })
  }

  /**
   * Increment a thread's `unreadCount` by one, persist, and broadcast a
   * `thread.updated` bus event so connected clients re-render their badge.
   * Returns the new count, or `undefined` if the thread no longer exists.
   *
   * Caller is responsible for the suppression policy (mute state, focus
   * tracking) — this is the dumb mutator the orchestrator drives once it's
   * decided a notification is warranted.
   */
  function markUnreadIncrement(id: string): number | undefined {
    const thread = threads.get(id)
    if (!thread) return undefined
    thread.unreadCount = (thread.unreadCount ?? 0) + 1
    persistThreadsImmediate()
    bus.emit({
      type: 'thread.updated',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadId: id, patch: { unreadCount: thread.unreadCount }, thread }
    })
    return thread.unreadCount
  }

  /**
   * Reset a thread's `unreadCount` to zero (idempotent; only fires
   * `thread.updated` when the count actually changes).
   */
  function clearUnread(id: string): boolean {
    const thread = threads.get(id)
    if (!thread) return false
    if ((thread.unreadCount ?? 0) === 0) return false
    thread.unreadCount = 0
    persistThreadsImmediate()
    bus.emit({
      type: 'thread.updated',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadId: id, patch: { unreadCount: 0 }, thread }
    })
    return true
  }

  function getEvents(id: string, opts?: { limit?: number; offset?: number; since?: number }): ThreadEvent[] {
    let evts = events.get(id) ?? []
    if (opts?.since) evts = evts.filter((e) => e.timestamp >= opts.since!)
    const offset = opts?.offset ?? 0
    const limit = opts?.limit ?? 50
    return evts.slice(offset, offset + limit)
  }

  // Auto-create threads on bus events. Each gets a UUID; the label is derived
  // from the entity reference so the UI shows something meaningful.
  bus.on('worktree.created', (event) => {
    const p = event.payload as { orgId: string; projectId: string; branch: string }
    const entity: EntityBinding = { orgId: p.orgId, projectId: p.projectId, entityType: 'branch', entityRef: p.branch }
    if (getThreadsForEntity(entity).length === 0) {
      create({ label: `${p.projectId}/${p.branch}`, entities: [entity] })
    }
  })

  bus.on('issue.created', (event) => {
    const p = event.payload as { orgId: string; projectId: string; issueId: string }
    const entity: EntityBinding = { orgId: p.orgId, projectId: p.projectId, entityType: 'issue', entityRef: p.issueId }
    if (getThreadsForEntity(entity).length === 0) {
      create({ label: `${p.projectId}#${p.issueId}`, entities: [entity] })
    }
  })

  bus.on('review.created', (event) => {
    const p = event.payload as { orgId: string; projectId: string; prId: string }
    const entity: EntityBinding = { orgId: p.orgId, projectId: p.projectId, entityType: 'pr', entityRef: p.prId }
    if (getThreadsForEntity(entity).length === 0) {
      create({ label: `${p.projectId} PR ${p.prId}`, entities: [entity] })
    }
  })

  return {
    create,
    get,
    getByLabel,
    resolve,
    update,
    list,
    delete: del,
    addEntity,
    removeEntity,
    getEntities,
    getThreadsForEntity,
    addEvent,
    touch,
    getEvents,
    markUnreadIncrement,
    clearUnread
  }
}

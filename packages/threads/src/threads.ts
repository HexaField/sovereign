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
//   <dataDir>/thread-folders.json   { version: 1, folders: ThreadFolder[] } —
//                                   user-made folders; threads point at one
//                                   through `folderId`.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EventBus } from '@sovereign/core'
import type {
  ThreadInfo,
  ThreadFolder,
  EntityBinding,
  ThreadEvent,
  ThreadFilter,
  ThreadManager,
  EntityType
} from './types.js'
import { assignSortOrders } from './sort-order.js'

const SCHEMA_VERSION = 2
const FOLDERS_VERSION = 1
export const MAX_FOLDER_NAME = 80
export const MAX_FOLDERS = 500

/** A folder request the manager refuses: `status` 400 (bad input) or 409 (name in use). */
export class FolderError extends Error {
  readonly status: 400 | 404 | 409
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.name = 'FolderError'
    this.status = status
  }
}

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
    contextWindow: typeof raw.contextWindow === 'number' && raw.contextWindow > 0 ? raw.contextWindow : undefined,
    subagentBackend: typeof raw.subagentBackend === 'string' ? raw.subagentBackend : undefined,
    subagentModel: typeof raw.subagentModel === 'string' ? raw.subagentModel : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    pinnedRepoPath: typeof raw.pinnedRepoPath === 'string' ? raw.pinnedRepoPath : undefined,
    pinnedAt: typeof raw.pinnedAt === 'number' && raw.pinnedAt > 0 ? raw.pinnedAt : undefined,
    sortOrder: typeof raw.sortOrder === 'number' && Number.isFinite(raw.sortOrder) ? raw.sortOrder : undefined,
    folderId: typeof raw.folderId === 'string' && raw.folderId ? raw.folderId : undefined,
    // Migrate legacy `presence: true` (boolean) → `presence: 'internal'`.
    // String roles pass through untouched; anything else is dropped. An
    // archived thread holds no role (older builds archived without clearing it).
    presence: raw.archived
      ? undefined
      : raw.presence === true
        ? 'internal'
        : raw.presence === 'internal' || raw.presence === 'gateway'
          ? raw.presence
          : undefined,
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
  const foldersPath = path.join(dataDir, 'thread-folders.json')

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

  // ── Load folders ────────────────────────────────────────────────────
  const folders = new Map<string, ThreadFolder>()
  if (fs.existsSync(foldersPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(foldersPath, 'utf-8'))
      for (const raw of data.folders ?? []) {
        if (typeof raw?.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name.trim()) continue
        folders.set(raw.id, {
          id: raw.id,
          name: raw.name.trim(),
          createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
        })
      }
    } catch {
      /* corrupt file: start without folders; threads fall back to the main list */
    }
  }
  // A thread whose folder is gone lists in the main list.
  for (const t of threads.values()) if (t.folderId && !folders.has(t.folderId)) delete t.folderId

  function persistFoldersImmediate(): void {
    atomicWrite(foldersPath, JSON.stringify({ version: FOLDERS_VERSION, folders: [...folders.values()] }, null, 2))
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
    presence?: 'internal' | 'gateway'
    subagentBackend?: string
    subagentModel?: string
    model?: string
  }): ThreadInfo {
    if (!opts.label?.trim()) {
      throw new Error('ThreadManager.create: label is required (UUID model — labels carry the display name)')
    }
    if (opts.presence) {
      // At-most-one thread per presence role. See plans/presence-thread-spec.md (R1).
      const existing = [...threads.values()].find((t) => t.presence === opts.presence && !t.archived)
      if (existing) {
        throw new Error(
          `ThreadManager.create: a '${opts.presence}' presence thread already exists (${existing.id}). Update the existing one or clear its presence role first.`
        )
      }
    }
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
      presence: opts.presence,
      subagentBackend: opts.subagentBackend,
      subagentModel: opts.subagentModel,
      ...(opts.model ? { model: opts.model } : {}),
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
    patch: {
      label?: string
      membraneId?: string
      workspaceIds?: string[]
      contextWindow?: number
      presence?: 'internal' | 'gateway' | null
      subagentBackend?: string | null
      subagentModel?: string | null
      model?: string | null
      pinnedRepoPath?: string | null
      pinned?: boolean
    }
  ): ThreadInfo | undefined {
    const thread = threads.get(id)
    if (!thread) return undefined
    const { pinned, ...rest } = patch
    // Pinning is not activity: a pin-only patch leaves `lastActivity` alone, so
    // unpinning drops the thread back where its activity puts it.
    const pinOnly = pinned !== undefined && Object.values(rest).every((v) => v === undefined)
    // A thread that changes group (pinned ↔ not) drops its manual place: it
    // lands at the top of its new group, as a thread never placed by hand.
    let droppedOrder = false
    if (pinned !== undefined) {
      const wasPinned = !!thread.pinnedAt
      if (!pinned) delete thread.pinnedAt
      else if (!thread.pinnedAt) thread.pinnedAt = Date.now()
      if (wasPinned !== pinned && thread.sortOrder !== undefined) {
        delete thread.sortOrder
        droppedOrder = true
      }
    }
    if (patch.label !== undefined) thread.label = patch.label
    if (patch.membraneId !== undefined) thread.membraneId = patch.membraneId
    if (patch.workspaceIds !== undefined) thread.workspaceIds = patch.workspaceIds
    if (patch.contextWindow !== undefined) thread.contextWindow = patch.contextWindow
    if (patch.pinnedRepoPath !== undefined) {
      if (patch.pinnedRepoPath === null) delete thread.pinnedRepoPath
      else thread.pinnedRepoPath = patch.pinnedRepoPath
    }
    if (patch.subagentBackend !== undefined) {
      if (patch.subagentBackend === null) delete thread.subagentBackend
      else thread.subagentBackend = patch.subagentBackend
    }
    if (patch.subagentModel !== undefined) {
      if (patch.subagentModel === null) delete thread.subagentModel
      else thread.subagentModel = patch.subagentModel
    }
    if (patch.model !== undefined) {
      if (patch.model === null) delete thread.model
      else thread.model = patch.model
    }
    if (patch.presence !== undefined) {
      if (patch.presence === null) {
        delete thread.presence
      } else {
        const role = patch.presence
        const conflicting = [...threads.values()].find((t) => t.presence === role && !t.archived && t.id !== id)
        if (conflicting) {
          throw new Error(
            `ThreadManager.update: cannot set presence='${role}' — thread ${conflicting.id} already carries that role.`
          )
        }
        thread.presence = role
      }
    }
    if (!pinOnly) thread.lastActivity = Date.now()
    persistThreadsImmediate()
    bus.emit({
      type: 'thread.updated',
      timestamp: new Date().toISOString(),
      source: 'threads',
      // Clients merge the patch into their thread, so a pin change goes out as
      // the stored field: `pinnedAt` (null once unpinned).
      payload: {
        threadId: id,
        patch:
          pinned === undefined
            ? rest
            : { ...rest, pinnedAt: thread.pinnedAt ?? null, ...(droppedOrder ? { sortOrder: null } : {}) }
      }
    })
    return thread
  }

  function reorder(ids: string[], opts: { pinned?: boolean } = {}): ThreadInfo[] {
    const placed = ids.map((id) => threads.get(id))
    const missing = ids.find((_, i) => !placed[i])
    if (missing !== undefined) throw new Error(`Unknown thread: ${missing}`)
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate thread id')
    const list = placed as ThreadInfo[]
    // One list at a time: the main list or one folder.
    if (list.some((t) => t.folderId !== list[0].folderId)) {
      throw new FolderError('Threads to reorder must all be in the same folder (or all in the main list)')
    }
    const pinned = opts.pinned
    // A thread joining the other group brings no place with it.
    const changesGroup = (t: ThreadInfo) => pinned !== undefined && !!t.pinnedAt !== pinned
    const slots = assignSortOrders(list.map((t) => (changesGroup(t) ? undefined : t.sortOrder)))
    const now = Date.now()
    const changes: Array<{ thread: ThreadInfo; patch: { sortOrder?: number; pinnedAt?: number | null } }> = []
    list.forEach((t, i) => {
      const patch: { sortOrder?: number; pinnedAt?: number | null } = {}
      if (changesGroup(t)) {
        if (pinned) t.pinnedAt = now
        else delete t.pinnedAt
        patch.pinnedAt = t.pinnedAt ?? null
      }
      if (t.sortOrder !== slots[i]) {
        t.sortOrder = slots[i]
        patch.sortOrder = slots[i]
      }
      if (Object.keys(patch).length) changes.push({ thread: t, patch })
    })
    if (changes.length === 0) return []
    // Placing threads is not activity: `lastActivity` stays as it was.
    persistThreadsImmediate()
    for (const { thread, patch } of changes) {
      bus.emit({
        type: 'thread.updated',
        timestamp: new Date().toISOString(),
        source: 'threads',
        payload: { threadId: thread.id, patch }
      })
    }
    return changes.map((c) => c.thread)
  }

  // ── Folders ─────────────────────────────────────────────────────────

  /** Copies: a broadcast list must not change under a later rename. */
  function listFolders(): ThreadFolder[] {
    return [...folders.values()].map((f) => ({ ...f }))
  }

  function emitFolders(): void {
    bus.emit({
      type: 'thread.folders',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { folders: listFolders() }
    })
  }

  /** A valid, unused folder name (trimmed), or a FolderError. */
  function checkName(name: unknown, exceptId?: string): string {
    if (typeof name !== 'string' || !name.trim()) throw new FolderError('A folder needs a name')
    const trimmed = name.trim()
    if (trimmed.length > MAX_FOLDER_NAME) {
      throw new FolderError(`A folder name is at most ${MAX_FOLDER_NAME} characters`)
    }
    const lower = trimmed.toLowerCase()
    const taken = [...folders.values()].find((f) => f.id !== exceptId && f.name.toLowerCase() === lower)
    if (taken) throw new FolderError(`A folder named "${taken.name}" already exists`, 409)
    return trimmed
  }

  function createFolder(name: string): ThreadFolder {
    const checked = checkName(name)
    if (folders.size >= MAX_FOLDERS) throw new FolderError(`At most ${MAX_FOLDERS} folders`)
    const folder: ThreadFolder = { id: randomUUID(), name: checked, createdAt: Date.now() }
    folders.set(folder.id, folder)
    persistFoldersImmediate()
    emitFolders()
    return { ...folder }
  }

  function renameFolder(id: string, name: string): ThreadFolder | undefined {
    const folder = folders.get(id)
    if (!folder) return undefined
    const checked = checkName(name, id)
    if (checked !== folder.name) {
      folder.name = checked
      persistFoldersImmediate()
      emitFolders()
    }
    return { ...folder }
  }

  /** Put `thread` in `folderId` (undefined = main list); returns its broadcast patch, or null if unchanged. */
  function placeInFolder(
    thread: ThreadInfo,
    folderId: string | undefined
  ): { folderId: string | null; sortOrder: null } | null {
    if (thread.folderId === folderId) return null
    if (folderId) thread.folderId = folderId
    else delete thread.folderId
    // It lands at the top of its new list, as a thread never placed by hand.
    delete thread.sortOrder
    return { folderId: folderId ?? null, sortOrder: null }
  }

  function emitThreadPatch(threadId: string, patch: Record<string, unknown>): void {
    bus.emit({
      type: 'thread.updated',
      timestamp: new Date().toISOString(),
      source: 'threads',
      payload: { threadId, patch }
    })
  }

  function deleteFolder(id: string): boolean {
    if (!folders.has(id)) return false
    folders.delete(id)
    // Its threads (archived ones too) go back to the main list.
    const moved: Array<[string, Record<string, unknown>]> = []
    for (const t of threads.values()) {
      if (t.folderId !== id) continue
      const patch = placeInFolder(t, undefined)
      if (patch) moved.push([t.id, patch])
    }
    if (moved.length) persistThreadsImmediate()
    persistFoldersImmediate()
    for (const [threadId, patch] of moved) emitThreadPatch(threadId, patch)
    emitFolders()
    return true
  }

  function moveToFolder(threadId: string, folderId: string | null): ThreadInfo | undefined {
    const thread = threads.get(threadId)
    if (!thread) return undefined
    if (folderId !== null && !folders.has(folderId)) throw new FolderError(`Folder not found: ${folderId}`, 404)
    const patch = placeInFolder(thread, folderId ?? undefined)
    if (patch) {
      // Filing a thread is not activity: `lastActivity` stays as it was.
      persistThreadsImmediate()
      emitThreadPatch(threadId, patch)
    }
    return thread
  }

  function del(id: string): boolean {
    const thread = threads.get(id)
    if (!thread) return false
    thread.archived = true
    // An archived thread plays no presence role: the presence module resolves
    // (or creates) a live thread for the role instead. History is kept.
    delete thread.presence
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

  function getPresenceThread(role: 'internal' | 'gateway'): ThreadInfo | null {
    for (const t of threads.values()) {
      if (t.presence === role && !t.archived) return t
    }
    return null
  }

  return {
    create,
    get,
    getByLabel,
    resolve,
    update,
    reorder,
    listFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    moveToFolder,
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
    clearUnread,
    getPresenceThread
  }
}

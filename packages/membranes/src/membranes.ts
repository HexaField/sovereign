// Membranes — manager (CRUD + queries)
//
// Keeps an in-memory copy of `membranes.json`, flushes on every mutation
// via the underlying atomic-write store. Emits `membrane.*` bus events
// so other modules (chat, threads, UI) can react.

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { Membrane, MembraneCreateInput, MembranePatch, MembranesData } from './types.js'
import { createMembraneStore, type MembraneStore } from './store.js'

/** File name read from each membrane's `contentPath` for context injection. */
export const MEMBRANE_CONTEXT_FILENAME = 'CONTEXT.md'

export interface MembraneManager {
  createMembrane(input: MembraneCreateInput): Membrane
  updateMembrane(id: string, patch: MembranePatch): Membrane
  deleteMembrane(id: string): void
  getMembrane(id: string): Membrane | undefined
  listMembranes(): Membrane[]

  /** Membranes that include this workspace (orgId) in `workspaceIds`. */
  listMembranesForWorkspace(orgId: string): Membrane[]

  addWorkspace(membraneId: string, orgId: string): Membrane
  removeWorkspace(membraneId: string, orgId: string): Membrane

  /**
   * Resolve the membrane's project context — the contents of
   * `<contentPath>/CONTEXT.md` — for injection into agent sessions
   * via the SDK's `appendSystemPrompt` option.
   *
   * Returns `null` when:
   *   - the membrane id is unknown,
   *   - the membrane has no `contentPath`,
   *   - or no `CONTEXT.md` exists at that path.
   *
   * Result is cached per `(membraneId, mtime)` so repeated calls during
   * normal session creation don't re-read disk. The cache is invalidated
   * automatically when the file's mtime changes; an explicit
   * `invalidateContext(id)` is also available for callers that mutate
   * the membrane definition itself.
   */
  renderContext(membraneId: string): string | null

  /** Drop the cached context for a membrane (or all membranes when omitted). */
  invalidateContext(membraneId?: string): void
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'membrane'
  )
}

export function createMembraneManager(bus: EventBus, dataDir: string): MembraneManager {
  const store: MembraneStore = createMembraneStore(dataDir)
  let state: MembranesData = store.read()

  const now = () => new Date().toISOString()
  const save = () => store.write(state)

  const emit = (type: string, payload: unknown) => {
    bus.emit({ type, timestamp: now(), source: 'membranes', payload })
  }

  const getMembrane = (id: string) => state.membranes.find((m) => m.id === id)

  const ensureUniqueId = (proposed: string): string => {
    if (!getMembrane(proposed)) return proposed
    let i = 2
    while (getMembrane(`${proposed}-${i}`)) i++
    return `${proposed}-${i}`
  }

  const createMembrane = (input: MembraneCreateInput): Membrane => {
    const id = input.id ? input.id : ensureUniqueId(slugify(input.name))
    if (getMembrane(id)) throw new Error(`Membrane already exists: ${id}`)
    const m: Membrane = {
      id,
      name: input.name,
      description: input.description,
      visibility: input.visibility ?? 'private',
      contentPath: input.contentPath,
      syncTarget: input.syncTarget,
      workspaceIds: input.workspaceIds ? [...new Set(input.workspaceIds)] : [],
      color: input.color,
      icon: input.icon,
      createdAt: now(),
      updatedAt: now()
    }
    state.membranes.push(m)
    save()
    emit('membrane.created', m)
    return m
  }

  const updateMembrane = (id: string, patch: MembranePatch): Membrane => {
    const m = getMembrane(id)
    if (!m) throw new Error(`Membrane not found: ${id}`)
    if (patch.name !== undefined) m.name = patch.name
    if (patch.description !== undefined) m.description = patch.description
    if (patch.visibility !== undefined) m.visibility = patch.visibility
    if (patch.contentPath !== undefined) m.contentPath = patch.contentPath
    if (patch.syncTarget !== undefined) m.syncTarget = patch.syncTarget
    if (patch.workspaceIds !== undefined) m.workspaceIds = [...new Set(patch.workspaceIds)]
    if (patch.color !== undefined) m.color = patch.color
    if (patch.icon !== undefined) m.icon = patch.icon
    m.updatedAt = now()
    save()
    emit('membrane.updated', m)
    return m
  }

  const deleteMembrane = (id: string): void => {
    const idx = state.membranes.findIndex((m) => m.id === id)
    if (idx === -1) throw new Error(`Membrane not found: ${id}`)
    const [removed] = state.membranes.splice(idx, 1)
    save()
    emit('membrane.deleted', removed)
  }

  const listMembranes = () => [...state.membranes]

  const listMembranesForWorkspace = (orgId: string) => state.membranes.filter((m) => m.workspaceIds.includes(orgId))

  const addWorkspace = (membraneId: string, orgId: string): Membrane => {
    const m = getMembrane(membraneId)
    if (!m) throw new Error(`Membrane not found: ${membraneId}`)
    if (!m.workspaceIds.includes(orgId)) {
      m.workspaceIds.push(orgId)
      m.updatedAt = now()
      save()
      emit('membrane.workspace.added', { membraneId, orgId })
    }
    return m
  }

  const removeWorkspace = (membraneId: string, orgId: string): Membrane => {
    const m = getMembrane(membraneId)
    if (!m) throw new Error(`Membrane not found: ${membraneId}`)
    const before = m.workspaceIds.length
    m.workspaceIds = m.workspaceIds.filter((w) => w !== orgId)
    if (m.workspaceIds.length !== before) {
      m.updatedAt = now()
      save()
      emit('membrane.workspace.removed', { membraneId, orgId })
    }
    return m
  }

  // ── Context rendering (CONTEXT.md → appendSystemPrompt) ──────────────
  //
  // Cache holds the parsed file body keyed by membraneId. Entries store
  // the mtime they were read at so we can detect on-disk edits cheaply
  // without watching the filesystem.
  interface ContextCacheEntry {
    mtimeMs: number
    body: string
  }
  const contextCache = new Map<string, ContextCacheEntry>()

  const renderContext = (membraneId: string): string | null => {
    const m = getMembrane(membraneId)
    if (!m || !m.contentPath) return null
    const filePath = path.join(m.contentPath, MEMBRANE_CONTEXT_FILENAME)
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      // Either the file doesn't exist or the path is unreachable — both
      // are silent no-ops (the global personality is still loaded).
      contextCache.delete(membraneId)
      return null
    }
    if (!stat.isFile()) return null

    const cached = contextCache.get(membraneId)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.body
    try {
      const body = fs.readFileSync(filePath, 'utf-8')
      contextCache.set(membraneId, { mtimeMs: stat.mtimeMs, body })
      return body
    } catch {
      contextCache.delete(membraneId)
      return null
    }
  }

  const invalidateContext = (membraneId?: string): void => {
    if (membraneId === undefined) contextCache.clear()
    else contextCache.delete(membraneId)
  }

  // Mutating a membrane definition itself (rename, move contentPath,
  // delete) invalidates cached context. File-content changes are caught
  // by the mtime check inside `renderContext` and don't need an event.
  bus.on('membrane.updated', (e) => {
    const id = (e.payload as { id?: string })?.id
    if (id) invalidateContext(id)
  })
  bus.on('membrane.deleted', (e) => {
    const id = (e.payload as { id?: string })?.id
    if (id) invalidateContext(id)
  })

  return {
    createMembrane,
    updateMembrane,
    deleteMembrane,
    getMembrane,
    listMembranes,
    listMembranesForWorkspace,
    addWorkspace,
    removeWorkspace,
    renderContext,
    invalidateContext
  }
}

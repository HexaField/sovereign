// Membranes — manager (CRUD + queries)
//
// Keeps an in-memory copy of `membranes.json`, flushes on every mutation
// via the underlying atomic-write store. Emits `membrane.*` bus events
// so other modules (chat, threads, UI) can react.

import type { EventBus } from '@sovereign/core'
import type { Membrane, MembraneCreateInput, MembranePatch, MembranesData } from './types.js'
import { createMembraneStore, type MembraneStore } from './store.js'

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

  return {
    createMembrane,
    updateMembrane,
    deleteMembrane,
    getMembrane,
    listMembranes,
    listMembranesForWorkspace,
    addWorkspace,
    removeWorkspace
  }
}

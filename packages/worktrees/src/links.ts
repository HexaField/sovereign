import crypto from 'node:crypto'
import type { EventBus } from '@sovereign/core'
import type { WorktreeLink } from './types.js'
import type { WorktreeStore } from './store.js'

export interface LinkManager {
  createLink(orgId: string, data: { name: string; description?: string; worktreeIds: string[] }): WorktreeLink
  getLink(orgId: string, linkId: string): WorktreeLink | undefined
  listLinks(orgId: string): WorktreeLink[]
  removeLink(orgId: string, linkId: string): void
}

export function createLinkManager(
  bus: EventBus,
  store: WorktreeStore,
  resolveWorktree: (id: string) => boolean
): LinkManager {
  const now = () => new Date().toISOString()
  const emit = (type: string, payload: unknown) => {
    bus.emit({ type, timestamp: now(), source: 'worktrees', payload })
  }

  return {
    createLink(orgId, data) {
      for (const wId of data.worktreeIds) {
        if (!resolveWorktree(wId)) throw new Error(`Worktree not found: ${wId}`)
      }
      const link: WorktreeLink = {
        id: crypto.randomUUID(),
        orgId,
        name: data.name,
        description: data.description,
        worktreeIds: data.worktreeIds,
        createdAt: now()
      }
      const links = store.readLinks(orgId)
      links.push(link)
      store.writeLinks(orgId, links)
      emit('worktree.link.created', link)
      return link
    },
    getLink(orgId, linkId) {
      return store.readLinks(orgId).find((l) => l.id === linkId)
    },
    listLinks(orgId) {
      return store.readLinks(orgId)
    },
    removeLink(orgId, linkId) {
      const links = store.readLinks(orgId)
      const idx = links.findIndex((l) => l.id === linkId)
      if (idx === -1) throw new Error(`Link not found: ${linkId}`)
      const link = links[idx]
      links.splice(idx, 1)
      store.writeLinks(orgId, links)
      emit('worktree.link.removed', link)
    }
  }
}

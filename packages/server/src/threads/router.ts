// Threads — Event Router

import type { EventBus } from '@sovereign/core'
import type { ThreadManager, EntityBinding, ThreadEvent } from './types.js'

export interface EventClassification {
  type: 'AGENT' | 'NOTIFY'
}

const AGENT_EVENTS = new Set([
  'issue.comment.added',
  'review.comment.added',
  'review.changes_requested',
  'review.approved'
])

function classifyEvent(eventType: string): EventClassification {
  if (AGENT_EVENTS.has(eventType)) return { type: 'AGENT' }
  return { type: 'NOTIFY' }
}

function extractEntity(event: { type: string; payload: unknown }): EntityBinding | undefined {
  const p = event.payload as Record<string, unknown>
  const orgId = p.orgId as string | undefined
  const projectId = p.projectId as string | undefined
  if (!orgId || !projectId) return undefined

  if (event.type.startsWith('git.status.') || event.type.startsWith('worktree.')) {
    return { orgId, projectId, entityType: 'branch', entityRef: p.branch as string }
  }
  if (event.type.startsWith('issue.')) {
    return { orgId, projectId, entityType: 'issue', entityRef: (p.issueId ?? p.entityRef) as string }
  }
  if (event.type.startsWith('review.')) {
    return { orgId, projectId, entityType: 'pr', entityRef: (p.prId ?? p.entityRef) as string }
  }
  // Webhook with explicit entity
  if (p.entityType && p.entityRef) {
    return {
      orgId,
      projectId,
      entityType: p.entityType as EntityBinding['entityType'],
      entityRef: p.entityRef as string
    }
  }
  return undefined
}

export function createEventRouter(bus: EventBus, threadManager: ThreadManager): { destroy: () => void } {
  const unsubs: Array<() => void> = []

  const patterns = ['git.status.*', 'issue.*', 'review.*', 'webhook.*']

  for (const pattern of patterns) {
    const unsub = bus.on(pattern, (event) => {
      const entity = extractEntity(event)
      if (!entity) return

      let matchingThreads = threadManager.getThreadsForEntity(entity)

      // Auto-create thread if none exists
      if (matchingThreads.length === 0) {
        threadManager.create({ entities: [entity] })
        matchingThreads = threadManager.getThreadsForEntity(entity)
      }

      const classification = classifyEvent(event.type)

      for (const thread of matchingThreads) {
        const threadEvent: ThreadEvent = {
          threadKey: thread.key,
          event: event,
          entityBinding: entity,
          timestamp: Date.now()
        }
        threadManager.addEvent(thread.key, threadEvent)

        bus.emit({
          type: 'thread.event.routed',
          timestamp: new Date().toISOString(),
          source: 'threads.router',
          payload: { threadKey: thread.key, event, entityBinding: entity, classification: classification.type }
        })
      }
    })
    unsubs.push(unsub)
  }

  return {
    destroy() {
      for (const unsub of unsubs) unsub()
    }
  }
}

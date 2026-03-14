// Threads — Types

import type { AgentStatus } from '@sovereign/core'

export type EntityType = 'branch' | 'issue' | 'pr'

export interface EntityBinding {
  orgId: string
  projectId: string
  entityType: EntityType
  entityRef: string
}

export interface ThreadInfo {
  key: string
  entities: EntityBinding[]
  label?: string
  lastActivity: number
  unreadCount: number
  agentStatus: AgentStatus
  createdAt: number
  archived: boolean
}

export interface ThreadEvent {
  threadKey: string
  event: unknown
  entityBinding: EntityBinding
  timestamp: number
}

export interface ThreadFilter {
  orgId?: string
  projectId?: string
  entityType?: EntityType
  active?: boolean
  archived?: boolean
}

export interface ForwardedMessage {
  originalContent: string
  originalRole: 'user' | 'assistant' | 'system'
  originalTimestamp: number
  sourceThread: string
  sourceThreadLabel: string
  commentary?: string
  attachments?: string[]
}

export interface ThreadManager {
  create(opts: { label?: string; entities?: EntityBinding[] }): ThreadInfo
  get(key: string): ThreadInfo | undefined
  list(filter?: ThreadFilter): ThreadInfo[]
  delete(key: string): boolean
  addEntity(key: string, entity: EntityBinding): ThreadInfo | undefined
  removeEntity(key: string, entityType: EntityType, entityRef: string): ThreadInfo | undefined
  getEntities(key: string): EntityBinding[]
  getThreadsForEntity(entity: EntityBinding): ThreadInfo[]
  addEvent(key: string, event: ThreadEvent): void
  getEvents(key: string, opts?: { limit?: number; offset?: number; since?: number }): ThreadEvent[]
}

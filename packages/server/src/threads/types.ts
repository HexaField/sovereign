// Threads — Types

import type { AgentStatus } from '@template/core'

export interface EntityBinding {
  orgId: string
  projectId: string
  entityType: 'branch' | 'issue' | 'pr'
  entityRef: string
}

export interface ThreadInfo {
  key: string
  entities: EntityBinding[]
  label?: string
  lastActivity: number
  unreadCount: number
  agentStatus: AgentStatus
}

export interface ThreadEvent {
  threadKey: string
  event: unknown
  entityBinding: EntityBinding
  timestamp: number
}

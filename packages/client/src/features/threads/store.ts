import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { AgentStatus } from '@template/core'

export interface ThreadInfo {
  key: string
  entities: { orgId: string; projectId: string; entityType: 'branch' | 'issue' | 'pr'; entityRef: string }[]
  label?: string
  lastActivity: number
  unreadCount: number
  agentStatus: AgentStatus
}

export const [threadKey, _setThreadKey] = createSignal('main')
export const [threads, _setThreads] = createSignal<ThreadInfo[]>([])

export function switchThread(_key: string): void {
  throw new Error('not implemented')
}

export function createThread(_label?: string): void {
  throw new Error('not implemented')
}

export function addEntity(_threadKey: string, _entity: ThreadInfo['entities'][0]): void {
  throw new Error('not implemented')
}

export function removeEntity(_threadKey: string, _entityType: string, _entityRef: string): void {
  throw new Error('not implemented')
}

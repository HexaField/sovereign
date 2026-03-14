// Meeting service — §8.2

import type { EventBus } from '../bus/bus.js'

export interface ActionItem {
  text: string
  assignee?: string
  dueDate?: string
  status: 'open' | 'done'
}

export interface Meeting {
  id: string
  orgId: string
  title: string
  description?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  endedAt?: string
  duration: number
  threadKey?: string
  entities?: unknown[]
  recordings: string[]
  transcript?: {
    status: 'none' | 'pending' | 'completed' | 'failed'
    text?: string
    segments?: unknown[]
    speakers?: Record<string, unknown>
    completedAt?: string
    error?: string
  }
  summary?: {
    status: 'none' | 'pending' | 'completed' | 'failed'
    text?: string
    actionItems?: ActionItem[]
    decisions?: string[]
    keyTopics?: string[]
    completedAt?: string
    error?: string
  }
  source: 'native' | 'import'
  importMeta?: {
    platform?: string
    originalFileName?: string
    importedAt: string
  }
  tags?: string[]
}

export interface MeetingsService {
  create(orgId: string, data: Partial<Meeting>): Promise<Meeting>
  get(orgId: string, id: string): Promise<Meeting | null>
  list(orgId: string, filters?: Record<string, unknown>): Promise<Meeting[]>
  update(orgId: string, id: string, changes: Partial<Meeting>): Promise<Meeting>
  delete(orgId: string, id: string): Promise<void>
}

export function createMeetingsService(_bus: EventBus, _dataDir: string): MeetingsService {
  throw new Error('Not implemented')
}

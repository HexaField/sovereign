// Meeting service — §8.2

import type { EventBus } from '@sovereign/core'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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

export interface MeetingFilters {
  threadKey?: string
  since?: string
  until?: string
  source?: 'native' | 'import'
  search?: string
  limit?: number
  offset?: number
}

export interface MeetingsService {
  create(orgId: string, data: Partial<Meeting>): Promise<Meeting>
  get(orgId: string, id: string): Promise<Meeting | null>
  list(orgId: string, filters?: MeetingFilters): Promise<Meeting[]>
  update(orgId: string, id: string, changes: Partial<Meeting>): Promise<Meeting>
  delete(orgId: string, id: string): Promise<void>
}

function meetingsDir(dataDir: string, orgId: string): string {
  return path.join(dataDir, 'meetings', orgId)
}

function meetingPath(dataDir: string, orgId: string, id: string): string {
  return path.join(meetingsDir(dataDir, orgId), `${id}.json`)
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + crypto.randomUUID()
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, filePath)
}

export function createMeetingsService(bus: EventBus, dataDir: string): MeetingsService {
  function ensureDir(orgId: string): void {
    fs.mkdirSync(meetingsDir(dataDir, orgId), { recursive: true })
  }

  return {
    async create(orgId: string, data: Partial<Meeting>): Promise<Meeting> {
      ensureDir(orgId)
      const now = new Date().toISOString()
      const meeting: Meeting = {
        id: crypto.randomUUID(),
        orgId,
        title: data.title ?? 'Untitled Meeting',
        description: data.description,
        createdAt: now,
        updatedAt: now,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        duration: data.duration ?? 0,
        threadKey: data.threadKey,
        entities: data.entities,
        recordings: data.recordings ?? [],
        transcript: data.transcript,
        summary: data.summary,
        source: data.source ?? 'native',
        importMeta: data.importMeta,
        tags: data.tags
      }
      atomicWrite(meetingPath(dataDir, orgId, meeting.id), JSON.stringify(meeting, null, 2))
      bus.emit({
        type: 'meeting.created',
        timestamp: now,
        source: 'meetings',
        payload: { orgId, id: meeting.id, title: meeting.title, source: meeting.source }
      })
      return meeting
    },

    async get(orgId: string, id: string): Promise<Meeting | null> {
      const p = meetingPath(dataDir, orgId, id)
      if (!fs.existsSync(p)) return null
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    },

    async list(orgId: string, filters?: MeetingFilters): Promise<Meeting[]> {
      const dir = meetingsDir(dataDir, orgId)
      if (!fs.existsSync(dir)) return []
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'speakers.json')
      let meetings: Meeting[] = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))

      if (filters?.threadKey) {
        meetings = meetings.filter((m) => m.threadKey === filters.threadKey)
      }
      if (filters?.since) {
        const since = new Date(filters.since).getTime()
        meetings = meetings.filter((m) => new Date(m.createdAt).getTime() >= since)
      }
      if (filters?.until) {
        const until = new Date(filters.until).getTime()
        meetings = meetings.filter((m) => new Date(m.createdAt).getTime() <= until)
      }
      if (filters?.source) {
        meetings = meetings.filter((m) => m.source === filters.source)
      }
      if (filters?.search) {
        const q = filters.search.toLowerCase()
        meetings = meetings.filter(
          (m) =>
            m.title.toLowerCase().includes(q) ||
            m.summary?.text?.toLowerCase().includes(q) ||
            m.transcript?.text?.toLowerCase().includes(q)
        )
      }

      // Sort newest first
      meetings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

      if (filters?.offset) meetings = meetings.slice(filters.offset)
      if (filters?.limit) meetings = meetings.slice(0, filters.limit)

      return meetings
    },

    async update(orgId: string, id: string, changes: Partial<Meeting>): Promise<Meeting> {
      const existing = await this.get(orgId, id)
      if (!existing) throw new Error('Meeting not found')
      const updated: Meeting = {
        ...existing,
        ...changes,
        id: existing.id,
        orgId: existing.orgId,
        updatedAt: new Date().toISOString()
      }
      atomicWrite(meetingPath(dataDir, orgId, id), JSON.stringify(updated, null, 2))
      bus.emit({
        type: 'meeting.updated',
        timestamp: updated.updatedAt,
        source: 'meetings',
        payload: { orgId, id, changes: Object.keys(changes) }
      })
      return updated
    },

    async delete(orgId: string, id: string): Promise<void> {
      const p = meetingPath(dataDir, orgId, id)
      if (fs.existsSync(p)) fs.unlinkSync(p)
      bus.emit({
        type: 'meeting.deleted',
        timestamp: new Date().toISOString(),
        source: 'meetings',
        payload: { orgId, id }
      })
    }
  }
}

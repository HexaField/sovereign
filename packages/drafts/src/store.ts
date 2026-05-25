// Drafts Module — File-backed CRUD Store

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { Draft, CreateDraft, UpdateDraft, DraftFilter, DraftStore } from './types.js'

function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex')
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function createDraftStore(dataDir: string): DraftStore {
  const filePath = path.join(dataDir, 'drafts', 'drafts.json')

  function load(): Draft[] {
    try {
      const data = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(data) as Draft[]
    } catch {
      return []
    }
  }

  function save(drafts: Draft[]): void {
    atomicWrite(filePath, JSON.stringify(drafts, null, 2))
  }

  const store: DraftStore = {
    list(filter?: DraftFilter): Draft[] {
      let drafts = load()
      if (!filter) {
        return drafts.filter((d) => d.status !== 'published')
      }
      if (filter.status) {
        drafts = drafts.filter((d) => d.status === filter.status)
      } else {
        drafts = drafts.filter((d) => d.status !== 'published')
      }
      if (filter.orgId !== undefined) {
        drafts = drafts.filter((d) => d.orgId === filter.orgId)
      }
      if (filter.label) {
        drafts = drafts.filter((d) => d.labels.includes(filter.label!))
      }
      return drafts
    },

    get(id: string): Draft | undefined {
      return load().find((d) => d.id === id)
    },

    create(data: CreateDraft): Draft {
      const drafts = load()
      const now = new Date().toISOString()
      const draft: Draft = {
        id: crypto.randomUUID(),
        title: data.title,
        body: data.body ?? '',
        labels: data.labels ?? [],
        assignees: data.assignees ?? [],
        status: 'draft',
        orgId: data.orgId ?? null,
        projectId: data.projectId ?? null,
        dependencies: data.dependencies ?? [],
        createdAt: now,
        updatedAt: now,
        publishedAs: null
      }
      drafts.push(draft)
      save(drafts)
      return draft
    },

    update(id: string, patch: UpdateDraft): Draft {
      const drafts = load()
      const idx = drafts.findIndex((d) => d.id === id)
      if (idx === -1) throw new Error(`Draft not found: ${id}`)
      const draft = { ...drafts[idx]!, ...patch, updatedAt: new Date().toISOString() }
      drafts[idx] = draft
      save(drafts)
      return draft
    },

    delete(id: string): void {
      const drafts = load()
      const idx = drafts.findIndex((d) => d.id === id)
      if (idx === -1) throw new Error(`Draft not found: ${id}`)
      drafts.splice(idx, 1)
      save(drafts)
    },

    getByOrg(orgId: string | null): Draft[] {
      return load().filter((d) => d.status !== 'published' && d.orgId === orgId)
    }
  }

  return store
}

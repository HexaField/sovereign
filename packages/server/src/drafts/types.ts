// Drafts Module — Types

import type { EntityRef } from '../planning/types.js'

export interface Draft {
  id: string
  title: string
  body: string
  labels: string[]
  assignees: string[]
  status: 'draft' | 'published'
  orgId: string | null
  projectId: string | null
  dependencies: DraftDep[]
  createdAt: string
  updatedAt: string
  publishedAs: EntityRef | null
}

export interface DraftDep {
  type: 'depends_on' | 'blocks'
  target: DraftDepTarget
}

export type DraftDepTarget = { kind: 'draft'; draftId: string } | { kind: 'provider'; ref: EntityRef }

export interface DraftFilter {
  orgId?: string | null
  status?: 'draft' | 'published'
  label?: string
}

export interface CreateDraft {
  title: string
  body?: string
  labels?: string[]
  assignees?: string[]
  orgId?: string | null
  projectId?: string | null
  dependencies?: DraftDep[]
}

export interface UpdateDraft {
  title?: string
  body?: string
  labels?: string[]
  assignees?: string[]
  status?: 'draft' | 'published'
  orgId?: string | null
  projectId?: string | null
  dependencies?: DraftDep[]
  publishedAs?: EntityRef | null
}

export interface DraftStore {
  list(filter?: DraftFilter): Draft[]
  get(id: string): Draft | undefined
  create(data: CreateDraft): Draft
  update(id: string, patch: UpdateDraft): Draft
  delete(id: string): void
  getByOrg(orgId: string | null): Draft[]
}

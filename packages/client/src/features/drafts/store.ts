// Drafts Client Store

import { createSignal } from 'solid-js'

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

export interface EntityRef {
  orgId: string
  projectId: string
  remote: string
  issueId: string
}

export interface DraftDep {
  type: 'depends_on' | 'blocks'
  target: DraftDepTarget
}

export type DraftDepTarget = { kind: 'draft'; draftId: string } | { kind: 'provider'; ref: EntityRef }

export interface UpdateDraft {
  title?: string
  body?: string
  labels?: string[]
  assignees?: string[]
  status?: 'draft' | 'published'
  orgId?: string | null
  projectId?: string | null
  dependencies?: DraftDep[]
}

export function createDraftsStore() {
  const [drafts, setDrafts] = createSignal<Draft[]>([])
  const [selectedDraftId, setSelectedDraftId] = createSignal<string | null>(null)

  async function fetchDrafts(orgId?: string): Promise<void> {
    const params = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
    const res = await fetch(`/api/drafts${params}`)
    const data = await res.json()
    setDrafts(data)
  }

  async function createDraft(title: string): Promise<Draft> {
    const res = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    })
    const draft = await res.json()
    await fetchDrafts()
    return draft
  }

  async function updateDraft(id: string, patch: UpdateDraft): Promise<void> {
    await fetch(`/api/drafts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    })
    await fetchDrafts()
  }

  async function deleteDraft(id: string): Promise<void> {
    await fetch(`/api/drafts/${id}`, { method: 'DELETE' })
    await fetchDrafts()
  }

  async function publishDraft(id: string, orgId: string, projectId: string): Promise<void> {
    await fetch(`/api/drafts/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId, projectId })
    })
    await fetchDrafts()
  }

  function selectDraft(id: string | null): void {
    setSelectedDraftId(id)
  }

  async function addDependency(id: string, dep: DraftDep): Promise<void> {
    await fetch(`/api/drafts/${id}/dependencies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dep)
    })
    await fetchDrafts()
  }

  async function removeDependency(id: string, index: number): Promise<void> {
    await fetch(`/api/drafts/${id}/dependencies/${index}`, { method: 'DELETE' })
    await fetchDrafts()
  }

  return {
    drafts,
    selectedDraftId,
    fetchDrafts,
    createDraft,
    updateDraft,
    deleteDraft,
    publishDraft,
    selectDraft,
    addDependency,
    removeDependency
  }
}

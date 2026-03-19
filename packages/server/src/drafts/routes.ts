// Drafts Module — REST API Routes

import { Router } from 'express'
import type { Request, Response } from 'express'
import type { EventBus } from '@sovereign/core'
import type { DraftStore } from './types.js'
import type { IssueTracker, Remote } from '../issues/types.js'

export interface DraftRouteDeps {
  issueTracker: IssueTracker
  getRemotes: (orgId: string, projectId: string) => Remote[]
}

export function createDraftRouter(bus: EventBus, store: DraftStore, deps: DraftRouteDeps): Router {
  const router = Router()

  // GET /api/drafts
  router.get('/api/drafts', (req: Request, res: Response) => {
    try {
      const { orgId, status, unassigned, label } = req.query as Record<string, string | undefined>

      if (status === 'all') {
        let drafts = store.list({ status: 'draft' }).concat(store.list({ status: 'published' }))
        if (orgId) drafts = drafts.filter((d) => d.orgId === orgId || d.orgId === null)
        if (label) drafts = drafts.filter((d) => d.labels.includes(label))
        res.json(drafts)
        return
      }

      if (unassigned === 'true') {
        res.json(store.getByOrg(null))
        return
      }

      if (orgId) {
        // Return drafts for this org + unassigned
        const orgDrafts = store.list({ orgId, status: (status as 'draft' | 'published') || undefined })
        const unassignedDrafts = store.getByOrg(null)
        // Dedupe
        const ids = new Set(orgDrafts.map((d) => d.id))
        const combined = [...orgDrafts]
        for (const d of unassignedDrafts) {
          if (!ids.has(d.id)) combined.push(d)
        }
        res.json(combined)
        return
      }

      const filter: Record<string, unknown> = {}
      if (status) (filter as any).status = status
      if (label) (filter as any).label = label
      res.json(store.list(Object.keys(filter).length > 0 ? (filter as any) : undefined))
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/drafts
  router.post('/api/drafts', (req: Request, res: Response) => {
    try {
      const { title } = req.body
      if (!title || typeof title !== 'string' || title.trim() === '') {
        res.status(400).json({ error: 'Title is required and must be non-empty' })
        return
      }
      const draft = store.create(req.body)
      bus.emit({
        type: 'planning.draft.created',
        timestamp: new Date().toISOString(),
        source: 'drafts',
        payload: draft
      })
      res.status(201).json(draft)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/drafts/:id
  router.get('/api/drafts/:id', (req: Request, res: Response) => {
    try {
      const draft = store.get(req.params.id)
      if (!draft) {
        res.status(404).json({ error: 'Draft not found' })
        return
      }
      res.json(draft)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // PATCH /api/drafts/:id
  router.patch('/api/drafts/:id', (req: Request, res: Response) => {
    try {
      const draft = store.get(req.params.id)
      if (!draft) {
        res.status(404).json({ error: 'Draft not found' })
        return
      }
      const updated = store.update(req.params.id, req.body)
      bus.emit({
        type: 'planning.draft.updated',
        timestamp: new Date().toISOString(),
        source: 'drafts',
        payload: updated
      })
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // DELETE /api/drafts/:id
  router.delete('/api/drafts/:id', (req: Request, res: Response) => {
    try {
      const draft = store.get(req.params.id)
      if (!draft) {
        res.status(404).json({ error: 'Draft not found' })
        return
      }
      store.delete(req.params.id)
      bus.emit({
        type: 'planning.draft.deleted',
        timestamp: new Date().toISOString(),
        source: 'drafts',
        payload: { id: req.params.id }
      })
      res.status(204).send()
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/drafts/:id/dependencies
  router.post('/api/drafts/:id/dependencies', (req: Request, res: Response) => {
    try {
      const draft = store.get(req.params.id)
      if (!draft) {
        res.status(404).json({ error: 'Draft not found' })
        return
      }
      const deps = [...draft.dependencies, req.body]
      const updated = store.update(req.params.id, { dependencies: deps })
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // DELETE /api/drafts/:id/dependencies/:index
  router.delete('/api/drafts/:id/dependencies/:index', (req: Request, res: Response) => {
    try {
      const draft = store.get(req.params.id)
      if (!draft) {
        res.status(404).json({ error: 'Draft not found' })
        return
      }
      const index = parseInt(req.params.index, 10)
      const newDeps = [...draft.dependencies]
      newDeps.splice(index, 1)
      const updated = store.update(req.params.id, { dependencies: newDeps })
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/drafts/:id/publish (Wave 4)
  router.post('/api/drafts/:id/publish', async (req: Request, res: Response) => {
    try {
      const draft = store.get(req.params.id)
      if (!draft) {
        res.status(404).json({ error: 'Draft not found' })
        return
      }
      if (draft.status !== 'draft') {
        res.status(400).json({ error: 'Draft is already published' })
        return
      }

      const { orgId, projectId } = req.body
      if (!orgId || !projectId) {
        res.status(400).json({ error: 'orgId and projectId are required' })
        return
      }

      // Determine remote
      const remotes = deps.getRemotes(orgId, projectId)
      if (remotes.length === 0) {
        res.status(400).json({ error: 'No remotes found for project' })
        return
      }
      const remote = remotes[0]!

      // Build body with dependency syntax
      let body = draft.body
      const providerDeps = draft.dependencies.filter((d) => d.target.kind === 'provider')
      if (providerDeps.length > 0) {
        const lines = providerDeps.map((d) => {
          const ref = (d.target as { kind: 'provider'; ref: { orgId: string; projectId: string; issueId: string } }).ref
          return `${d.type === 'depends_on' ? 'depends on' : 'blocks'} ${ref.orgId}/${ref.projectId}#${ref.issueId}`
        })
        body = body ? body + '\n\n' + lines.join('\n') : lines.join('\n')
      }

      let issue
      try {
        issue = await deps.issueTracker.create(orgId, projectId, {
          remote: remote.name,
          title: draft.title,
          body,
          labels: draft.labels,
          assignees: draft.assignees
        })
      } catch (err) {
        res.status(502).json({ error: (err as Error).message })
        return
      }

      const publishedAs = {
        orgId,
        projectId,
        remote: remote.name,
        issueId: issue.id
      }

      const updated = store.update(req.params.id, {
        status: 'published',
        publishedAs,
        orgId,
        projectId
      })

      // Update other drafts that depended on this draft
      const allDrafts = store.list({ status: 'draft' })
      for (const other of allDrafts) {
        let changed = false
        const newDeps = other.dependencies.map((dep) => {
          if (dep.target.kind === 'draft' && dep.target.draftId === draft.id) {
            changed = true
            return { ...dep, target: { kind: 'provider' as const, ref: publishedAs } }
          }
          return dep
        })
        if (changed) {
          store.update(other.id, { dependencies: newDeps })
        }
      }

      bus.emit({
        type: 'planning.draft.published',
        timestamp: new Date().toISOString(),
        source: 'drafts',
        payload: { draft: updated, issue }
      })

      res.json({ draft: updated, issue })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

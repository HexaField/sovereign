// Diff REST API router

import { Router } from 'express'
import type { Request, Response } from 'express'
import type { ChangeSetManager } from './changeset.js'
import { diffFile, diffWorking } from './file-diff.js'
import { diffSemantic } from './semantic.js'

export function createDiffRouter(changeSetManager: ChangeSetManager): Router {
  const router = Router()

  // GET /api/diff?path=...&base=...&head=...&projectId=...
  router.get('/api/diff', async (req: Request, res: Response) => {
    try {
      const { path: filePath, base, head, projectId } = req.query as Record<string, string>
      if (!filePath || !base || !head || !projectId) {
        res.status(400).json({ error: 'Missing required query params: path, base, head, projectId' })
        return
      }
      const result = await diffFile(projectId, filePath, base, head)
      res.json(result)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/diff/working?projectId=...&worktreeId=...&staged=...
  router.get('/api/diff/working', async (req: Request, res: Response) => {
    try {
      const { projectId, staged } = req.query as Record<string, string>
      if (!projectId) {
        res.status(400).json({ error: 'Missing required query param: projectId' })
        return
      }
      const result = await diffWorking(projectId, { staged: staged === 'true' })
      res.json(result)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/diff/semantic?path=...&base=...&head=...
  router.get('/api/diff/semantic', async (req: Request, res: Response) => {
    try {
      const { oldText, newText, format } = req.query as Record<string, string>
      if (!oldText || !newText || !format) {
        res.status(400).json({ error: 'Missing required query params: oldText, newText, format' })
        return
      }
      const result = diffSemantic(oldText, newText, format)
      res.json(result)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/changesets
  router.post('/api/changesets', async (req: Request, res: Response) => {
    try {
      const cs = await changeSetManager.createChangeSet(req.body)
      res.status(201).json(cs)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/changesets?orgId=...&status=...
  router.get('/api/changesets', (req: Request, res: Response) => {
    const { orgId, status } = req.query as Record<string, string>
    const result = changeSetManager.listChangeSets({
      ...(orgId ? { orgId } : {}),
      ...(status ? { status } : {})
    })
    res.json(result)
  })

  // GET /api/changesets/:id
  router.get('/api/changesets/:id', (req: Request, res: Response) => {
    const cs = changeSetManager.getChangeSet(req.params.id)
    if (!cs) {
      res.status(404).json({ error: 'ChangeSet not found' })
      return
    }
    res.json(cs)
  })

  // GET /api/changesets/:id/files/:path(*)
  router.get('/api/changesets/:id/files/*path', async (req: Request, res: Response) => {
    try {
      const filePath = (req.params as Record<string, string>).path || (req.params as unknown as string[])[0]
      const result = await changeSetManager.getChangeSetFileDiff(req.params.id, filePath)
      res.json(result)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // PATCH /api/changesets/:id
  router.patch('/api/changesets/:id', (req: Request, res: Response) => {
    try {
      const updated = changeSetManager.updateChangeSet(req.params.id, req.body)
      res.json(updated)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // DELETE /api/changesets/:id
  router.delete('/api/changesets/:id', (req: Request, res: Response) => {
    try {
      changeSetManager.deleteChangeSet(req.params.id)
      res.status(204).send()
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

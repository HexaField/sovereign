import { Router, type Request, type Response } from 'express'
import type { WorktreeManager } from './worktrees.js'

export function createWorktreeRouter(
  manager: WorktreeManager,
  requireAuth: (req: Request, res: Response, next: () => void) => void
): Router {
  const router = Router()

  router.use(requireAuth)

  // List worktrees
  router.get('/api/orgs/:orgId/projects/:projectId/worktrees', (req: Request, res: Response) => {
    const { orgId, projectId } = req.params
    res.json(manager.list(orgId, projectId))
  })

  // Create worktree
  router.post('/api/orgs/:orgId/projects/:projectId/worktrees', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId } = req.params
      const wt = await manager.create(orgId, projectId, req.body)
      res.status(201).json(wt)
    } catch (err: any) {
      res.status(400).json({ error: err.message })
    }
  })

  // Delete worktree
  router.delete('/api/orgs/:orgId/projects/:projectId/worktrees/:worktreeId', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, worktreeId } = req.params
      await manager.remove(orgId, projectId, worktreeId, { pruneBranch: req.query.pruneBranch === 'true' })
      res.status(204).end()
    } catch (err: any) {
      res.status(400).json({ error: err.message })
    }
  })

  // Create link
  router.post('/api/orgs/:orgId/worktree-links', (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      const link = manager.createLink(orgId, req.body)
      res.status(201).json(link)
    } catch (err: any) {
      res.status(400).json({ error: err.message })
    }
  })

  // List links
  router.get('/api/orgs/:orgId/worktree-links', (req: Request, res: Response) => {
    const { orgId } = req.params
    res.json(manager.listLinks(orgId))
  })

  return router
}

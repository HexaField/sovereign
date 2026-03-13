// Planning Module — REST API Routes

import { Router } from 'express'
import type { Request, Response } from 'express'

export function createPlanningRouter(): Router {
  const router = Router({ mergeParams: true })

  router.get('/api/orgs/:orgId/planning/graph', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  router.get('/api/orgs/:orgId/planning/critical-path', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  router.get('/api/orgs/:orgId/planning/blocked', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  router.get('/api/orgs/:orgId/planning/ready', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  router.get('/api/orgs/:orgId/planning/parallel', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  router.get('/api/orgs/:orgId/planning/impact/:projectId/:issueId', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  router.get('/api/orgs/:orgId/planning/completion', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  router.post('/api/orgs/:orgId/planning/issues', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  router.post('/api/orgs/:orgId/planning/decompose', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  router.post('/api/orgs/:orgId/planning/sync', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented' })
  })

  return router
}

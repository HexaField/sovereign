// Planning Module — REST API Routes

import { Router } from 'express'
import type { Request, Response } from 'express'
import type { PlanningService, GraphFilter, EntityRef } from './types.js'

export function createPlanningRouter(service: PlanningService): Router {
  const router = Router({ mergeParams: true })

  // Planning summary (cross-org)
  router.get('/api/planning/summary', async (_req: Request, res: Response) => {
    try {
      // Get summary across all orgs — use '_global' as default
      const orgId = '_global'
      const [completion, blocked, ready] = await Promise.all([
        service.getCompletion(orgId, {}).catch(() => ({ total: 0, closed: 0, percentage: 0 })),
        service.getBlocked(orgId, {}).catch(() => []),
        service.getReady(orgId, {}).catch(() => [])
      ])
      res.json({
        total: completion.total,
        completed: completion.closed,
        blocked: blocked.length,
        ready: ready.length,
        active: completion.total - completion.closed - blocked.length,
        completionPct: completion.percentage
      })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/api/orgs/:orgId/planning/graph', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      const filter: GraphFilter = {
        projectId: req.query.projectId as string | undefined,
        milestone: req.query.milestone as string | undefined,
        label: req.query.label as string | undefined,
        assignee: req.query.assignee as string | undefined
      }
      const result = await service.getGraph(orgId, filter)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/api/orgs/:orgId/planning/critical-path', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      let target: EntityRef | undefined
      if (req.query.target) {
        const parts = (req.query.target as string).split('/')
        if (parts.length === 2) {
          target = { orgId, projectId: parts[0]!, remote: '', issueId: parts[1]! }
        }
      }
      const result = await service.getCriticalPath(orgId, target)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/api/orgs/:orgId/planning/blocked', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      const filter: GraphFilter = {
        projectId: req.query.projectId as string | undefined,
        label: req.query.label as string | undefined,
        milestone: req.query.milestone as string | undefined,
        assignee: req.query.assignee as string | undefined
      }
      const result = await service.getBlocked(orgId, filter)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/api/orgs/:orgId/planning/ready', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      const filter: GraphFilter = {
        projectId: req.query.projectId as string | undefined,
        label: req.query.label as string | undefined,
        milestone: req.query.milestone as string | undefined,
        assignee: req.query.assignee as string | undefined
      }
      const result = await service.getReady(orgId, filter)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/api/orgs/:orgId/planning/parallel', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      const filter: GraphFilter = {
        projectId: req.query.projectId as string | undefined,
        label: req.query.label as string | undefined,
        milestone: req.query.milestone as string | undefined,
        assignee: req.query.assignee as string | undefined
      }
      const result = await service.getParallelSets(orgId, filter)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/api/orgs/:orgId/planning/impact/:projectId/:issueId', async (req: Request, res: Response) => {
    try {
      const { orgId, projectId, issueId } = req.params
      const ref: EntityRef = { orgId, projectId, remote: '', issueId }
      const result = await service.getImpact(orgId, ref)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/api/orgs/:orgId/planning/completion', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      const filter: GraphFilter = {
        projectId: req.query.projectId as string | undefined,
        milestone: req.query.milestone as string | undefined
      }
      const result = await service.getCompletion(orgId, filter)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/api/orgs/:orgId/planning/issues', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      const result = await service.createIssue(orgId, req.body)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/api/orgs/:orgId/planning/decompose', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      const result = await service.decompose(orgId, req.body)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/api/orgs/:orgId/planning/sync', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params
      const { projectId } = req.body ?? {}
      const result = await service.sync(orgId, projectId)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

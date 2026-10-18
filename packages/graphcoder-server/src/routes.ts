import { Router, type NextFunction, type Request, type Response } from 'express'
import { UnknownRepoError, type GraphcoderService } from './service.js'

export function createGraphcoderRouter(
  service: GraphcoderService,
  requireAuth: (req: Request, res: Response, next: NextFunction) => void
): Router {
  const router = Router()

  router.get('/api/graphcoder/status', requireAuth, async (_req: Request, res: Response) => {
    try {
      res.json(await service.status())
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ?path=<absolute checkout path>, one of the repos /status lists
  router.get('/api/graphcoder/repos/stats', requireAuth, async (req: Request, res: Response) => {
    const repoPath = req.query.path
    if (typeof repoPath !== 'string' || repoPath === '') return res.status(400).json({ error: 'path is required' })
    try {
      res.json(await service.repoStats(repoPath))
    } catch (err) {
      if (err instanceof UnknownRepoError) return res.status(404).json({ error: err.message })
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

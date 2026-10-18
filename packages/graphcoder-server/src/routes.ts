import { Router, type NextFunction, type Request, type Response } from 'express'
import { UnknownRepoError, type GraphcoderService } from './service.js'

/** A ref as a query parameter: present, and never something git would read as an option */
const isRef = (v: unknown): v is string => typeof v === 'string' && v !== '' && !v.startsWith('-') && !/\s/.test(v)

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

  /** path, base and head from the query, or a 400 */
  const changeOf = (req: Request, res: Response): { path: string; base: string; head: string } | undefined => {
    const { path, base, head } = req.query
    if (typeof path !== 'string' || path === '') {
      res.status(400).json({ error: 'path is required' })
      return undefined
    }
    if (!isRef(base) || !isRef(head)) {
      res.status(400).json({ error: 'base and head must be git refs' })
      return undefined
    }
    return { path, base, head }
  }

  // ?path=&base=&head= — the structure of head against its merge base with base; computes on a cache miss
  router.get('/api/graphcoder/structure', requireAuth, async (req: Request, res: Response) => {
    const change = changeOf(req, res)
    if (!change) return
    try {
      res.json(await service.structureOf(change.path, change.base, change.head))
    } catch (err) {
      if (err instanceof UnknownRepoError) return res.status(404).json({ error: err.message })
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // The same, cache only: { state: 'ready', structure } | { state: 'computing' | 'none' } | { state: 'failed', error }
  router.get('/api/graphcoder/structure/cached', requireAuth, async (req: Request, res: Response) => {
    const change = changeOf(req, res)
    if (!change) return
    try {
      res.json(await service.cachedStructure(change.path, change.base, change.head))
    } catch (err) {
      if (err instanceof UnknownRepoError) return res.status(404).json({ error: err.message })
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

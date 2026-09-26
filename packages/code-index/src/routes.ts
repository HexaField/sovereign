import express, { Router, type Request, type Response } from 'express'
import type { CodeIndex } from './code-index.js'

export function createCodeIndexRouter(
  codeIndex: CodeIndex,
  requireAuth: (req: Request, res: Response, next: () => void) => void
): Router {
  const router = Router()

  router.get('/api/code-index', requireAuth, (_req: Request, res: Response) => {
    res.json(codeIndex.status())
  })

  // Body `{ root?: string }` — omit root to sync every checkout.
  router.post('/api/code-index/sync', requireAuth, express.json(), (req: Request, res: Response) => {
    const root: unknown = req.body?.root
    if (root !== undefined && typeof root !== 'string') return res.status(400).json({ error: 'root must be a string' })
    if (!codeIndex.status().enabled) return res.status(409).json({ error: 'code index is not running' })
    if (!codeIndex.sync(root)) return res.status(404).json({ error: `not an indexed checkout: ${root}` })
    res.status(202).json({ queued: root ?? 'all' })
  })

  return router
}

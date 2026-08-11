// ── Forest API routes ───────────────────────────────────────────────
// GET  /api/forest/index   — returns the cached (or freshly built) index
// POST /api/forest/rebuild — forces a full rebuild

import { Router } from 'express'
import type { Request, Response } from 'express'
import { loadCachedIndex, buildForestIndex, type Ad4mDeps } from './index-builder.js'

export interface ForestRouteDeps {
  ad4m: Ad4mDeps | null
  dataDir: string
}

export function createForestRoutes(deps: ForestRouteDeps): Router {
  const router = Router()
  let building = false

  // GET /api/forest/index — serve cached index or build on first request
  router.get('/api/forest/index', async (_req: Request, res: Response) => {
    try {
      const cached = loadCachedIndex(deps.dataDir)
      if (cached) {
        res.json(cached)
        return
      }

      // No cache — build lazily on first request
      if (building) {
        res.status(202).json({ message: 'Index build in progress' })
        return
      }

      building = true
      const index = await buildForestIndex({ dataDir: deps.dataDir, ad4m: deps.ad4m })
      building = false
      res.json(index)
    } catch (err) {
      building = false
      console.error('[forest] index request failed:', (err as Error)?.message)
      res.status(500).json({ error: 'Failed to build forest index' })
    }
  })

  // POST /api/forest/rebuild — force rebuild
  router.post('/api/forest/rebuild', async (_req: Request, res: Response) => {
    if (building) {
      res.status(202).json({ message: 'Build already in progress' })
      return
    }

    try {
      building = true
      const index = await buildForestIndex({ dataDir: deps.dataDir, ad4m: deps.ad4m })
      building = false
      res.json(index)
    } catch (err) {
      building = false
      console.error('[forest] rebuild failed:', (err as Error)?.message)
      res.status(500).json({ error: 'Forest rebuild failed' })
    }
  })

  return router
}

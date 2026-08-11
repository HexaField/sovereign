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
  let buildPromise: Promise<void> | null = null

  /** Kick off a background build — does not block the request. */
  function startBuild(): void {
    if (building) return
    building = true
    buildPromise = buildForestIndex({ dataDir: deps.dataDir, ad4m: deps.ad4m })
      .then(() => {
        building = false
        buildPromise = null
      })
      .catch((err) => {
        building = false
        buildPromise = null
        console.error('[forest] background build failed:', (err as Error)?.message)
      })
  }

  // GET /api/forest/index — serve cached index; trigger background build if missing
  router.get('/api/forest/index', (_req: Request, res: Response) => {
    const cached = loadCachedIndex(deps.dataDir)
    if (cached) {
      res.json(cached)
      return
    }

    // No cache — start a background build and return 202 with a status body
    startBuild()
    res.status(202).json({ building: true, message: 'Index build in progress' })
  })

  // POST /api/forest/rebuild — force rebuild (blocks until complete)
  router.post('/api/forest/rebuild', async (_req: Request, res: Response) => {
    if (building) {
      // Wait for the in-flight build instead of rejecting
      if (buildPromise) {
        await buildPromise
        const cached = loadCachedIndex(deps.dataDir)
        if (cached) {
          res.json(cached)
          return
        }
      }
      res.status(202).json({ building: true, message: 'Build in progress' })
      return
    }

    try {
      building = true
      const index = await buildForestIndex({ dataDir: deps.dataDir, ad4m: deps.ad4m })
      building = false
      buildPromise = null
      res.json(index)
    } catch (err) {
      building = false
      buildPromise = null
      console.error('[forest] rebuild failed:', (err as Error)?.message)
      res.status(500).json({ error: 'Forest rebuild failed' })
    }
  })

  return router
}

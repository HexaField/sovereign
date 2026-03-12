// Radicle REST API router

import { Router } from 'express'
import type { RadicleManager } from './types.js'

export function createRadicleRouter(_manager: RadicleManager): Router {
  const router = Router()
  // GET /api/radicle/status
  // POST /api/radicle/repos
  // GET /api/radicle/repos
  // POST /api/radicle/repos/:rid/push
  // POST /api/radicle/repos/:rid/pull
  // GET /api/radicle/repos/:rid/peers
  // POST /api/radicle/repos/:rid/seed
  // GET /api/radicle/identity
  // POST /api/radicle/identity
  // GET /api/radicle/peers
  // POST /api/radicle/peers
  return router
}

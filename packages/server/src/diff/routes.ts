// Diff REST API router

import { Router } from 'express'
import type { ChangeSetManager } from './changeset.js'

export function createDiffRouter(_changeSetManager: ChangeSetManager): Router {
  const router = Router()
  // GET /api/diff?path=...&base=...&head=...&projectId=...
  // GET /api/diff/working?projectId=...&worktreeId=...
  // GET /api/diff/semantic?path=...&base=...&head=...
  // POST /api/changesets
  // GET /api/changesets?orgId=...&status=...
  // GET /api/changesets/:id
  // GET /api/changesets/:id/files/:path
  // PATCH /api/changesets/:id
  // DELETE /api/changesets/:id
  return router
}

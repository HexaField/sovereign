// Issue REST API router

import { Router } from 'express'
import type { IssueTracker } from './types.js'

export function createIssueRouter(_tracker: IssueTracker): Router {
  const router = Router()
  // GET /api/orgs/:orgId/issues
  // GET /api/orgs/:orgId/projects/:projectId/issues/:id
  // POST /api/orgs/:orgId/projects/:projectId/issues
  // PATCH /api/orgs/:orgId/projects/:projectId/issues/:id
  // GET /api/orgs/:orgId/projects/:projectId/issues/:id/comments
  // POST /api/orgs/:orgId/projects/:projectId/issues/:id/comments
  // POST /api/orgs/:orgId/projects/:projectId/issues/sync
  return router
}

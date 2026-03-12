// Review REST API router

import { Router } from 'express'
import type { ReviewSystem } from './types.js'

export function createReviewRouter(_reviewSystem: ReviewSystem): Router {
  const router = Router()
  // POST /api/orgs/:orgId/projects/:projectId/reviews
  // GET /api/orgs/:orgId/reviews
  // GET /api/orgs/:orgId/projects/:projectId/reviews/:id
  // GET /api/orgs/:orgId/projects/:projectId/reviews/:id/diff
  // POST /api/orgs/:orgId/projects/:projectId/reviews/:id/comments
  // GET /api/orgs/:orgId/projects/:projectId/reviews/:id/comments
  // PATCH /api/orgs/:orgId/projects/:projectId/reviews/:id/comments/:commentId
  // POST /api/orgs/:orgId/projects/:projectId/reviews/:id/approve
  // POST /api/orgs/:orgId/projects/:projectId/reviews/:id/request-changes
  // POST /api/orgs/:orgId/projects/:projectId/reviews/:id/merge
  // POST /api/orgs/:orgId/projects/:projectId/reviews/sync
  return router
}

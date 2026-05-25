// Review REST API router

import { Router } from 'express'
import type { ReviewSystem } from './types.js'

export function createReviewRouter(reviewSystem: ReviewSystem): Router {
  const router = Router()

  // POST /api/orgs/:orgId/projects/:projectId/reviews
  router.post('/api/orgs/:orgId/projects/:projectId/reviews', async (req, res) => {
    try {
      const { orgId, projectId } = req.params
      const { remote, worktreeId, title, description, baseBranch, headBranch, reviewers } = req.body
      if (!title) return res.status(400).json({ error: 'title is required' })
      if (!baseBranch || !headBranch) return res.status(400).json({ error: 'baseBranch and headBranch are required' })
      const review = await reviewSystem.create(orgId, projectId, {
        remote,
        worktreeId,
        title,
        description,
        baseBranch,
        headBranch,
        reviewers
      })
      res.status(201).json(review)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/orgs/:orgId/reviews
  router.get('/api/orgs/:orgId/reviews', async (req, res) => {
    try {
      const { orgId } = req.params
      const filter = {
        projectId: req.query.projectId as string | undefined,
        status: req.query.status as string | undefined
      }
      const reviews = await reviewSystem.list(orgId, filter)
      res.json(reviews)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/orgs/:orgId/projects/:projectId/reviews/:id
  router.get('/api/orgs/:orgId/projects/:projectId/reviews/:id', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const review = await reviewSystem.get(orgId, projectId, id)
      if (!review) return res.status(404).json({ error: 'Review not found' })
      res.json(review)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/orgs/:orgId/projects/:projectId/reviews/:id/comments
  router.post('/api/orgs/:orgId/projects/:projectId/reviews/:id/comments', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const { filePath, lineNumber, endLineNumber, side, body, replyTo } = req.body
      if (!body) return res.status(400).json({ error: 'body is required' })
      const comment = await reviewSystem.addComment(orgId, projectId, id, {
        filePath,
        lineNumber,
        endLineNumber,
        side,
        body,
        replyTo
      })
      res.status(201).json(comment)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/orgs/:orgId/projects/:projectId/reviews/:id/comments
  router.get('/api/orgs/:orgId/projects/:projectId/reviews/:id/comments', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const comments = await reviewSystem.listComments(orgId, projectId, id)
      res.json(comments)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // PATCH /api/orgs/:orgId/projects/:projectId/reviews/:id/comments/:commentId
  router.patch('/api/orgs/:orgId/projects/:projectId/reviews/:id/comments/:commentId', async (req, res) => {
    try {
      const { orgId, projectId, id, commentId } = req.params
      await reviewSystem.resolveComment(orgId, projectId, id, commentId)
      res.json({ resolved: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/orgs/:orgId/projects/:projectId/reviews/:id/approve
  router.post('/api/orgs/:orgId/projects/:projectId/reviews/:id/approve', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const review = await reviewSystem.approve(orgId, projectId, id, req.body?.body)
      res.json(review)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/orgs/:orgId/projects/:projectId/reviews/:id/request-changes
  router.post('/api/orgs/:orgId/projects/:projectId/reviews/:id/request-changes', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const { body } = req.body
      if (!body) return res.status(400).json({ error: 'body is required' })
      const review = await reviewSystem.requestChanges(orgId, projectId, id, body)
      res.json(review)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/orgs/:orgId/projects/:projectId/reviews/:id/merge
  router.post('/api/orgs/:orgId/projects/:projectId/reviews/:id/merge', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const review = await reviewSystem.merge(orgId, projectId, id)
      res.json(review)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/orgs/:orgId/projects/:projectId/reviews/sync
  router.post('/api/orgs/:orgId/projects/:projectId/reviews/sync', async (req, res) => {
    try {
      const { orgId, projectId } = req.params
      const result = await reviewSystem.sync(orgId, projectId)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

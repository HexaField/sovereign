// Issue REST API router

import { Router } from 'express'
import type { IssueTracker, IssueFilter } from './types.js'

export function createIssueRouter(tracker: IssueTracker): Router {
  const router = Router()

  // GET /api/orgs/:orgId/issues
  router.get('/api/orgs/:orgId/issues', async (req, res) => {
    try {
      const { orgId } = req.params
      const filter: IssueFilter = {
        projectId: req.query.projectId as string | undefined,
        remote: req.query.remote as string | undefined,
        state: req.query.state as 'open' | 'closed' | undefined,
        label: req.query.label as string | undefined,
        assignee: req.query.assignee as string | undefined,
        q: req.query.q as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined
      }
      const issues = await tracker.list(orgId, filter)
      res.json(issues)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/orgs/:orgId/projects/:projectId/issues/:id
  router.get('/api/orgs/:orgId/projects/:projectId/issues/:id', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const issue = await tracker.get(orgId, projectId, id)
      if (!issue) return res.status(404).json({ error: 'Issue not found' })
      res.json(issue)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/orgs/:orgId/projects/:projectId/issues
  router.post('/api/orgs/:orgId/projects/:projectId/issues', async (req, res) => {
    try {
      const { orgId, projectId } = req.params
      const { remote, title, body, labels, assignees } = req.body
      if (!title) return res.status(400).json({ error: 'title is required' })
      const issue = await tracker.create(orgId, projectId, { remote, title, body, labels, assignees })
      res.status(201).json(issue)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // PATCH /api/orgs/:orgId/projects/:projectId/issues/:id
  router.patch('/api/orgs/:orgId/projects/:projectId/issues/:id', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const issue = await tracker.update(orgId, projectId, id, req.body)
      res.json(issue)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/orgs/:orgId/projects/:projectId/issues/:id/comments
  router.get('/api/orgs/:orgId/projects/:projectId/issues/:id/comments', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const comments = await tracker.listComments(orgId, projectId, id)
      res.json(comments)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/orgs/:orgId/projects/:projectId/issues/:id/comments
  router.post('/api/orgs/:orgId/projects/:projectId/issues/:id/comments', async (req, res) => {
    try {
      const { orgId, projectId, id } = req.params
      const { body } = req.body
      if (!body) return res.status(400).json({ error: 'body is required' })
      const comment = await tracker.addComment(orgId, projectId, id, body)
      res.status(201).json(comment)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/orgs/:orgId/projects/:projectId/issues/sync
  router.post('/api/orgs/:orgId/projects/:projectId/issues/sync', async (req, res) => {
    try {
      const { orgId, projectId } = req.params
      const result = await tracker.sync(orgId, projectId)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

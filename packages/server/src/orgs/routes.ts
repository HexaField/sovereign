import { Router } from 'express'
import type { OrgManager } from './orgs.js'

export function createOrgRoutes(manager: OrgManager, authMiddleware: (req: any, res: any, next: any) => void): Router {
  const router = Router()

  router.use(authMiddleware)

  // Orgs
  router.get('/orgs', (_req, res) => {
    res.json(manager.listOrgs())
  })

  router.post('/orgs', (req, res) => {
    try {
      const org = manager.createOrg(req.body)
      res.status(201).json(org)
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  router.get('/orgs/:orgId', (req, res) => {
    const org = manager.getOrg(req.params.orgId)
    if (!org) return res.status(404).json({ error: 'Not found' })
    res.json(org)
  })

  router.put('/orgs/:orgId', (req, res) => {
    try {
      const org = manager.updateOrg(req.params.orgId, req.body)
      res.json(org)
    } catch (e: any) {
      const status = e.status || 400
      res.status(status).json({ error: e.message })
    }
  })

  router.delete('/orgs/:orgId', (req, res) => {
    try {
      manager.deleteOrg(req.params.orgId)
      res.status(204).send()
    } catch (e: any) {
      const status = e.status || 400
      res.status(status).json({ error: e.message })
    }
  })

  // Auto-detect projects
  router.post('/orgs/:orgId/detect-projects', (req, res) => {
    try {
      const projects = manager.autoDetectProjects(req.params.orgId)
      res.json({ detected: projects })
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  // Projects
  router.get('/orgs/:orgId/projects', (req, res) => {
    res.json(manager.listProjects(req.params.orgId))
  })

  router.post('/orgs/:orgId/projects', (req, res) => {
    try {
      const project = manager.addProject(req.params.orgId, req.body)
      res.status(201).json(project)
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  router.get('/orgs/:orgId/projects/:projectId', (req, res) => {
    const project = manager.getProject(req.params.orgId, req.params.projectId)
    if (!project) return res.status(404).json({ error: 'Not found' })
    res.json(project)
  })

  router.put('/orgs/:orgId/projects/:projectId', (req, res) => {
    try {
      const project = manager.updateProject(req.params.orgId, req.params.projectId, req.body)
      res.json(project)
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  router.delete('/orgs/:orgId/projects/:projectId', (req, res) => {
    try {
      manager.removeProject(req.params.orgId, req.params.projectId)
      res.status(204).send()
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })

  return router
}

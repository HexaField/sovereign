// Threads — REST API endpoints

import { Router } from 'express'
import type { ThreadManager } from './types.js'
import type { ForwardHandler } from './forward.js'

export function createThreadRoutes(threadManager: ThreadManager, forwardHandler: ForwardHandler): Router {
  const router = Router()

  router.get('/api/threads', (req, res) => {
    const filter: Record<string, unknown> = {}
    if (req.query.orgId) filter.orgId = req.query.orgId
    if (req.query.projectId) filter.projectId = req.query.projectId
    if (req.query.active) filter.active = req.query.active === 'true'
    const threads = threadManager.list(Object.keys(filter).length > 0 ? (filter as never) : undefined)
    res.json({ threads })
  })

  router.get('/api/threads/:key', (req, res) => {
    const thread = threadManager.get(req.params.key)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    const events = threadManager.getEvents(req.params.key, {
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0
    })
    res.json({ thread, events })
  })

  router.post('/api/threads', (req, res) => {
    const { label, entities } = req.body ?? {}
    const thread = threadManager.create({ label, entities })
    res.status(201).json({ thread })
  })

  router.delete('/api/threads/:key', (req, res) => {
    const deleted = threadManager.delete(req.params.key)
    if (!deleted) return res.status(404).json({ error: 'Thread not found' })
    res.json({ success: true })
  })

  router.post('/api/threads/:key/entities', (req, res) => {
    const thread = threadManager.addEntity(req.params.key, req.body)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    res.json({ thread })
  })

  router.delete('/api/threads/:key/entities/:entityType/:entityRef', (req, res) => {
    const thread = threadManager.removeEntity(req.params.key, req.params.entityType as never, req.params.entityRef)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    res.json({ thread })
  })

  router.post('/api/threads/:key/forward', (req, res) => {
    const result = forwardHandler.forward(req.body.sourceThread ?? req.params.key, req.params.key, req.body)
    if (!result.success) return res.status(400).json({ error: result.error })
    res.json({ success: true })
  })

  router.get('/api/threads/:key/events', (req, res) => {
    const events = threadManager.getEvents(req.params.key, {
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
      since: req.query.since ? Number(req.query.since) : undefined
    })
    res.json({ events })
  })

  // Session tree — returns thread hierarchy for the ThreadDrawer
  router.get('/api/sessions/tree', (_req, res) => {
    const threads = threadManager.list()
    const now = Date.now()

    // Build tree nodes from flat thread list
    interface SessionNode {
      key: string
      fullKey: string
      kind: 'main' | 'thread' | 'cron' | 'cron-run' | 'subagent' | 'event-agent'
      label: string
      parentKey: string | null
      updatedAt: number
      totalTokens: number
      children: SessionNode[]
    }

    const mainNode: SessionNode = {
      key: 'main',
      fullKey: 'main',
      kind: 'main',
      label: 'Main',
      parentKey: null,
      updatedAt: now,
      totalTokens: 0,
      children: []
    }

    for (const t of threads) {
      const kind = t.key.startsWith('cron:')
        ? ('cron' as const)
        : t.key.startsWith('subagent:')
          ? ('subagent' as const)
          : ('thread' as const)
      const node: SessionNode = {
        key: t.key,
        fullKey: t.key,
        kind,
        label: t.label || t.key,
        parentKey: 'main',
        updatedAt: t.lastActivity || t.createdAt || now,
        totalTokens: 0,
        children: []
      }
      mainNode.children.push(node)
    }

    // Sort children by updatedAt descending
    mainNode.children.sort((a, b) => b.updatedAt - a.updatedAt)

    res.json({ tree: [mainNode] })
  })

  return router
}

// Legacy export for backwards compat
const router = Router()
router.get('/api/threads', (_req, res) => res.status(501).json({ error: 'Use createThreadRoutes()' }))
export { router as threadRoutes }

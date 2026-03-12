// Radicle REST API router

import { Router, json } from 'express'
import type { RadicleManager } from './types.js'

export function createRadicleRouter(manager: RadicleManager): Router {
  const router = Router()
  router.use(json())

  // GET /api/radicle/status
  router.get('/status', async (_req, res) => {
    try {
      const status = await manager.getStatus()
      res.json(status)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/radicle/repos
  router.post('/repos', async (req, res) => {
    try {
      const { path, name, description } = req.body
      if (!path) return res.status(400).json({ error: 'path is required' })
      const info = await manager.initRepo(path, { name, description })
      res.status(201).json(info)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/radicle/repos
  router.get('/repos', async (_req, res) => {
    try {
      const repos = await manager.listRepos()
      res.json(repos)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/radicle/repos/:rid/push
  router.post('/repos/:rid/push', async (req, res) => {
    try {
      await manager.push(req.params.rid)
      res.json({ ok: true })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/radicle/repos/:rid/pull
  router.post('/repos/:rid/pull', async (req, res) => {
    try {
      await manager.pull(req.params.rid)
      res.json({ ok: true })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/radicle/repos/:rid/peers
  router.get('/repos/:rid/peers', async (_req, res) => {
    try {
      const peers = await manager.listPeers()
      res.json(peers)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/radicle/repos/:rid/seed
  router.post('/repos/:rid/seed', async (req, res) => {
    try {
      await manager.seed(req.params.rid)
      res.json({ ok: true })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // DELETE /api/radicle/repos/:rid/seed — unseed
  router.delete('/repos/:rid/seed', async (req, res) => {
    try {
      await manager.unseed(req.params.rid)
      res.json({ ok: true })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/radicle/identity
  router.get('/identity', async (_req, res) => {
    try {
      const identity = await manager.getIdentity()
      if (!identity) return res.status(404).json({ error: 'no identity found' })
      res.json(identity)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/radicle/identity
  router.post('/identity', async (req, res) => {
    try {
      const { alias } = req.body
      if (!alias) return res.status(400).json({ error: 'alias is required' })
      const identity = await manager.createIdentity(alias)
      res.status(201).json(identity)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/radicle/peers
  router.get('/peers', async (_req, res) => {
    try {
      const peers = await manager.listPeers()
      res.json(peers)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/radicle/peers
  router.post('/peers', async (req, res) => {
    try {
      const { nodeId, address } = req.body
      if (!nodeId) return res.status(400).json({ error: 'nodeId is required' })
      await manager.connectPeer(nodeId, address)
      res.json({ ok: true })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

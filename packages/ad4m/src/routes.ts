import { Router } from 'express'
import type { Request, Response } from 'express'
import type { Ad4mClientManager } from './client.js'
import type { WatcherController } from './waker.js'
import { readToken, writeToken, generateRand } from './auth.js'

function notConnected(res: Response) {
  res.status(503).json({ error: 'AD4M client not connected' })
}

export function createAd4mRoutes(
  clientManager: Ad4mClientManager,
  tokenFile: string,
  watcher?: WatcherController
): ReturnType<typeof Router> {
  const router = Router()

  // GET /api/ad4m/status
  router.get('/api/ad4m/status', async (_req: Request, res: Response) => {
    const client = clientManager.getClient()
    if (!client) {
      res.json({ connected: false, hasToken: readToken(tokenFile) !== null })
      return
    }
    try {
      const status = await client.agent.status()
      res.json({
        connected: clientManager.isConnected(),
        hasToken: true,
        isInitialized: status.isInitialized,
        isUnlocked: status.isUnlocked,
        did: status.did
      })
    } catch (err) {
      res.json({ connected: false, hasToken: readToken(tokenFile) !== null, error: String(err) })
    }
  })

  // GET /api/ad4m/perspectives — list all joined perspectives (used by ChatSettings)
  router.get('/api/ad4m/perspectives', async (_req: Request, res: Response) => {
    const client = clientManager.getClient()
    if (!client) {
      notConnected(res)
      return
    }
    try {
      const perspectives = await client.perspective.all()
      res.json({ perspectives })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /api/ad4m/command — slash command handler for /ad4m watch|unwatch <url>
  router.post('/api/ad4m/command', async (req: Request, res: Response) => {
    const client = clientManager.getClient()
    if (!client) {
      notConnected(res)
      return
    }
    if (!watcher) {
      res.status(503).json({ ok: false, error: 'watcher not available' })
      return
    }

    const { action, url, threadKey } = req.body as { action?: string; url?: string; threadKey?: string }
    if (!action || !url || !threadKey) {
      res.status(400).json({ ok: false, error: 'action, url, and threadKey are required' })
      return
    }
    if (action !== 'watch' && action !== 'unwatch') {
      res.status(400).json({ ok: false, error: `Unknown action "${action}". Use watch or unwatch.` })
      return
    }

    try {
      const perspectives = await client.perspective.all()
      const match = perspectives.find((p) => p.sharedUrl === url)

      if (action === 'watch') {
        if (!match) {
          res.json({ ok: false, error: `No joined perspective with URL ${url}. Join the neighbourhood first.` })
          return
        }
        const label = match.name || `AD4M: ${url}`
        watcher.watchPerspective(match.uuid, threadKey, label)
        res.json({
          ok: true,
          message: `✓ Watching ${url} → thread "${threadKey}" (${match.name || match.uuid.slice(0, 8)})`
        })
      } else {
        if (!match) {
          res.json({ ok: false, error: `No joined perspective with URL ${url}.` })
          return
        }
        watcher.unwatchPerspective(match.uuid)
        res.json({ ok: true, message: `✓ Unwatched ${url}` })
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) })
    }
  })

  // ── Watch management — fully dynamic, no restart needed ──────────────────────

  // GET /api/ad4m/watch/perspectives — list all watched perspectives
  router.get('/api/ad4m/watch/perspectives', (_req: Request, res: Response) => {
    if (!watcher) {
      res.json({ watched: [] })
      return
    }
    res.json({ watched: watcher.getWatched() })
  })

  // POST /api/ad4m/watch/perspectives — add a watch
  // Body: { uuid, threadKey?, label? }
  // If threadKey is omitted, defaults to "ad4m/perspective/<uuid>"
  router.post('/api/ad4m/watch/perspectives', (req: Request, res: Response) => {
    if (!watcher) {
      res.status(503).json({ error: 'watcher not available' })
      return
    }
    const { uuid, threadKey, label } = req.body as { uuid?: string; threadKey?: string; label?: string }
    if (!uuid) {
      res.status(400).json({ error: 'uuid required' })
      return
    }
    const key = threadKey ?? `ad4m/perspective/${uuid}`
    watcher.watchPerspective(uuid, key, label)
    res.json({ ok: true, uuid, threadKey: key })
  })

  // DELETE /api/ad4m/watch/perspectives/:uuid — remove a watch
  router.delete('/api/ad4m/watch/perspectives/:uuid', (req: Request, res: Response) => {
    if (!watcher) {
      res.status(503).json({ error: 'watcher not available' })
      return
    }
    watcher.unwatchPerspective(req.params.uuid)
    res.json({ ok: true })
  })

  // ── Auth setup (one-time capability flow) ─────────────────────────────────────

  // POST /api/ad4m/auth/setup — starts capability request flow
  router.post('/api/ad4m/auth/setup', async (req: Request, res: Response) => {
    const client = clientManager.getClient()
    if (!client) {
      notConnected(res)
      return
    }
    try {
      const { appName = 'Sovereign', appDesc = 'Sovereign AI platform' } = req.body as {
        appName?: string
        appDesc?: string
      }
      const requestId = await client.agent.requestCapability({
        appName,
        appDesc,
        appUrl: 'http://localhost:3001',
        appDomain: 'sovereign.local',
        capabilities: [{ with: { domain: '*', pointers: ['*'] }, can: ['*'] }]
      })
      res.json({
        requestId,
        instructions: `1. Open ADAM Launcher\n2. Go to Settings → Authorized Apps\n3. Approve the request from "${appName}"\n4. Then POST /api/ad4m/auth/complete with { requestId: "${requestId}" }`
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /api/ad4m/auth/complete — completes capability flow, saves JWT
  router.post('/api/ad4m/auth/complete', async (req: Request, res: Response) => {
    const client = clientManager.getClient()
    if (!client) {
      notConnected(res)
      return
    }
    try {
      const { requestId, rand: providedRand } = req.body as { requestId: string; rand?: string }
      if (!requestId) {
        res.status(400).json({ error: 'requestId required' })
        return
      }
      const rand = providedRand ?? generateRand()
      const token = await client.agent.generateJwt(requestId, rand)
      writeToken(tokenFile, token)
      clientManager.setToken(token)
      await new Promise((r) => setTimeout(r, 500))
      const newClient = clientManager.getClient()
      if (newClient) {
        const status = await newClient.agent.status().catch(() => null)
        res.json({ ok: true, did: status?.did ?? 'unknown', message: 'Token saved. AD4M connected.' })
        return
      }
      res.json({ ok: true, message: 'Token saved.' })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}

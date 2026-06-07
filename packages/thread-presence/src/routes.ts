// thread-presence — REST routes for mute management. Active-thread state is
// WS-only (no REST surface needed; it's a transient signal).

import { Router } from 'express'
import type { MuteStore } from './mute-store.js'

export function createThreadPresenceRoutes(muteStore: MuteStore): Router {
  const router = Router()

  router.get('/api/thread-presence/mutes', (_req, res) => {
    res.json({ mutedThreadIds: muteStore.list() })
  })

  router.put('/api/thread-presence/mute/:threadId', (req, res) => {
    const { threadId } = req.params
    if (!threadId) {
      res.status(400).json({ error: 'threadId required' })
      return
    }
    const body = (req.body ?? {}) as { muted?: unknown }
    const muted = body.muted === true
    if (muted) muteStore.mute(threadId)
    else muteStore.unmute(threadId)
    res.json({ threadId, muted: muteStore.isMuted(threadId) })
  })

  router.put('/api/thread-presence/mutes', (req, res) => {
    const body = (req.body ?? {}) as { mutedThreadIds?: unknown }
    const ids = Array.isArray(body.mutedThreadIds) ? (body.mutedThreadIds as string[]) : []
    muteStore.setAll(ids.filter((id) => typeof id === 'string'))
    res.json({ mutedThreadIds: muteStore.list() })
  })

  return router
}

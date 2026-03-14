// Chat Module — REST endpoints

import { Router } from 'express'
import type { ChatModule } from './chat.js'
import type { AgentBackend } from '@sovereign/core'

export function createChatRoutes(chatModule: ChatModule, backend: AgentBackend): Router {
  const router = Router()

  router.get('/api/chat/status', (_req, res) => {
    res.json({ status: backend.status() })
  })

  router.post('/api/chat/send', async (req, res) => {
    try {
      const { threadKey, message } = req.body ?? {}
      if (!threadKey || !message) {
        return res.status(400).json({ error: 'threadKey and message are required' })
      }
      await chatModule.handleSend(threadKey, message)
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/api/chat/sessions', async (_req, res) => {
    try {
      const label = _req.body?.label as string | undefined
      const result = await chatModule.handleSessionCreate(label)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

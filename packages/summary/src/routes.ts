// Summary API routes — GET /api/threads/:id/summary

import { Router } from 'express'
import type { SummaryService } from './summary-service.js'

export function createSummaryRoutes(summaryService: SummaryService): Router {
  const router = Router()

  router.get('/api/threads/:id/summary', (req, res) => {
    const threadKey = req.params.id
    const summary = summaryService.getSummary(threadKey)
    if (!summary) {
      res.status(404).json({ error: 'No summary available for this thread' })
      return
    }
    res.json(summary)
  })

  router.post('/api/threads/:id/summary/force', async (req, res) => {
    const threadKey = req.params.id
    try {
      const summary = await summaryService.forceSummary(threadKey)
      if (!summary) {
        res.status(404).json({ error: 'No events to summarize' })
        return
      }
      res.json(summary)
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Summary generation failed' })
    }
  })

  router.get('/api/summary/health', async (_req, res) => {
    const healthy = await summaryService.healthCheck()
    res.json({ healthy, enabled: true })
  })

  return router
}

// System REST endpoints: GET /api/system/architecture, GET /api/system/health, GET /api/system/logs

import { Router } from 'express'
import type { SystemModule } from './system.js'
import type { LogsChannel } from './ws.js'
import { readPersistedLogs } from './ws.js'

export interface SystemRoutesOptions {
  system: SystemModule
  logsChannel: LogsChannel
  dataDir: string
}

export function createSystemRoutes(opts: SystemRoutesOptions | SystemModule): Router {
  const router = Router()

  // Support old 1-arg signature for backward compat
  const system = 'system' in opts ? (opts as SystemRoutesOptions).system : (opts as SystemModule)
  const logsChannel = 'logsChannel' in opts ? (opts as SystemRoutesOptions).logsChannel : null
  const dataDir = 'dataDir' in opts ? (opts as SystemRoutesOptions).dataDir : null

  router.get('/api/system/identity', (_req, res) => {
    res.json({
      agentName: process.env.SOVEREIGN_AGENT_NAME || 'Sovereign',
      agentIcon: process.env.SOVEREIGN_AGENT_ICON || '⬡'
    })
  })

  router.get('/api/system/architecture', (_req, res) => {
    res.json(system.getArchitecture())
  })

  router.get('/api/system/health', (_req, res) => {
    res.json(system.getHealth())
  })

  router.get('/api/system/logs', (req, res) => {
    const { level, module, since, limit, offset } = req.query as Record<string, string | undefined>
    if (dataDir) {
      const entries = readPersistedLogs(dataDir, {
        level,
        module,
        since,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined
      })
      res.json({ entries, total: entries.length })
    } else if (logsChannel) {
      // fallback to buffer
      let entries = logsChannel.getBuffer()
      if (level) entries = entries.filter((e) => e.level === level)
      if (module) entries = entries.filter((e) => e.module === module)
      if (since) {
        const sinceTs = new Date(since).getTime()
        entries = entries.filter((e) => e.timestamp >= sinceTs)
      }
      const off = offset ? Number(offset) : 0
      const lim = limit ? Number(limit) : entries.length
      entries = entries.slice(off, off + lim)
      res.json({ entries, total: entries.length })
    } else {
      res.json({ entries: [], total: 0 })
    }
  })

  return router
}

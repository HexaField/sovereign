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

async function fetchContextBudgetFromGateway(): Promise<Record<string, unknown> | null> {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789/ws'
  const token = process.env.OPENCLAW_GATEWAY_TOKEN
  // Try HTTP endpoint first (gateway exposes REST on same port)
  const httpUrl = gatewayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '/api/context')
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(httpUrl, { headers, signal: controller.signal })
    clearTimeout(timeout)
    if (res.ok) return (await res.json()) as Record<string, unknown>
  } catch {
    // Gateway unavailable — return null for mock fallback
  }
  return null
}

function mockContextBudget(): Record<string, unknown> {
  return {
    report: {
      source: 'mock',
      generatedAt: Date.now(),
      provider: 'unknown',
      model: 'unknown',
      workspaceDir: process.cwd(),
      bootstrapMaxChars: 50000,
      systemPrompt: { chars: 15000, projectContextChars: 8000, nonProjectContextChars: 7000 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 3000, entries: [] },
      tools: { listChars: 4000, schemaChars: 12000, entries: [] }
    },
    fileContents: {},
    session: { contextTokens: null },
    disabledTools: [],
    disabledSkills: []
  }
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

  router.get('/api/system/context-budget', async (_req, res) => {
    const data = await fetchContextBudgetFromGateway()
    res.json(data ?? mockContextBudget())
  })

  return router
}

// System REST endpoints: GET /api/system/architecture, GET /api/system/health, GET /api/system/logs

import { Router } from 'express'
import type { SystemModule } from './system.js'
import type { LogsChannel } from './ws.js'
import { readPersistedLogs } from './ws.js'
import type { HealthHistory } from './health-history.js'
import type { RoutingBackend } from '../agent-backend/factory.js'
import type { ContextBudget } from '@sovereign/core'

export interface SystemRoutesOptions {
  system: SystemModule
  logsChannel: LogsChannel
  dataDir: string
  healthHistory?: HealthHistory
  /** Routing backend — used for device info, context budget, and gateway restart. */
  routingBackend?: RoutingBackend
}

function mockContextBudget(): ContextBudget {
  return {
    source: 'mock',
    generatedAt: Date.now(),
    provider: 'unknown',
    model: 'unknown',
    workspaceDir: process.cwd(),
    bootstrapMaxChars: 50000,
    systemPrompt: { chars: 15000, projectContextChars: 8000, nonProjectContextChars: 7000 },
    injectedWorkspaceFiles: [],
    skills: { promptChars: 3000, entries: [] },
    tools: { listChars: 4000, schemaChars: 12000, entries: [] },
    fileContents: {},
    session: { contextTokens: null },
    disabledTools: [],
    disabledSkills: []
  }
}

export function createSystemRoutes(opts: SystemRoutesOptions | SystemModule): Router {
  const router = Router()

  const system = 'system' in opts ? (opts as SystemRoutesOptions).system : (opts as SystemModule)
  const logsChannel = 'logsChannel' in opts ? (opts as SystemRoutesOptions).logsChannel : null
  const dataDir = 'dataDir' in opts ? (opts as SystemRoutesOptions).dataDir : null
  const healthHistory = 'healthHistory' in opts ? (opts as SystemRoutesOptions).healthHistory : null
  const routingBackend = 'routingBackend' in opts ? (opts as SystemRoutesOptions).routingBackend : null
  let restartInFlight: Promise<{ message: string; command?: string }> | null = null

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

  router.get('/api/system/context-budget', async (req, res) => {
    if (!routingBackend) {
      res.json(mockContextBudget())
      return
    }
    const sessionKey = (req.query.sessionKey as string) || ''
    try {
      const backend = sessionKey ? routingBackend.forSession(sessionKey) : routingBackend.default()
      const budget = await backend.getContextBudget(sessionKey)
      res.json(budget ?? mockContextBudget())
    } catch {
      res.json(mockContextBudget())
    }
  })

  router.get('/api/system/health/history', (req, res) => {
    if (!healthHistory) {
      res.json({ snapshots: [] })
      return
    }
    const windowMs = req.query.window ? Number(req.query.window) : 3600_000
    res.json({ snapshots: healthHistory.getSnapshots(windowMs) })
  })

  // Device identity endpoint — aggregates across all enabled backends.
  router.get('/api/system/devices', (_req, res) => {
    if (!routingBackend) {
      res.json({ devices: [], error: 'Routing backend not available' })
      return
    }
    const devices: Array<Record<string, unknown>> = []
    for (const inst of routingBackend.all()) {
      const info = inst.backend.getDeviceInfo?.()
      if (!info) continue
      devices.push({
        deviceId: info.deviceId,
        publicKey: info.publicKey,
        name: 'This Device',
        connectionStatus: info.connectionStatus,
        gatewayUrl: info.gatewayUrl,
        reconnectAttempt: info.reconnectAttempt,
        backendKind: info.backendKind,
        isCurrent: true
      })
    }
    res.json({ devices })
  })

  router.post('/api/system/gateway/restart', async (_req, res) => {
    if (!routingBackend) {
      res.status(500).json({ error: 'Routing backend not available' })
      return
    }
    if (restartInFlight) {
      res.status(409).json({ error: 'Gateway restart already in progress' })
      return
    }

    // Find the first backend that supports restart (Phase 0: OpenClaw only).
    const restartable = routingBackend.all().find((i) => typeof i.backend.restart === 'function')
    if (!restartable?.backend.restart) {
      res.status(501).json({ error: 'No backend supports restart' })
      return
    }

    restartInFlight = restartable.backend.restart!()
    try {
      const result = await restartInFlight
      res.status(202).json({ status: 'accepted', ...result })
    } catch (error) {
      const message = error instanceof Error && error.message.trim() ? error.message : 'Failed to restart backend'
      res.status(500).json({ error: message })
    } finally {
      restartInFlight = null
    }
  })

  router.get('/api/system/watchdog', async (_req, res) => {
    const checks: Array<{ name: string; status: 'ok' | 'warning' | 'error'; message: string }> = []

    const health = system.getHealth()
    const backendStatus = health.connection.agentBackend
    checks.push({
      name: 'gateway_reachable',
      status: backendStatus === 'connected' ? 'ok' : backendStatus === 'connecting' ? 'warning' : 'error',
      message: `Agent backend: ${backendStatus}`
    })

    const arch = system.getArchitecture()
    const errorModules = arch.modules.filter((m) => m.status === 'error')
    checks.push({
      name: 'modules_initialized',
      status: errorModules.length > 0 ? 'error' : 'ok',
      message:
        errorModules.length > 0
          ? `${errorModules.length} module(s) in error: ${errorModules.map((m) => m.name).join(', ')}`
          : `All ${arch.modules.length} modules healthy`
    })

    const memPct =
      health.resources.memoryUsage.total > 0
        ? (health.resources.memoryUsage.used / health.resources.memoryUsage.total) * 100
        : 0
    checks.push({
      name: 'memory_adequate',
      status: memPct > 95 ? 'error' : memPct > 85 ? 'warning' : 'ok',
      message: `Memory usage: ${memPct.toFixed(1)}%`
    })

    checks.push({
      name: 'system_uptime',
      status: health.connection.uptime < 5 ? 'warning' : 'ok',
      message: `Uptime: ${health.connection.uptime}s`
    })

    const overallStatus = checks.some((c) => c.status === 'error')
      ? 'error'
      : checks.some((c) => c.status === 'warning')
        ? 'warning'
        : 'ok'

    res.json({ status: overallStatus, checks, timestamp: new Date().toISOString() })
  })

  return router
}

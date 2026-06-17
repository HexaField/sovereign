// System REST endpoints: GET /api/system/architecture, GET /api/system/health, GET /api/system/logs

import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import type { SystemModule } from './system.js'
import type { LogsChannel } from './ws.js'
import { readPersistedLogs } from './ws.js'
import type { HealthHistory } from './health-history.js'
import type { RoutingBackend, ActiveSessions } from '@sovereign/agent-backend'
import type { ContextBudget, EventBus } from '@sovereign/core'
import type { EventStream } from './event-stream.js'
import type { WsHandler } from '@sovereign/primitives'

export interface PersonalityInfo {
  compiledAt: number | null
  size: number
  watcherActive: boolean
  outputPath: string
}

export interface SystemRoutesOptions {
  system: SystemModule
  logsChannel: LogsChannel
  dataDir: string
  healthHistory?: HealthHistory
  /** Routing backend — used for device info, context budget, and gateway restart. */
  routingBackend?: RoutingBackend
  /** Canonical liveness index — when present, `/api/system/agents/active` reads from here (R9). */
  activeSessions?: ActiveSessions
  /** Event-stream module — when present the `/api/system/events*` routes are mounted. */
  eventStream?: EventStream
  /** Used by event-stream retry to re-emit events on the bus. */
  bus?: EventBus
  /** Identity accessor — overrides the static default for /api/system/identity. */
  getIdentity?: () => { agentName: string; agentIcon: string }
  /** Personality compiler info — drives /api/system/personality. */
  getPersonalityInfo?: () => PersonalityInfo | null
  /** Thread meta accessor for enriching agents/active response. */
  getThreadMeta?: (key: string) => { label?: string; membraneId?: string } | null
  /** Push manager for subscription status endpoint. */
  pushManager?: { allSubscriptions(): { size: number }; getVapidPublicKey?(): string | null }
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
  const activeSessions = 'activeSessions' in opts ? (opts as SystemRoutesOptions).activeSessions : null

  const getIdentity = 'getIdentity' in opts ? (opts as SystemRoutesOptions).getIdentity : null
  router.get('/api/system/identity', (_req, res) => {
    if (getIdentity) {
      res.json(getIdentity())
      return
    }
    res.json({ agentName: 'Sovereign', agentIcon: '⬡' })
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

  // Active-agent census — enriched with label + membraneId from thread registry.
  router.get('/api/system/agents/active', (_req, res) => {
    if (!activeSessions) {
      res.json({ count: 0, sessions: [] })
      return
    }
    const getThreadMeta = 'getThreadMeta' in opts ? (opts as SystemRoutesOptions).getThreadMeta : null
    const sessions = activeSessions.list().map((e) => {
      const meta = getThreadMeta?.(e.threadKey) ?? null
      return {
        key: e.sessionKey,
        threadKey: e.threadKey,
        kind: e.sessionKey.includes(':subagent:') ? 'subagent' : 'thread',
        agentStatus: e.agentStatus,
        backendKind: e.backendKind,
        lastActivity: e.lastTransitionAt,
        label: meta?.label ?? e.threadKey,
        membraneId: meta?.membraneId ?? null
      }
    })
    res.json({ count: sessions.length, sessions })
  })

  // Personality compiler info — CLAUDE.md stat + watcher state.
  router.get('/api/system/personality', (_req, res) => {
    const getPersonalityInfo = 'getPersonalityInfo' in opts ? (opts as SystemRoutesOptions).getPersonalityInfo : null
    if (getPersonalityInfo) {
      res.json(getPersonalityInfo() ?? { compiledAt: null, size: 0, watcherActive: false, outputPath: '' })
      return
    }
    // Fallback: stat the default output path directly
    const outputPath = path.join(process.env.HOME ?? '', '.claude', 'CLAUDE.md')
    try {
      const stat = fs.statSync(outputPath)
      res.json({ compiledAt: stat.mtimeMs, size: stat.size, watcherActive: false, outputPath })
    } catch {
      res.json({ compiledAt: null, size: 0, watcherActive: false, outputPath })
    }
  })

  // Hooks summary — reads ~/.claude/settings.json and returns hook event names + counts.
  router.get('/api/system/hooks', (_req, res) => {
    const settingsPath = path.join(process.env.HOME ?? '', '.claude', 'settings.json')
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw) as Record<string, unknown>
      const hooks = settings.hooks as Record<string, { hooks?: unknown[] }> | undefined
      if (!hooks || typeof hooks !== 'object') {
        res.json({ events: [] })
        return
      }
      const events = Object.entries(hooks).map(([event, val]) => ({
        event,
        count: Array.isArray(val?.hooks) ? val.hooks.length : 0
      }))
      res.json({ events, total: events.reduce((s, e) => s + e.count, 0) })
    } catch {
      res.json({ events: [], total: 0 })
    }
  })

  // Push notification subscription status.
  router.get('/api/system/push-status', (_req, res) => {
    const pm = 'pushManager' in opts ? (opts as SystemRoutesOptions).pushManager : null
    if (!pm) {
      res.json({ subscriptionCount: 0, vapidConfigured: false })
      return
    }
    res.json({
      subscriptionCount: pm.allSubscriptions().size,
      vapidConfigured: typeof pm.getVapidPublicKey === 'function' ? pm.getVapidPublicKey() !== null : false
    })
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

    if (health.services?.mcp) {
      const mcp = health.services.mcp
      checks.push({
        name: 'mcp_sidecar',
        status: mcp.status === 'ok' ? 'ok' : mcp.status === 'unknown' ? 'warning' : 'error',
        message:
          mcp.status === 'ok'
            ? `MCP sidecar: ${mcp.sessions} session(s), ${mcp.tools} tool(s)`
            : `MCP sidecar: ${mcp.status}`
      })
    }

    const overallStatus = checks.some((c) => c.status === 'error')
      ? 'error'
      : checks.some((c) => c.status === 'warning')
        ? 'warning'
        : 'ok'

    res.json({ status: overallStatus, checks, timestamp: new Date().toISOString() })
  })

  // ── Event stream ──────────────────────────────────────────────────────
  const eventStream = 'eventStream' in opts ? (opts as SystemRoutesOptions).eventStream : null
  const bus = 'bus' in opts ? (opts as SystemRoutesOptions).bus : null
  if (eventStream) {
    router.get('/api/system/events', (req, res) => {
      const { type, source, since, until, entityId, limit, offset } = req.query as Record<string, string | undefined>
      const filter: Record<string, unknown> = {}
      if (type) filter.type = type
      if (source) filter.source = source
      if (since) filter.since = Number(since)
      if (until) filter.until = Number(until)
      if (entityId) filter.entityId = entityId
      if (limit) filter.limit = Number(limit)
      if (offset) filter.offset = Number(offset)
      const entries = eventStream.query(filter as any)
      res.json({ events: entries, total: entries.length })
    })

    router.get('/api/system/events/stats', (_req, res) => {
      res.json(eventStream.stats())
    })

    router.post('/api/events/:id/retry', (req, res) => {
      const id = Number(req.params.id)
      const entries = eventStream.query({ limit: 5000 })
      const entry = entries.find((e) => e.id === id)
      if (!entry) {
        res.status(404).json({ error: 'Event not found' })
        return
      }
      if (bus) bus.emit(entry.event)
      res.json({ success: true, retriedId: id })
    })
  }

  return router
}

/**
 * Register the events WS channel and bridge new event-stream entries onto it.
 */
export function registerEventsChannel(wsHandler: WsHandler, eventStream: EventStream): void {
  wsHandler.registerChannel('events', {
    serverMessages: ['event.new', 'event.history'],
    clientMessages: [],
    onSubscribe: (deviceId) => {
      const recent = eventStream.query({ limit: 100 })
      wsHandler.sendTo(deviceId, {
        type: 'event.history',
        events: recent,
        timestamp: new Date().toISOString()
      })
    }
  })
  eventStream.subscribe((entry) => {
    wsHandler.broadcastToChannel('events', {
      type: 'event.new',
      ...entry,
      timestamp: new Date().toISOString()
    })
  })
}

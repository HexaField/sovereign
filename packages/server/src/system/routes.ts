// System REST endpoints: GET /api/system/architecture, GET /api/system/health, GET /api/system/logs

import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SystemModule } from './system.js'
import type { LogsChannel } from './ws.js'
import { readPersistedLogs } from './ws.js'
import type { HealthHistory } from './health-history.js'

export interface DeviceInfoProvider {
  getDeviceInfo(): {
    deviceId: string
    publicKey: string
    connectionStatus: string
    gatewayUrl: string
    reconnectAttempt: number
  }
}

export interface GatewayRestartService {
  restart(): Promise<{ message: string; command: string }>
}

export interface SystemRoutesOptions {
  system: SystemModule
  logsChannel: LogsChannel
  dataDir: string
  healthHistory?: HealthHistory
  deviceInfoProvider?: DeviceInfoProvider
  gatewayRestart?: GatewayRestartService
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

const execFileAsync = promisify(execFile)

export function createGatewayRestartService(): GatewayRestartService {
  return {
    async restart() {
      const command = 'openclaw gateway restart'
      const { stdout, stderr } = await execFileAsync('openclaw', ['gateway', 'restart'], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      })
      const output = [stdout, stderr].filter(Boolean).join('\n').trim()
      return {
        command,
        message: output || 'OpenClaw gateway restart completed'
      }
    }
  }
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
  const healthHistory = 'healthHistory' in opts ? (opts as SystemRoutesOptions).healthHistory : null
  const deviceInfoProvider = 'deviceInfoProvider' in opts ? (opts as SystemRoutesOptions).deviceInfoProvider : null
  const gatewayRestart =
    'gatewayRestart' in opts ? (opts as SystemRoutesOptions).gatewayRestart : createGatewayRestartService()
  let restartInFlight: Promise<{ message: string; command: string }> | null = null

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

  router.get('/api/system/health/history', (req, res) => {
    if (!healthHistory) {
      res.json({ snapshots: [] })
      return
    }
    const windowMs = req.query.window ? Number(req.query.window) : 3600_000
    res.json({ snapshots: healthHistory.getSnapshots(windowMs) })
  })

  // Device identity endpoint
  router.get('/api/system/devices', (_req, res) => {
    if (!deviceInfoProvider) {
      res.json({ devices: [], error: 'Device info not available' })
      return
    }
    const info = deviceInfoProvider.getDeviceInfo()
    res.json({
      devices: [
        {
          deviceId: info.deviceId,
          publicKey: info.publicKey,
          name: 'This Device',
          connectionStatus: info.connectionStatus,
          gatewayUrl: info.gatewayUrl,
          reconnectAttempt: info.reconnectAttempt,
          isCurrent: true
        }
      ]
    })
  })

  router.post('/api/system/gateway/restart', async (_req, res) => {
    if (!gatewayRestart) {
      res.status(500).json({ error: 'Gateway restart service unavailable' })
      return
    }

    if (restartInFlight) {
      res.status(409).json({ error: 'Gateway restart already in progress' })
      return
    }

    restartInFlight = gatewayRestart.restart()
    try {
      const result = await restartInFlight
      res.status(202).json({ status: 'accepted', ...result })
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() ? error.message : 'Failed to restart OpenClaw gateway'
      res.status(500).json({ error: message })
    } finally {
      restartInFlight = null
    }
  })

  // Watchdog endpoint
  router.get('/api/system/watchdog', async (_req, res) => {
    const checks: Array<{ name: string; status: 'ok' | 'warning' | 'error'; message: string }> = []

    // Check gateway reachability
    const health = system.getHealth()
    const backendStatus = health.connection.agentBackend
    checks.push({
      name: 'gateway_reachable',
      status: backendStatus === 'connected' ? 'ok' : backendStatus === 'connecting' ? 'warning' : 'error',
      message: `Agent backend: ${backendStatus}`
    })

    // Check modules initialized
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

    // Check disk space
    const memPct =
      health.resources.memoryUsage.total > 0
        ? (health.resources.memoryUsage.used / health.resources.memoryUsage.total) * 100
        : 0
    checks.push({
      name: 'memory_adequate',
      status: memPct > 95 ? 'error' : memPct > 85 ? 'warning' : 'ok',
      message: `Memory usage: ${memPct.toFixed(1)}%`
    })

    // Check uptime (proxy for stuck threads — if uptime < 5s, still starting)
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

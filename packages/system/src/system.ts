// System module — architecture and health reporting

import os from 'node:os'
import { execSync, spawnSync } from 'node:child_process'
import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '@sovereign/primitives'

export interface ModuleInfo {
  name: string
  status: string
  subscribes: string[]
  publishes: string[]
}

/**
 * Health snapshot for the `semble` code-search CLI that Claude Code sessions
 * invoke as an MCP tool (and Sovereign inherits via `~/.claude.json`). Ok
 * means the binary responded to a probe; version is best-effort — resolved
 * from `uv tool list` at boot when available.
 */
export interface SembleServiceHealth {
  status: 'ok' | 'down' | 'unknown'
  version: string
}

/**
 * Census of Claude Code sessions as the CLI itself sees them (`claude agents
 * --json`). This is an independent view of Sovereign's own liveness index:
 * `interactive` entries are sessions Sovereign spawned, `background` entries
 * are detached workers. Divergence between this count and
 * `active-sessions.json` is the signal for a leaked or orphaned process.
 */
export interface AgentsCensusHealth {
  status: 'ok' | 'down' | 'unknown'
  /** Sessions Sovereign spawned via the SDK. */
  interactive: number
  /** Detached background workers (`claude --bg`). */
  background: number
}

/**
 * Health snapshot for an external service (AD4M executor, WE launcher, …)
 * that the browser can open in a new tab. `port` and `path` describe how to
 * construct the outward URL (protocol is always http — these are LAN/tailnet
 * plain-HTTP services fronted by Tailscale, not the Sovereign origin).
 */
export interface ExternalServiceHealth {
  name: string
  label: string
  port: number
  path: string
  status: 'ok' | 'down' | 'unknown'
}

export interface HealthInfo {
  connection: { wsStatus: string; agentBackend: string; uptime: number }
  resources: {
    diskUsage: { used: number; total: number }
    memoryUsage: { used: number; total: number }
  }
  jobs: { active: number; lastStatus: string; nextRun: string | null }
  errors: { countLastHour: number; recent: Array<{ message: string; timestamp: string }> }
  services?: {
    semble?: SembleServiceHealth
    agents?: AgentsCensusHealth
    external?: ExternalServiceHealth[]
  }
}

export interface ArchitectureData {
  modules: ModuleInfo[]
  config: { models: string[]; defaultModel: string | null }
  sessions: { total: number; byKind: Record<string, number> }
  cron: { jobs: Array<{ name: string; schedule: string; status: string }> }
  skills: { entries: Array<{ name: string; enabled: boolean }>; total: number; enabled: number }
  system: {
    os: string
    arch: string
    platform: string
    cpus: number
    totalMemory: number
    freeMemory: number
    uptime: number
    nodeVersion: string
  }
}

export interface SystemModule {
  name: string
  status(): { healthy: boolean }
  getArchitecture(): ArchitectureData
  getHealth(): HealthInfo
  registerModule(info: ModuleInfo): void
  dispose(): void
}

export interface SystemModuleOptions {
  healthIntervalMs?: number
  wsHandler?: WsHandler
  getAgentBackendStatus?: () => string
  /** Optional accessor for the curated models list + default. Falls back to {models:[], defaultModel:null}. */
  getModelConfig?: () => { models: string[]; defaultModel: string | null }
  /**
   * Executable used to probe the `semble` code-search CLI. Defaults to
   * `semble` on PATH. Set to '' to disable the semble health row entirely.
   */
  sembleBin?: string
  /**
   * Executable used to probe the Claude Code session census (`claude agents
   * --json`). Defaults to `claude` on PATH. Set to '' to disable the row.
   */
  claudeBin?: string
  /**
   * External services to include in health rollups. Each entry is polled on
   * the same interval as MCP. `healthUrl` is server-side (typically localhost)
   * for reachability; `port` + `path` are what the browser uses to open the
   * service in a new tab, resolved against `window.location.hostname`.
   */
  externalServices?: Array<{
    name: string
    label?: string
    healthUrl: string
    port: number
    path?: string
  }>
}

let cachedDiskUsage = { used: 0, total: 0 }
let diskCacheTime = 0

function getDiskUsage(): { used: number; total: number } {
  const now = Date.now()
  if (now - diskCacheTime < 60_000) return cachedDiskUsage
  try {
    const output = execSync('df -k /', { encoding: 'utf-8', timeout: 5000 })
    const lines = output.trim().split('\n')
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/)
      if (parts.length >= 4) {
        const total = parseInt(parts[1], 10) * 1024
        const used = parseInt(parts[2], 10) * 1024
        if (total > 0) {
          cachedDiskUsage = { used, total }
          diskCacheTime = now
        }
      }
    }
  } catch {
    /* use cached */
  }
  return cachedDiskUsage
}

export function createSystemModule(bus: EventBus, _dataDir: string, options?: SystemModuleOptions): SystemModule {
  const startTime = Date.now()
  const registeredModules: ModuleInfo[] = []
  const healthIntervalMs = options?.healthIntervalMs ?? 10_000
  const wsHandler = options?.wsHandler
  const sembleBin = options?.sembleBin ?? 'semble'
  const claudeBin = options?.claudeBin ?? 'claude'
  const externalServiceDefs = (options?.externalServices ?? []).map((s) => ({
    name: s.name,
    label: s.label ?? s.name,
    healthUrl: s.healthUrl,
    port: s.port,
    path: s.path ?? '/'
  }))

  // Cached semble CLI health. `semble` has no `--version` flag; we probe with
  // `-h` (exit 0, sub-100ms) and resolve the installed version once from
  // `uv tool list` at boot — good enough for a status row.
  let cachedSembleHealth: SembleServiceHealth = { status: 'unknown', version: '' }
  let cachedAgentsHealth: AgentsCensusHealth = { status: 'unknown', interactive: 0, background: 0 }
  const resolvedSembleVersion = (() => {
    if (!sembleBin) return ''
    try {
      const out = spawnSync('uv', ['tool', 'list'], { encoding: 'utf-8', timeout: 3000 })
      if (out.status !== 0) return ''
      const m = out.stdout.match(/^semble\s+v?([\d.]+)/m)
      return m ? m[1] : ''
    } catch {
      return ''
    }
  })()
  // Cached external service health, keyed by name.
  const cachedExternalHealth = new Map<string, ExternalServiceHealth>(
    externalServiceDefs.map((s) => [
      s.name,
      { name: s.name, label: s.label, port: s.port, path: s.path, status: 'unknown' as const }
    ])
  )

  function pollSembleHealth(): void {
    if (!sembleBin) {
      cachedSembleHealth = { status: 'unknown', version: '' }
      return
    }
    try {
      const probe = spawnSync(sembleBin, ['-h'], { encoding: 'utf-8', timeout: 2000 })
      cachedSembleHealth = {
        status: probe.status === 0 ? 'ok' : 'down',
        version: resolvedSembleVersion
      }
    } catch {
      cachedSembleHealth = { status: 'down', version: resolvedSembleVersion }
    }
  }

  function pollAgentsCensus(): void {
    if (!claudeBin) {
      cachedAgentsHealth = { status: 'unknown', interactive: 0, background: 0 }
      return
    }
    try {
      // `--json` is the documented scripting surface and needs no TTY. The 8s
      // cap is generous: the CLI may cold-start an on-demand daemon on first
      // call, which is slower than the steady-state read.
      const probe = spawnSync(claudeBin, ['agents', '--json'], { encoding: 'utf-8', timeout: 8000 })
      if (probe.status !== 0 || !probe.stdout) {
        cachedAgentsHealth = { status: 'down', interactive: 0, background: 0 }
        return
      }
      const parsed = JSON.parse(probe.stdout) as Array<{ kind?: string }>
      if (!Array.isArray(parsed)) {
        cachedAgentsHealth = { status: 'down', interactive: 0, background: 0 }
        return
      }
      let interactive = 0
      let background = 0
      for (const s of parsed) {
        if (s?.kind === 'background') background++
        else interactive++
      }
      cachedAgentsHealth = { status: 'ok', interactive, background }
    } catch {
      cachedAgentsHealth = { status: 'down', interactive: 0, background: 0 }
    }
  }

  async function pollExternalHealth(): Promise<void> {
    if (externalServiceDefs.length === 0) return
    await Promise.all(
      externalServiceDefs.map(async (svc) => {
        let status: 'ok' | 'down' = 'down'
        try {
          // Any HTTP response (even 400/404) means the socket accepted the
          // connection — the service is up. Only network errors/timeout mean down.
          await fetch(svc.healthUrl, { signal: AbortSignal.timeout(2000), method: 'GET' })
          status = 'ok'
        } catch {
          status = 'down'
        }
        cachedExternalHealth.set(svc.name, {
          name: svc.name,
          label: svc.label,
          port: svc.port,
          path: svc.path,
          status
        })
      })
    )
  }

  // Register WS system channel if wsHandler provided
  if (wsHandler) {
    wsHandler.registerChannel('system', {
      serverMessages: ['system.architecture', 'system.health'],
      clientMessages: [],
      onSubscribe: (deviceId) => {
        wsHandler.sendTo(deviceId, {
          type: 'system.architecture',
          modules: [...registeredModules],
          timestamp: new Date().toISOString()
        })
        wsHandler.sendTo(deviceId, {
          type: 'system.health',
          ...getHealth(),
          timestamp: new Date().toISOString()
        })
      }
    })
  }

  const registerModule = (info: ModuleInfo): void => {
    const existing = registeredModules.findIndex((m) => m.name === info.name)
    if (existing >= 0) registeredModules[existing] = info
    else registeredModules.push(info)

    bus.emit({
      type: 'system.architecture.updated',
      timestamp: new Date().toISOString(),
      source: 'system',
      payload: { modules: [...registeredModules] }
    })

    if (wsHandler) {
      wsHandler.broadcastToChannel('system', {
        type: 'system.architecture',
        modules: [...registeredModules],
        timestamp: new Date().toISOString()
      })
    }
  }

  const getArchitecture = (): ArchitectureData => ({
    modules: [...registeredModules],
    config: options?.getModelConfig?.() ?? { models: [], defaultModel: null },
    sessions: { total: 0, byKind: {} },
    cron: { jobs: [] },
    skills: { entries: [], total: 0, enabled: 0 },
    system: {
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      platform: os.platform(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: os.uptime(),
      nodeVersion: process.version
    }
  })

  const getHealth = (): HealthInfo => {
    const uptimeMs = Date.now() - startTime
    const mem = process.memoryUsage()
    const totalMem = os.totalmem()
    const health: HealthInfo = {
      connection: {
        wsStatus: `${wsHandler?.getConnectedDevices().length ?? 0} clients`,
        agentBackend: options?.getAgentBackendStatus?.() ?? 'disconnected',
        uptime: Math.floor(uptimeMs / 1000)
      },
      resources: {
        diskUsage: getDiskUsage(),
        memoryUsage: { used: mem.rss, total: totalMem }
      },
      jobs: { active: 0, lastStatus: 'idle', nextRun: null },
      errors: { countLastHour: 0, recent: [] }
    }
    if (sembleBin || claudeBin || externalServiceDefs.length > 0) {
      health.services = {}
      if (sembleBin) health.services.semble = cachedSembleHealth
      if (claudeBin) health.services.agents = cachedAgentsHealth
      if (externalServiceDefs.length > 0) {
        health.services.external = externalServiceDefs.map((s) => cachedExternalHealth.get(s.name)!)
      }
    }
    return health
  }

  const status = () => ({ healthy: true })

  // Kick off initial polls (non-blocking)
  void pollExternalHealth()
  pollSembleHealth()
  pollAgentsCensus()

  // Periodic health emission
  const healthInterval = setInterval(() => {
    // Fire-and-forget — cached values are used even if fetches are in-flight.
    void pollExternalHealth()
    pollSembleHealth()
    pollAgentsCensus()

    const health = getHealth()
    bus.emit({
      type: 'system.health.updated',
      timestamp: new Date().toISOString(),
      source: 'system',
      payload: health
    })
    if (wsHandler) {
      wsHandler.broadcastToChannel('system', {
        type: 'system.health',
        ...health,
        timestamp: new Date().toISOString()
      })
    }
  }, healthIntervalMs)

  // Register self
  registerModule({
    name: 'system',
    status: 'healthy',
    subscribes: [],
    publishes: ['system.health.updated', 'system.architecture.updated']
  })

  const dispose = (): void => {
    clearInterval(healthInterval)
  }

  return { name: 'system', status, getArchitecture, getHealth, registerModule, dispose }
}

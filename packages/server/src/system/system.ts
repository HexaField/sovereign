// System module — architecture and health reporting

import os from 'node:os'
import type { EventBus } from '@template/core'
import type { WsHandler } from '../ws/handler.js'

export interface ModuleInfo {
  name: string
  status: string
  subscribes: string[]
  publishes: string[]
}

export interface HealthInfo {
  connection: { wsStatus: string; agentBackend: string; uptime: number }
  resources: {
    diskUsage: { used: number; total: number }
    memoryUsage: { used: number; total: number }
  }
  jobs: { active: number; lastStatus: string; nextRun: string | null }
  errors: { countLastHour: number; recent: Array<{ message: string; timestamp: string }> }
}

export interface SystemModule {
  name: string
  status(): { healthy: boolean }
  getArchitecture(): { modules: ModuleInfo[] }
  getHealth(): HealthInfo
  registerModule(info: ModuleInfo): void
  dispose(): void
}

export interface SystemModuleOptions {
  healthIntervalMs?: number
  wsHandler?: WsHandler
}

export function createSystemModule(bus: EventBus, _dataDir: string, options?: SystemModuleOptions): SystemModule {
  const startTime = Date.now()
  const registeredModules: ModuleInfo[] = []
  const healthIntervalMs = options?.healthIntervalMs ?? 10_000
  const wsHandler = options?.wsHandler

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

  const getArchitecture = (): { modules: ModuleInfo[] } => ({
    modules: [...registeredModules]
  })

  const getHealth = (): HealthInfo => {
    const uptimeMs = Date.now() - startTime
    const mem = process.memoryUsage()
    const totalMem = os.totalmem()
    return {
      connection: {
        wsStatus: '0 clients',
        agentBackend: 'disconnected',
        uptime: Math.floor(uptimeMs / 1000)
      },
      resources: {
        diskUsage: { used: 0, total: 0 },
        memoryUsage: { used: mem.rss, total: totalMem }
      },
      jobs: { active: 0, lastStatus: 'idle', nextRun: null },
      errors: { countLastHour: 0, recent: [] }
    }
  }

  const status = () => ({ healthy: true })

  // Periodic health emission
  const healthInterval = setInterval(() => {
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

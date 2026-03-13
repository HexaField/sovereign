// System module — architecture and health reporting

import os from 'node:os'
import type { EventBus } from '@template/core'

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
}

export function createSystemModule(_bus: EventBus, _dataDir: string): SystemModule {
  const startTime = Date.now()
  const registeredModules: ModuleInfo[] = []

  const registerModule = (info: ModuleInfo): void => {
    const existing = registeredModules.findIndex((m) => m.name === info.name)
    if (existing >= 0) registeredModules[existing] = info
    else registeredModules.push(info)
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

  // Register self
  registerModule({
    name: 'system',
    status: 'healthy',
    subscribes: [],
    publishes: ['system.health']
  })

  return { name: 'system', status, getArchitecture, getHealth, registerModule }
}

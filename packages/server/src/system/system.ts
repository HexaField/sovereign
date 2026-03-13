// System module — architecture and health reporting

import type { EventBus } from '@template/core'

export interface ModuleInfo {
  name: string
  status: string
  subscribes: string[]
  publishes: string[]
}

export interface HealthInfo {
  uptime: number
  connections: { ws: number; agentBackend: boolean }
  jobs: { active: number; lastErrors: string[] }
  disk: { dataDir: string; usedBytes: number }
}

export interface SystemModule {
  name: string
  status(): { healthy: boolean }
  getArchitecture(): { modules: ModuleInfo[] }
  getHealth(): HealthInfo
  registerModule(info: ModuleInfo): void
}

export function createSystemModule(_bus: EventBus, dataDir: string): SystemModule {
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

  const getHealth = (): HealthInfo => ({
    uptime: Date.now() - startTime,
    connections: { ws: 0, agentBackend: false },
    jobs: { active: 0, lastErrors: [] },
    disk: { dataDir, usedBytes: 0 }
  })

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

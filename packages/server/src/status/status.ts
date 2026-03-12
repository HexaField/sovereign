import type { EventBus, ModuleStatus } from '@template/core'
import type { StatusUpdate } from './types.js'

export interface StatusConfig {
  modules: Array<{ name: string; status: () => ModuleStatus }>
  pushToClients?: (update: StatusUpdate) => void
}

export interface StatusAggregator {
  getStatus(): StatusUpdate['payload']
  destroy(): void
}

export const createStatusAggregator = (bus: EventBus, config: StatusConfig): StatusAggregator => {
  let activeJobs = 0
  let unreadNotifications = 0
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const unsubs: Array<() => void> = []

  const getStatus = (): StatusUpdate['payload'] => ({
    connection: 'connected',
    activeJobs,
    unreadNotifications,
    modules: config.modules.map((m) => {
      const s = m.status()
      return { name: s.name, status: s.status }
    })
  })

  const scheduleUpdate = (): void => {
    if (debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      const update: StatusUpdate = { type: 'status.update', payload: getStatus() }
      bus.emit({
        type: 'status.update',
        timestamp: new Date().toISOString(),
        source: 'status',
        payload: update.payload
      })
      config.pushToClients?.(update)
    }, 100)
  }

  unsubs.push(
    bus.on('scheduler.job.started', () => {
      activeJobs++
      scheduleUpdate()
    })
  )

  unsubs.push(
    bus.on('scheduler.job.completed', () => {
      activeJobs = Math.max(0, activeJobs - 1)
      scheduleUpdate()
    })
  )

  unsubs.push(
    bus.on('scheduler.job.failed', () => {
      activeJobs = Math.max(0, activeJobs - 1)
      scheduleUpdate()
    })
  )

  unsubs.push(
    bus.on('notification.created', () => {
      unreadNotifications++
      scheduleUpdate()
    })
  )

  unsubs.push(
    bus.on('notification.read', () => {
      unreadNotifications = Math.max(0, unreadNotifications - 1)
      scheduleUpdate()
    })
  )

  const destroy = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    unsubs.forEach((u) => u())
  }

  return { getStatus, destroy }
}

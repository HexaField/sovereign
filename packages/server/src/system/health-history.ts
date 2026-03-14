// Health history — collects periodic snapshots and serves them via REST

import os from 'node:os'

export interface HealthSnapshot {
  timestamp: number
  cpu: number // 0-100 percentage
  memory: number // 0-100 percentage
  disk: number // 0-100 percentage (placeholder)
  loadAvg: number
  uptimeSec: number
}

export interface HealthHistory {
  getSnapshots(windowMs?: number): HealthSnapshot[]
  dispose(): void
}

const DEFAULT_INTERVAL_MS = 30_000
const MAX_SNAPSHOTS = 7200 // 1 hour at 30s = 120, keep up to ~60h for 7d view

function getCpuPercent(): number {
  const cpus = os.cpus()
  if (!cpus.length) return 0
  let totalIdle = 0
  let totalTick = 0
  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times
    totalTick += user + nice + sys + idle + irq
    totalIdle += idle
  }
  return Math.round(((totalTick - totalIdle) / totalTick) * 100)
}

function getMemoryPercent(): number {
  const total = os.totalmem()
  const free = os.freemem()
  if (total === 0) return 0
  return Math.round(((total - free) / total) * 100)
}

export function createHealthHistory(intervalMs = DEFAULT_INTERVAL_MS): HealthHistory {
  const snapshots: HealthSnapshot[] = []

  function takeSnapshot(): void {
    const snap: HealthSnapshot = {
      timestamp: Date.now(),
      cpu: getCpuPercent(),
      memory: getMemoryPercent(),
      disk: 0, // placeholder — real disk check is expensive
      loadAvg: Math.round(os.loadavg()[0] * 100) / 100,
      uptimeSec: Math.floor(os.uptime())
    }
    snapshots.push(snap)
    if (snapshots.length > MAX_SNAPSHOTS) {
      snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS)
    }
  }

  // Take initial snapshot immediately
  takeSnapshot()
  const timer = setInterval(takeSnapshot, intervalMs)

  return {
    getSnapshots(windowMs = 3600_000): HealthSnapshot[] {
      const cutoff = Date.now() - windowMs
      return snapshots.filter((s) => s.timestamp >= cutoff)
    },
    dispose(): void {
      clearInterval(timer)
    }
  }
}

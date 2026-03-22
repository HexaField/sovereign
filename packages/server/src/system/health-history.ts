// Health history — collects periodic snapshots and serves them via REST

import os from 'node:os'
import { execSync } from 'node:child_process'

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

// Cached disk usage — expires after 60s
let cachedDisk = 0
let diskCacheTime = 0
const DISK_CACHE_MS = 60_000

function getDiskPercent(): number {
  const now = Date.now()
  if (now - diskCacheTime < DISK_CACHE_MS) return cachedDisk
  try {
    const output = execSync('df -k /', { encoding: 'utf-8', timeout: 5000 })
    const lines = output.trim().split('\n')
    if (lines.length < 2) return cachedDisk
    // df output: Filesystem 1K-blocks Used Available Use% Mounted
    const parts = lines[1].split(/\s+/)
    // Look for the percentage column (contains %)
    const pctCol = parts.find((p) => p.endsWith('%'))
    if (pctCol) {
      cachedDisk = parseInt(pctCol, 10) || 0
    } else if (parts.length >= 4) {
      // Fallback: compute from used/available
      const used = parseInt(parts[2], 10)
      const available = parseInt(parts[3], 10)
      if (used > 0 && available >= 0) {
        cachedDisk = Math.round((used / (used + available)) * 100)
      }
    }
    diskCacheTime = now
  } catch {
    // On error, return last cached value (or 0)
  }
  return cachedDisk
}

export function createHealthHistory(intervalMs = DEFAULT_INTERVAL_MS): HealthHistory {
  const snapshots: HealthSnapshot[] = []

  function takeSnapshot(): void {
    const snap: HealthSnapshot = {
      timestamp: Date.now(),
      cpu: getCpuPercent(),
      memory: getMemoryPercent(),
      disk: getDiskPercent(),
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

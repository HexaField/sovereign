// Local JSON cache + offline queue for issues

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { Issue, QueuedOperation } from './types.js'

export interface IssueCache {
  getCached(orgId: string, projectId: string): Issue[] | undefined
  setCached(orgId: string, projectId: string, issues: Issue[]): void
  isStale(orgId: string, projectId: string, ttlMs?: number): boolean
  clear(): void
  queueWrite(op: Omit<QueuedOperation, 'id' | 'timestamp'>): void
  getQueue(): QueuedOperation[]
  removeFromQueue(id: string): void
}

const DEFAULT_TTL = 5 * 60 * 1000 // 5 minutes

export function createIssueCache(dataDir: string): IssueCache {
  const timestamps = new Map<string, number>()

  function cacheDir(orgId: string, projectId: string): string {
    return path.join(dataDir, 'issues', orgId, projectId)
  }

  function cacheFile(orgId: string, projectId: string): string {
    return path.join(cacheDir(orgId, projectId), 'issues.json')
  }

  function queueFile(): string {
    return path.join(dataDir, 'issues', 'queue.jsonl')
  }

  function cacheKey(orgId: string, projectId: string): string {
    return `${orgId}/${projectId}`
  }

  function atomicWrite(filePath: string, data: string): void {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex')
    fs.writeFileSync(tmp, data, 'utf-8')
    fs.renameSync(tmp, filePath)
  }

  // Load timestamps from disk on init
  function loadTimestamp(orgId: string, projectId: string): number | undefined {
    const key = cacheKey(orgId, projectId)
    if (timestamps.has(key)) return timestamps.get(key)
    const metaFile = path.join(cacheDir(orgId, projectId), 'meta.json')
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      const ts = meta.updatedAt as number
      timestamps.set(key, ts)
      return ts
    } catch {
      return undefined
    }
  }

  return {
    getCached(orgId: string, projectId: string): Issue[] | undefined {
      const file = cacheFile(orgId, projectId)
      try {
        const data = fs.readFileSync(file, 'utf-8')
        loadTimestamp(orgId, projectId)
        return JSON.parse(data) as Issue[]
      } catch {
        return undefined
      }
    },

    setCached(orgId: string, projectId: string, issues: Issue[]): void {
      const file = cacheFile(orgId, projectId)
      atomicWrite(file, JSON.stringify(issues, null, 2))
      const now = Date.now()
      timestamps.set(cacheKey(orgId, projectId), now)
      atomicWrite(path.join(cacheDir(orgId, projectId), 'meta.json'), JSON.stringify({ updatedAt: now }))
    },

    isStale(orgId: string, projectId: string, ttlMs: number = DEFAULT_TTL): boolean {
      const ts = loadTimestamp(orgId, projectId)
      if (ts === undefined) return true
      return Date.now() - ts > ttlMs
    },

    clear(): void {
      timestamps.clear()
      const issuesDir = path.join(dataDir, 'issues')
      try {
        fs.rmSync(issuesDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    },

    queueWrite(op: Omit<QueuedOperation, 'id' | 'timestamp'>): void {
      const entry: QueuedOperation = {
        ...op,
        id: crypto.randomBytes(8).toString('hex'),
        timestamp: new Date().toISOString()
      }
      const file = queueFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8')
    },

    getQueue(): QueuedOperation[] {
      const file = queueFile()
      try {
        const data = fs.readFileSync(file, 'utf-8')
        return data
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as QueuedOperation)
      } catch {
        return []
      }
    },

    removeFromQueue(id: string): void {
      const file = queueFile()
      try {
        const data = fs.readFileSync(file, 'utf-8')
        const lines = data.trim().split('\n').filter(Boolean)
        const remaining = lines.filter((line) => {
          const op = JSON.parse(line) as QueuedOperation
          return op.id !== id
        })
        atomicWrite(file, remaining.length > 0 ? remaining.join('\n') + '\n' : '')
      } catch {
        // Queue file doesn't exist, nothing to remove
      }
    }
  }
}

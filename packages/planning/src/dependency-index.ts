// Planning Module — Dependency Index (Cache)

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { DependencyEdge, IssueSnapshot } from './types.js'

export interface DependencyIndex {
  load(): Promise<void>
  save(): Promise<void>
  getEdges(orgId: string): DependencyEdge[]
  updateIssue(snapshot: IssueSnapshot, edges: DependencyEdge[]): void
  clear(orgId: string): void
}

interface StoredIssue {
  bodyHash: string
  edges: DependencyEdge[]
}

interface StoreFormat {
  version: 1
  lastSynced: string
  issues: Record<string, StoredIssue>
}

function issueKey(snapshot: IssueSnapshot): string {
  return `${snapshot.ref.remote}:${snapshot.ref.orgId}/${snapshot.ref.projectId}#${snapshot.ref.issueId}`
}

function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex')
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function createDependencyIndex(dataDir: string): DependencyIndex {
  // In-memory store keyed by orgId
  const stores = new Map<string, StoreFormat>()

  function filePath(orgId: string): string {
    return path.join(dataDir, 'planning', orgId, 'deps.json')
  }

  function getStore(orgId: string): StoreFormat {
    if (!stores.has(orgId)) {
      stores.set(orgId, { version: 1, lastSynced: new Date().toISOString(), issues: {} })
    }
    return stores.get(orgId)!
  }

  return {
    async load(): Promise<void> {
      // Scan for all org dirs
      const planningDir = path.join(dataDir, 'planning')
      try {
        const orgDirs = fs.readdirSync(planningDir)
        for (const orgId of orgDirs) {
          const fp = filePath(orgId)
          try {
            const data = fs.readFileSync(fp, 'utf-8')
            const parsed = JSON.parse(data) as StoreFormat
            stores.set(orgId, parsed)
          } catch {
            // File doesn't exist or is corrupt — skip
          }
        }
      } catch {
        // planning dir doesn't exist yet
      }
    },

    async save(): Promise<void> {
      for (const [orgId, store] of stores) {
        store.lastSynced = new Date().toISOString()
        atomicWrite(filePath(orgId), JSON.stringify(store, null, 2))
      }
    },

    getEdges(orgId: string): DependencyEdge[] {
      const store = stores.get(orgId)
      if (!store) return []
      const allEdges: DependencyEdge[] = []
      for (const issue of Object.values(store.issues)) {
        allEdges.push(...issue.edges)
      }
      return allEdges
    },

    updateIssue(snapshot: IssueSnapshot, edges: DependencyEdge[]): void {
      const store = getStore(snapshot.ref.orgId)
      const key = issueKey(snapshot)
      store.issues[key] = {
        bodyHash: snapshot.bodyHash,
        edges
      }
    },

    clear(orgId: string): void {
      stores.delete(orgId)
      try {
        fs.unlinkSync(filePath(orgId))
      } catch {
        // ignore
      }
    }
  }
}

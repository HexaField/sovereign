// Planning Module — Dependency Index (Cache)

import type { DependencyEdge, IssueSnapshot } from './types.js'

export interface DependencyIndex {
  load(): Promise<void>
  save(): Promise<void>
  getEdges(orgId: string): DependencyEdge[]
  updateIssue(snapshot: IssueSnapshot, edges: DependencyEdge[]): void
  clear(orgId: string): void
}

export function createDependencyIndex(_dataDir: string): DependencyIndex {
  return {
    async load() {},
    async save() {},
    getEdges(_orgId) {
      return []
    },
    updateIssue(_snapshot, _edges) {},
    clear(_orgId) {}
  }
}

// Planning Module — Planning Service

import type { EventBus } from '@template/core'
import type { PlanningDeps, PlanningService, GraphQueryResult, CriticalPath, EntityRef, CycleError } from './types.js'
import type { Issue } from '../issues/types.js'

export function createPlanningService(_bus: EventBus, _dataDir: string, _deps: PlanningDeps): PlanningService {
  return {
    async getGraph(_orgId, _filter?): Promise<GraphQueryResult> {
      return { nodes: [], edges: [] }
    },
    async getCriticalPath(_orgId, _target?): Promise<CriticalPath> {
      return { path: [], length: 0 }
    },
    async getBlocked(_orgId, _filter?): Promise<EntityRef[]> {
      return []
    },
    async getReady(_orgId, _filter?): Promise<EntityRef[]> {
      return []
    },
    async getParallelSets(_orgId, _filter?): Promise<EntityRef[][]> {
      return []
    },
    async getImpact(_orgId, _ref): Promise<EntityRef[]> {
      return []
    },
    async getCompletion(_orgId, _filter?) {
      return { total: 0, closed: 0, percentage: 0 }
    },
    async createIssue(_orgId, _data): Promise<{ issue: Issue; ref: EntityRef }> {
      throw new Error('Not implemented')
    },
    async decompose(_orgId, _data): Promise<{ issues: Issue[]; graph: GraphQueryResult }> {
      throw new Error('Not implemented')
    },
    async sync(_orgId, _projectId?): Promise<{ parsed: number; edges: number; cycles: CycleError[] }> {
      return { parsed: 0, edges: 0, cycles: [] }
    },
    status() {
      return { module: 'planning', status: 'ok' }
    }
  }
}

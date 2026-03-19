// Planning Module — Types

import type { Issue, IssueTracker } from '../issues/types.js'

export interface EntityRef {
  orgId: string
  projectId: string
  remote: string
  issueId: string
}

export interface DependencyEdge {
  from: EntityRef
  to: EntityRef
  type: 'depends_on' | 'blocks'
  source: 'body' | 'comment'
}

export interface CycleError {
  cycle: EntityRef[]
  message: string
}

export interface GraphNode {
  ref: EntityRef
  source: 'provider' | 'draft'
  state: 'open' | 'closed'
  labels: string[]
  milestone?: string
  assignees: string[]
  dependencies: EntityRef[]
  dependents: EntityRef[]
  draftId?: string
  draftTitle?: string
  title?: string
  kind?: 'issue' | 'pr'
}

export interface GraphQueryResult {
  nodes: GraphNode[]
  edges: DependencyEdge[]
}

export interface CriticalPath {
  path: EntityRef[]
  length: number
}

export interface IssueSnapshot {
  ref: EntityRef
  state: 'open' | 'closed'
  labels: string[]
  milestone?: string
  assignees: string[]
  body: string
  bodyHash: string
  title?: string
  kind?: 'issue' | 'pr'
}

export interface GraphBuildResult {
  graph: GraphEngine
  errors: CycleError[]
}

export interface GraphFilter {
  projectId?: string
  remote?: string
  label?: string
  milestone?: string
  assignee?: string
}

export interface GraphEngine {
  build(issues: IssueSnapshot[], edges: DependencyEdge[]): GraphBuildResult
  update(issueId: EntityRef, newEdges: DependencyEdge[]): void
  topologicalOrder(): EntityRef[]
  criticalPath(target?: EntityRef): CriticalPath
  blocked(): EntityRef[]
  ready(): EntityRef[]
  parallelSets(): EntityRef[][]
  impact(node: EntityRef): EntityRef[]
  ancestors(node: EntityRef): EntityRef[]
  subgraph(filter: GraphFilter): GraphQueryResult
  completionRate(filter?: GraphFilter): { total: number; closed: number; percentage: number }
}

export interface PlanningDeps {
  issueTracker: IssueTracker
  getConfig: () => Record<string, unknown>
  draftStore?: import('../drafts/types.js').DraftStore
  listOrgIds?: () => string[]
}

export interface CreateIssueWithDeps {
  remote: string
  projectId: string
  title: string
  body?: string
  labels?: string[]
  assignees?: string[]
  dependsOn?: EntityRef[]
  blocks?: EntityRef[]
}

export interface DecomposeRequest {
  remote: string
  projectId: string
  issues: CreateIssueWithDeps[]
}

export interface PlanningService {
  getGraph(orgId: string, filter?: GraphFilter): Promise<GraphQueryResult>
  getCriticalPath(orgId: string, target?: EntityRef): Promise<CriticalPath>
  getBlocked(orgId: string, filter?: GraphFilter): Promise<EntityRef[]>
  getReady(orgId: string, filter?: GraphFilter): Promise<EntityRef[]>
  getParallelSets(orgId: string, filter?: GraphFilter): Promise<EntityRef[][]>
  getImpact(orgId: string, ref: EntityRef): Promise<EntityRef[]>
  getCompletion(orgId: string, filter?: GraphFilter): Promise<{ total: number; closed: number; percentage: number }>
  createIssue(orgId: string, data: CreateIssueWithDeps): Promise<{ issue: Issue; ref: EntityRef }>
  decompose(orgId: string, data: DecomposeRequest): Promise<{ issues: Issue[]; graph: GraphQueryResult }>
  sync(orgId: string, projectId?: string): Promise<{ parsed: number; edges: number; cycles: CycleError[] }>
  status(): { module: string; status: string }
  /** Get unified graph across all orgs */
  getCrossOrgGraph?(filter?: GraphFilter): Promise<GraphQueryResult & { crossWorkspaceEdges: DependencyEdge[] }>
  /** Get critical path across all orgs */
  getCrossOrgCriticalPath?(target?: EntityRef): Promise<CriticalPath>
}

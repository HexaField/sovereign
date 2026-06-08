export interface EntityRef {
  orgId: string
  projectId: string
  remote: string
  issueId: string
}

export interface ServerGraphNode {
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

export interface ServerEdge {
  from: EntityRef
  to: EntityRef
  type: string
  source: string
}

export interface ServerGraphResponse {
  nodes: ServerGraphNode[]
  edges: ServerEdge[]
  crossWorkspaceEdges?: ServerEdge[]
}

export interface PlanningNode {
  id: string
  title: string
  body?: string
  workspace: string
  workspaceName: string
  project: string
  projectName: string
  status: 'open' | 'in-progress' | 'review' | 'done' | 'blocked'
  assignee?: string
  labels: string[]
  priority: 'low' | 'medium' | 'high' | 'critical'
  dependencies: string[]
  isCriticalPath: boolean
  depth: number
  isDraft: boolean
  kind?: 'issue' | 'pr'
  ref: EntityRef
  providerUrl?: string
}

export interface PlanningEdge {
  from: string
  to: string
  crossWorkspace: boolean
}

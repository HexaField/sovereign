import type { PlanningNode, ServerGraphNode, EntityRef } from './planning-types.js'

export function refToId(ref: EntityRef): string {
  return `${ref.remote}:${ref.orgId}/${ref.projectId}#${ref.issueId}`
}

export function deriveStatus(node: ServerGraphNode, nodeMap: Map<string, ServerGraphNode>): PlanningNode['status'] {
  if (node.state === 'closed') return 'done'
  const hasOpenDep = node.dependencies.some((dep) => {
    const depNode = nodeMap.get(refToId(dep))
    return depNode && depNode.state === 'open'
  })
  if (hasOpenDep) return 'blocked'
  if (node.assignees.length > 0) return 'in-progress'
  return 'open'
}

export function derivePriority(node: ServerGraphNode): PlanningNode['priority'] {
  const labels = node.labels.map((l) => l.toLowerCase())
  if (labels.some((l) => l.includes('critical') || l.includes('p0'))) return 'critical'
  if (labels.some((l) => l.includes('high') || l.includes('p1') || l.includes('urgent'))) return 'high'
  if (labels.some((l) => l.includes('low') || l.includes('p3'))) return 'low'
  return 'medium'
}

export function computeDepths(nodes: ServerGraphNode[]): Map<string, number> {
  const depths = new Map<string, number>()
  const nodeMap = new Map<string, ServerGraphNode>()
  for (const n of nodes) nodeMap.set(refToId(n.ref), n)

  const inDegree = new Map<string, number>()
  for (const n of nodes) {
    const id = refToId(n.ref)
    inDegree.set(id, n.dependencies.filter((d) => nodeMap.has(refToId(d))).length)
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  while (queue.length > 0) {
    const id = queue.shift()!
    const node = nodeMap.get(id)!
    const myDepth = node.dependencies
      .map((d) => depths.get(refToId(d)) ?? 0)
      .reduce((max, d) => Math.max(max, d + 1), 0)
    depths.set(id, myDepth)

    for (const dep of node.dependents) {
      const depId = refToId(dep)
      const newDeg = (inDegree.get(depId) ?? 1) - 1
      inDegree.set(depId, newDeg)
      if (newDeg === 0) queue.push(depId)
    }
  }

  for (const n of nodes) {
    const id = refToId(n.ref)
    if (!depths.has(id)) depths.set(id, 0)
  }

  return depths
}

export function getStatusColor(status: PlanningNode['status']): string {
  switch (status) {
    case 'blocked':
      return 'var(--c-error, #ef4444)'
    case 'open':
      return 'var(--c-success, #22c55e)'
    case 'in-progress':
      return 'var(--c-warning, #f59e0b)'
    case 'review':
      return 'var(--c-accent, #89b4fa)'
    case 'done':
      return 'var(--c-text-muted, #a6adc8)'
  }
}

export function getStatusLabel(status: PlanningNode['status']): string {
  switch (status) {
    case 'blocked':
      return 'Blocked'
    case 'open':
      return 'Ready'
    case 'in-progress':
      return 'In Progress'
    case 'review':
      return 'Review'
    case 'done':
      return 'Done'
  }
}

/** @deprecated Use PriorityIcon component instead */
export function getPriorityIcon(priority: PlanningNode['priority']): string {
  switch (priority) {
    case 'critical':
      return 'crit'
    case 'high':
      return 'high'
    case 'medium':
      return 'med'
    case 'low':
      return 'low'
  }
}

export const WORKSPACE_COLORS = [
  '#89b4fa',
  '#f38ba8',
  '#a6e3a1',
  '#fab387',
  '#cba6f7',
  '#94e2d5',
  '#f9e2af',
  '#eba0ac',
  '#74c7ec',
  '#b4befe'
]

export function getWorkspaceColor(workspace: string, allWorkspaces: string[]): string {
  const idx = allWorkspaces.indexOf(workspace)
  return WORKSPACE_COLORS[idx % WORKSPACE_COLORS.length]!
}

export const FILTER_KEYS = ['workspace', 'project', 'status', 'assignee', 'label', 'priority'] as const

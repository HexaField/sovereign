// Planning Module — Planning Service

import * as crypto from 'node:crypto'
import type { EventBus } from '@sovereign/core'
import type {
  PlanningDeps,
  PlanningService,
  EntityRef,
  CycleError,
  GraphFilter,
  IssueSnapshot,
  DependencyEdge
} from './types.js'
import type { Issue } from '../issues/types.js'
import { createGraph } from './graph.js'
import { parseDependencies } from './parser.js'
import { createDependencyIndex } from './index.js'

function hashBody(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)
}

function issueToSnapshot(issue: Issue): IssueSnapshot {
  return {
    ref: {
      orgId: issue.orgId,
      projectId: issue.projectId,
      remote: issue.remote,
      issueId: issue.id
    },
    state: issue.state,
    labels: issue.labels,
    milestone: undefined,
    assignees: issue.assignees,
    body: issue.body,
    bodyHash: hashBody(issue.body),
    title: issue.title,
    kind: issue.kind
  }
}

function formatRefString(ref: EntityRef): string {
  // Use org/project#id for cross-repo refs, #id for bare refs
  return `${ref.orgId}/${ref.projectId}#${ref.issueId}`
}

function formatDepsInBody(body: string | undefined, dependsOn?: EntityRef[], blocks?: EntityRef[]): string {
  const lines: string[] = body ? [body] : []
  if (dependsOn?.length) {
    lines.push('')
    for (const dep of dependsOn) {
      lines.push(`depends on ${formatRefString(dep)}`)
    }
  }
  if (blocks?.length) {
    lines.push('')
    for (const b of blocks) {
      lines.push(`blocks ${formatRefString(b)}`)
    }
  }
  return lines.join('\n')
}

export function createPlanningService(bus: EventBus, dataDir: string, deps: PlanningDeps): PlanningService {
  const index = createDependencyIndex(dataDir)

  // Load index on creation (async, but we don't await — first query will work with whatever is loaded)
  const ready = index.load()

  async function buildGraph(orgId: string, filter?: GraphFilter) {
    await ready
    const issues = await deps.issueTracker.list(
      orgId,
      filter
        ? {
            projectId: filter.projectId,
            label: filter.label,
            assignee: filter.assignee
          }
        : undefined
    )

    const snapshots: IssueSnapshot[] = issues.map(issueToSnapshot)
    const allEdges: DependencyEdge[] = []

    // Inject drafts into the graph
    if (deps.draftStore) {
      const drafts = deps.draftStore.list() // all non-published drafts
      for (const draft of drafts) {
        // Include if orgId matches or draft is unassigned
        if (draft.orgId !== null && draft.orgId !== orgId) continue
        const syntheticRef: EntityRef = {
          orgId: '_drafts',
          projectId: '_local',
          remote: '_local',
          issueId: draft.id
        }
        const snap: IssueSnapshot & { source: string; draftId: string; draftTitle: string } = {
          ref: syntheticRef,
          state: 'open',
          labels: draft.labels,
          milestone: undefined,
          assignees: draft.assignees,
          body: draft.body,
          bodyHash: hashBody(draft.body),
          source: 'draft',
          draftId: draft.id,
          draftTitle: draft.title
        }
        snapshots.push(snap)

        // Resolve draft dependencies to edges
        for (const dep of draft.dependencies) {
          let toRef: EntityRef
          if (dep.target.kind === 'draft') {
            toRef = { orgId: '_drafts', projectId: '_local', remote: '_local', issueId: dep.target.draftId }
          } else {
            toRef = dep.target.ref
          }
          if (dep.type === 'depends_on') {
            allEdges.push({ from: syntheticRef, to: toRef, type: 'depends_on', source: 'body' })
          } else {
            allEdges.push({ from: toRef, to: syntheticRef, type: 'blocks', source: 'body' })
          }
        }
      }
    }

    for (const snap of snapshots) {
      const edges = parseDependencies(snap.body, {
        orgId: snap.ref.orgId,
        projectId: snap.ref.projectId,
        remote: snap.ref.remote
      })
      // Fix up the "from" ref to include the actual issue ID
      const fixedEdges = edges.map((e) => ({
        ...e,
        from: e.from.issueId === '0' ? { ...e.from, issueId: snap.ref.issueId } : e.from,
        to: e.to.issueId === '0' ? { ...e.to, issueId: snap.ref.issueId } : e.to
      }))
      allEdges.push(...fixedEdges)
    }

    const result = createGraph(snapshots, allEdges)
    return result
  }

  async function updateFromIssue(issue: Issue) {
    await ready
    const snapshot = issueToSnapshot(issue)
    const edges = parseDependencies(snapshot.body, {
      orgId: snapshot.ref.orgId,
      projectId: snapshot.ref.projectId,
      remote: snapshot.ref.remote
    }).map((e) => ({
      ...e,
      from: e.from.issueId === '0' ? { ...e.from, issueId: snapshot.ref.issueId } : e.from,
      to: e.to.issueId === '0' ? { ...e.to, issueId: snapshot.ref.issueId } : e.to
    }))
    index.updateIssue(snapshot, edges)
    await index.save()

    bus.emit({
      type: 'planning.graph.updated',
      timestamp: new Date().toISOString(),
      source: 'planning',
      payload: { orgId: issue.orgId }
    })
  }

  // Listen for bus events
  bus.on('issue.created', async (event) => {
    const issue = event.payload as Issue
    if (issue) await updateFromIssue(issue)
  })

  bus.on('issue.updated', async (event) => {
    const issue = event.payload as Issue
    if (issue) await updateFromIssue(issue)
  })

  bus.on('issue.synced', async (event) => {
    const payload = event.payload as { orgId: string }
    if (payload?.orgId) {
      bus.emit({
        type: 'planning.graph.updated',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId: payload.orgId }
      })
    }
  })

  const service: PlanningService = {
    async getGraph(orgId, filter?) {
      const { graph } = await buildGraph(orgId, filter)
      if (filter) {
        return graph.subgraph(filter)
      }
      return graph.subgraph({}) // return all
    },

    async getCriticalPath(orgId, target?) {
      const { graph } = await buildGraph(orgId)
      return graph.criticalPath(target)
    },

    async getBlocked(orgId, filter?) {
      const { graph } = await buildGraph(orgId, filter)
      return graph.blocked()
    },

    async getReady(orgId, filter?) {
      const { graph } = await buildGraph(orgId, filter)
      return graph.ready()
    },

    async getParallelSets(orgId, filter?) {
      const { graph } = await buildGraph(orgId, filter)
      return graph.parallelSets()
    },

    async getImpact(orgId, ref) {
      const { graph } = await buildGraph(orgId)
      return graph.impact(ref)
    },

    async getCompletion(orgId, filter?) {
      const { graph } = await buildGraph(orgId, filter)
      return graph.completionRate(filter)
    },

    async createIssue(orgId, data) {
      const body = formatDepsInBody(data.body, data.dependsOn, data.blocks)
      const issue = await deps.issueTracker.create(orgId, data.projectId, {
        remote: data.remote,
        title: data.title,
        body,
        labels: data.labels,
        assignees: data.assignees
      })

      const ref: EntityRef = {
        orgId,
        projectId: data.projectId,
        remote: data.remote,
        issueId: issue.id
      }

      bus.emit({
        type: 'planning.graph.updated',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId }
      })

      return { issue, ref }
    },

    async decompose(orgId, data) {
      const issues: Issue[] = []

      for (const item of data.issues) {
        const body = formatDepsInBody(item.body, item.dependsOn, item.blocks)
        const issue = await deps.issueTracker.create(orgId, data.projectId, {
          remote: data.remote,
          title: item.title,
          body,
          labels: item.labels,
          assignees: item.assignees
        })
        issues.push(issue)
      }

      // Build graph from the created issues
      const snapshots = issues.map(issueToSnapshot)
      const allEdges: DependencyEdge[] = []
      for (const snap of snapshots) {
        const edges = parseDependencies(snap.body, {
          orgId: snap.ref.orgId,
          projectId: snap.ref.projectId,
          remote: snap.ref.remote
        }).map((e) => ({
          ...e,
          from: e.from.issueId === '0' ? { ...e.from, issueId: snap.ref.issueId } : e.from,
          to: e.to.issueId === '0' ? { ...e.to, issueId: snap.ref.issueId } : e.to
        }))
        allEdges.push(...edges)
      }

      const { graph } = createGraph(snapshots, allEdges)
      const graphResult = graph.subgraph({})

      bus.emit({
        type: 'planning.graph.updated',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId }
      })

      return { issues, graph: graphResult }
    },

    async sync(orgId, projectId?) {
      await ready
      const issues = await deps.issueTracker.list(orgId, projectId ? { projectId } : undefined)
      const snapshots = issues.map(issueToSnapshot)

      let parsed = 0
      let edgeCount = 0
      const allCycles: CycleError[] = []

      for (const snap of snapshots) {
        const edges = parseDependencies(snap.body, {
          orgId: snap.ref.orgId,
          projectId: snap.ref.projectId,
          remote: snap.ref.remote
        }).map((e) => ({
          ...e,
          from: e.from.issueId === '0' ? { ...e.from, issueId: snap.ref.issueId } : e.from,
          to: e.to.issueId === '0' ? { ...e.to, issueId: snap.ref.issueId } : e.to
        }))
        index.updateIssue(snap, edges)
        parsed++
        edgeCount += edges.length
      }

      await index.save()

      // Check for cycles
      const allEdges = index.getEdges(orgId)
      const { errors } = createGraph(snapshots, allEdges)
      allCycles.push(...errors)

      if (allCycles.length > 0) {
        bus.emit({
          type: 'planning.cycle.detected',
          timestamp: new Date().toISOString(),
          source: 'planning',
          payload: { orgId, cycles: allCycles }
        })
      }

      bus.emit({
        type: 'planning.sync.completed',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId, parsed, edges: edgeCount, cycles: allCycles.length }
      })

      return { parsed, edges: edgeCount, cycles: allCycles }
    },

    async addDependency(orgId, from, to, type) {
      // Get the source issue and append a dependency line to its body
      const issue = await deps.issueTracker.get(orgId, from.projectId, from.issueId)
      if (!issue) throw new Error(`Issue not found: ${from.projectId}#${from.issueId}`)

      const depLine = type === 'depends_on' ? `depends on ${formatRefString(to)}` : `blocks ${formatRefString(to)}`

      const newBody = issue.body ? `${issue.body}\n${depLine}` : depLine
      await deps.issueTracker.update(orgId, from.projectId, from.issueId, { body: newBody })

      bus.emit({
        type: 'planning.graph.updated',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId }
      })
    },

    async removeDependency(orgId, from, to) {
      // Get the source issue and remove dependency lines referencing `to`
      const issue = await deps.issueTracker.get(orgId, from.projectId, from.issueId)
      if (!issue) throw new Error(`Issue not found: ${from.projectId}#${from.issueId}`)

      const toStr = formatRefString(to)
      const bareRef = `#${to.issueId}`
      const lines = issue.body.split('\n')
      const filtered = lines.filter((line) => {
        const trimmed = line.trim().toLowerCase()
        const refLower = toStr.toLowerCase()
        // Remove lines like "depends on org/project#id" or "blocks org/project#id" or bare #id refs
        if (trimmed === `depends on ${refLower}` || trimmed === `blocked by ${refLower}`) return false
        if (trimmed === `blocks ${refLower}`) return false
        if (trimmed === `depends on ${bareRef}` || trimmed === `blocked by ${bareRef}`) return false
        if (trimmed === `blocks ${bareRef}`) return false
        return true
      })

      const newBody = filtered
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      await deps.issueTracker.update(orgId, from.projectId, from.issueId, { body: newBody })

      // Also check the reverse: if `to` issue has a "blocks from" line, remove it
      try {
        const toIssue = await deps.issueTracker.get(orgId, to.projectId, to.issueId)
        if (toIssue) {
          const fromStr = formatRefString(from).toLowerCase()
          const fromBare = `#${from.issueId}`
          const toLines = toIssue.body.split('\n')
          const toFiltered = toLines.filter((line) => {
            const trimmed = line.trim().toLowerCase()
            if (trimmed === `blocks ${fromStr}` || trimmed === `blocks ${fromBare}`) return false
            if (trimmed === `depends on ${fromStr}` || trimmed === `blocked by ${fromStr}`) return false
            if (trimmed === `depends on ${fromBare}` || trimmed === `blocked by ${fromBare}`) return false
            return true
          })
          if (toFiltered.length !== toLines.length) {
            const newToBody = toFiltered
              .join('\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim()
            await deps.issueTracker.update(orgId, to.projectId, to.issueId, { body: newToBody })
          }
        }
      } catch {
        /* best effort */
      }

      bus.emit({
        type: 'planning.graph.updated',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId }
      })
    },

    status() {
      return { module: 'planning', status: 'ok' }
    },

    async getCrossOrgGraph(filter?) {
      const orgIds = deps.listOrgIds?.() ?? []
      const allNodes: import('./types.js').GraphNode[] = []
      const allEdges: DependencyEdge[] = []
      const seenKeys = new Set<string>()

      for (const orgId of orgIds) {
        try {
          const graph = await service.getGraph(orgId, filter)
          for (const node of graph.nodes) {
            const key = `${node.ref.remote}:${node.ref.orgId}/${node.ref.projectId}#${node.ref.issueId}`
            if (!seenKeys.has(key)) {
              seenKeys.add(key)
              allNodes.push(node)
            }
          }
          allEdges.push(...graph.edges)
        } catch {
          /* skip failing orgs */
        }
      }

      // Detect cross-workspace edges
      const crossWorkspaceEdges = allEdges.filter((e) => e.from.orgId !== e.to.orgId)

      // Deduplicate edges
      const edgeKeys = new Set<string>()
      const dedupedEdges = allEdges.filter((e) => {
        const key = `${e.from.orgId}/${e.from.projectId}#${e.from.issueId}->${e.to.orgId}/${e.to.projectId}#${e.to.issueId}`
        if (edgeKeys.has(key)) return false
        edgeKeys.add(key)
        return true
      })

      return { nodes: allNodes, edges: dedupedEdges, crossWorkspaceEdges }
    },

    async getCrossOrgCriticalPath(target?) {
      // Build unified graph across all orgs
      const { nodes, edges } = await service.getCrossOrgGraph!()
      const snapshots: IssueSnapshot[] = nodes.map(
        (n) =>
          ({
            ref: n.ref,
            state: n.state,
            labels: n.labels,
            milestone: n.milestone,
            assignees: n.assignees,
            body: '',
            bodyHash: '',
            title: n.title,
            kind: n.kind,
            source: n.source,
            draftId: n.draftId,
            draftTitle: n.draftTitle
          }) as any
      )
      const { graph } = createGraph(snapshots, edges)
      return graph.criticalPath(target)
    }
  }

  return service
}

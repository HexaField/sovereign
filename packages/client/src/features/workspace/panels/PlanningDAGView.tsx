import { Component, createResource, createSignal, createMemo, Show, For, onCleanup, createEffect } from 'solid-js'
import { closePlanningView, openIssueDetail } from '../store.js'

interface EntityRef {
  orgId: string
  projectId: string
  remote: string
  issueId: string
}

interface GraphNode {
  ref: EntityRef
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  dependencies: EntityRef[]
  dependents: EntityRef[]
}

interface DependencyEdge {
  from: EntityRef
  to: EntityRef
  type: 'depends_on' | 'blocks'
}

interface GraphData {
  nodes: GraphNode[]
  edges: DependencyEdge[]
}

interface IssueInfo {
  id: string
  projectId: string
  orgId: string
  remote: string
  title: string
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
}

export interface PlanningDAGViewProps {
  orgId: string
}

export function buildGraphUrl(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/planning/graph`
}

function refKey(r: EntityRef): string {
  return `${r.orgId}:${r.projectId}:${r.remote}:${r.issueId}`
}

const NODE_WIDTH = 220
const NODE_HEIGHT = 60
const H_GAP = 80
const V_GAP = 30

export function layoutGraph(
  graph: GraphData,
  issueMap: Map<string, IssueInfo>,
  blockedSet: Set<string>,
  readySet: Set<string>
): {
  positions: Map<string, { x: number; y: number }>
  width: number
  height: number
} {
  const positions = new Map<string, { x: number; y: number }>()
  const inDegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  const nodeKeys = new Set<string>()

  for (const node of graph.nodes) {
    const key = refKey(node.ref)
    nodeKeys.add(key)
    inDegree.set(key, 0)
    children.set(key, [])
  }

  for (const edge of graph.edges) {
    const fromKey = refKey(edge.from)
    const toKey = refKey(edge.to)
    if (!nodeKeys.has(fromKey) || !nodeKeys.has(toKey)) continue
    inDegree.set(toKey, (inDegree.get(toKey) ?? 0) + 1)
    children.get(fromKey)?.push(toKey)
  }

  // Topological sort into layers
  const layers: string[][] = []
  const queue = [...nodeKeys].filter((k) => (inDegree.get(k) ?? 0) === 0)
  const visited = new Set<string>()

  while (queue.length > 0) {
    const layer = [...queue]
    layers.push(layer)
    queue.length = 0
    for (const id of layer) {
      visited.add(id)
      for (const child of children.get(id) ?? []) {
        const deg = (inDegree.get(child) ?? 1) - 1
        inDegree.set(child, deg)
        if (deg === 0 && !visited.has(child)) queue.push(child)
      }
    }
  }

  // Add unvisited nodes (cycles) as final layer
  const unvisited = [...nodeKeys].filter((k) => !visited.has(k))
  if (unvisited.length > 0) layers.push(unvisited)

  let maxWidth = 0
  let maxHeight = 0
  const PADDING = 40

  for (let col = 0; col < layers.length; col++) {
    const layer = layers[col]
    for (let row = 0; row < layer.length; row++) {
      const x = PADDING + col * (NODE_WIDTH + H_GAP)
      const y = PADDING + row * (NODE_HEIGHT + V_GAP)
      positions.set(layer[row], { x, y })
      maxWidth = Math.max(maxWidth, x + NODE_WIDTH + PADDING)
      maxHeight = Math.max(maxHeight, y + NODE_HEIGHT + PADDING)
    }
  }

  return { positions, width: maxWidth, height: maxHeight }
}

function nodeColor(key: string, state: string, blockedSet: Set<string>, readySet: Set<string>): string {
  if (state === 'closed') return 'var(--c-text-muted, #6b7280)'
  if (blockedSet.has(key)) return 'var(--c-error, #ef4444)'
  if (readySet.has(key)) return 'var(--c-success, #22c55e)'
  return 'var(--c-warning, #f59e0b)'
}

async function fetchGraphData(orgId: string): Promise<{
  graph: GraphData
  issues: IssueInfo[]
  blocked: EntityRef[]
  ready: EntityRef[]
  projects: Array<{ id: string; name: string }>
}> {
  const [graphRes, issuesRes, blockedRes, readyRes, projectsRes] = await Promise.all([
    fetch(buildGraphUrl(orgId)),
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/issues`),
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/planning/blocked`),
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/planning/ready`),
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/projects`)
  ])

  const graph = graphRes.ok ? await graphRes.json() : { nodes: [], edges: [] }
  const issues = issuesRes.ok ? await issuesRes.json() : []
  const blocked = blockedRes.ok ? await blockedRes.json() : []
  const ready = readyRes.ok ? await readyRes.json() : []
  const projects = projectsRes.ok ? await projectsRes.json() : []

  return { graph, issues, blocked, ready, projects }
}

const PlanningDAGView: Component<PlanningDAGViewProps> = (props) => {
  const [data] = createResource(() => props.orgId, fetchGraphData)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  const [zoom, setZoom] = createSignal(1)
  const [dragging, setDragging] = createSignal(false)
  const [dragStart, setDragStart] = createSignal({ x: 0, y: 0 })
  const [filterProject, setFilterProject] = createSignal<string>('')
  const [filterLabel, setFilterLabel] = createSignal<string>('')

  const issueMap = createMemo(() => {
    const map = new Map<string, IssueInfo>()
    if (!data()) return map
    for (const issue of data()!.issues) {
      const key = refKey({ orgId: issue.orgId, projectId: issue.projectId, remote: issue.remote, issueId: issue.id })
      map.set(key, issue)
    }
    return map
  })

  const blockedSet = createMemo(() => new Set((data()?.blocked ?? []).map(refKey)))
  const readySet = createMemo(() => new Set((data()?.ready ?? []).map(refKey)))

  const filteredGraph = createMemo(() => {
    const d = data()
    if (!d) return { nodes: [], edges: [] }
    let nodes = d.graph.nodes
    const fp = filterProject()
    const fl = filterLabel()
    if (fp) nodes = nodes.filter((n) => n.ref.projectId === fp)
    if (fl) nodes = nodes.filter((n) => n.labels.includes(fl))
    const nodeKeys = new Set(nodes.map((n) => refKey(n.ref)))
    const edges = d.graph.edges.filter((e) => nodeKeys.has(refKey(e.from)) && nodeKeys.has(refKey(e.to)))
    return { nodes, edges }
  })

  const layout = createMemo(() => layoutGraph(filteredGraph(), issueMap(), blockedSet(), readySet()))

  const projects = createMemo(() => {
    const d = data()
    if (!d) return [] as Array<{ id: string; name: string }>
    // Only include projects that have graph nodes
    const nodeProjectIds = new Set<string>()
    for (const n of d.graph.nodes) nodeProjectIds.add(n.ref.projectId)
    return d.projects.filter((p: { id: string; name: string }) => nodeProjectIds.has(p.id))
  })

  const labels = createMemo(() => {
    const d = data()
    if (!d) return []
    const set = new Set<string>()
    for (const n of d.graph.nodes) for (const l of n.labels) set.add(l)
    return [...set].sort()
  })

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setZoom((z) => Math.max(0.2, Math.min(3, z + delta)))
  }

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      setDragging(true)
      setDragStart({ x: e.clientX - pan().x, y: e.clientY - pan().y })
    }
  }

  const handleMouseMove = (e: MouseEvent) => {
    if (dragging()) {
      setPan({ x: e.clientX - dragStart().x, y: e.clientY - dragStart().y })
    }
  }

  const handleMouseUp = () => setDragging(false)

  return (
    <div class="flex h-full flex-col overflow-hidden" style={{ background: 'var(--c-bg)' }}>
      {/* Header */}
      <div
        class="flex shrink-0 items-center justify-between border-b px-3 py-1.5"
        style={{ 'border-color': 'var(--c-border)' }}
      >
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium" style={{ color: 'var(--c-text-heading)' }}>
            Planning DAG
          </span>
          {/* Filters */}
          <Show when={projects().length > 1}>
            <select
              class="rounded border px-1.5 py-0.5 text-xs"
              style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
              value={filterProject()}
              onChange={(e) => setFilterProject(e.currentTarget.value)}
            >
              <option value="">All projects</option>
              <For each={projects()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
            </select>
          </Show>
          <Show when={labels().length > 0}>
            <select
              class="rounded border px-1.5 py-0.5 text-xs"
              style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
              value={filterLabel()}
              onChange={(e) => setFilterLabel(e.currentTarget.value)}
            >
              <option value="">All labels</option>
              <For each={labels()}>{(l) => <option value={l}>{l}</option>}</For>
            </select>
          </Show>
        </div>
        <button
          class="text-lg leading-none hover:opacity-80"
          style={{ color: 'var(--c-text-muted)' }}
          onClick={() => closePlanningView()}
          aria-label="Close"
        >
          x
        </button>
      </div>

      {/* Canvas */}
      <div class="flex-1 overflow-hidden">
        <Show when={data.loading}>
          <p class="p-4 text-sm" style={{ color: 'var(--c-text-muted)' }}>
            Loading...
          </p>
        </Show>
        <Show when={data.error}>
          <p class="p-4 text-sm" style={{ color: 'var(--c-error)' }}>
            Error: {(data.error as Error).message}
          </p>
        </Show>
        <Show when={data() && !data.loading}>
          <svg
            class="h-full w-full cursor-grab"
            classList={{ 'cursor-grabbing': dragging() }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <defs>
              <marker id="dag-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="var(--c-border)" />
              </marker>
            </defs>
            <g transform={`translate(${pan().x},${pan().y}) scale(${zoom()})`}>
              {/* Edges */}
              <For each={filteredGraph().edges}>
                {(edge) => {
                  const fromKey = refKey(edge.from)
                  const toKey = refKey(edge.to)
                  const fromPos = layout().positions.get(fromKey)
                  const toPos = layout().positions.get(toKey)
                  if (!fromPos || !toPos) return null
                  return (
                    <line
                      x1={fromPos.x + NODE_WIDTH}
                      y1={fromPos.y + NODE_HEIGHT / 2}
                      x2={toPos.x}
                      y2={toPos.y + NODE_HEIGHT / 2}
                      stroke="var(--c-border)"
                      stroke-width="1.5"
                      marker-end="url(#dag-arrow)"
                    />
                  )
                }}
              </For>

              {/* Nodes */}
              <For each={filteredGraph().nodes}>
                {(node) => {
                  const key = refKey(node.ref)
                  const pos = layout().positions.get(key)
                  if (!pos) return null
                  const issue = issueMap().get(key)
                  const title = issue?.title ?? node.ref.issueId
                  const color = nodeColor(key, node.state, blockedSet(), readySet())

                  return (
                    <g
                      transform={`translate(${pos.x},${pos.y})`}
                      class="cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation()
                        openIssueDetail(node.ref.orgId, node.ref.projectId, node.ref.issueId)
                      }}
                    >
                      <rect
                        width={NODE_WIDTH}
                        height={NODE_HEIGHT}
                        rx="6"
                        fill="var(--c-bg-secondary)"
                        stroke={color}
                        stroke-width="2"
                      />
                      {/* Status dot */}
                      <circle cx="14" cy={NODE_HEIGHT / 2} r="5" fill={color} />
                      {/* Title */}
                      <text x="28" y="24" font-size="11" fill="var(--c-text)" font-family="sans-serif">
                        {title.length > 26 ? title.slice(0, 26) + '...' : title}
                      </text>
                      {/* Labels preview */}
                      <text x="28" y="44" font-size="9" fill="var(--c-text-muted)" font-family="sans-serif">
                        {node.labels.slice(0, 3).join(', ')}
                      </text>
                    </g>
                  )
                }}
              </For>
            </g>
          </svg>
        </Show>
      </div>
    </div>
  )
}

export default PlanningDAGView

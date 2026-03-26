import { Component, createResource, createSignal, createMemo, Show, For, onCleanup, createEffect } from 'solid-js'
import { closePlanningView, openIssueDetail } from '../store.js'
import { draftsStore } from '../../drafts/index.js'

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

function refLabel(r: EntityRef): string {
  return `${r.projectId}#${r.issueId}`
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

const DRAWER_WIDTH = 320

const PlanningDAGView: Component<PlanningDAGViewProps> = (props) => {
  const [data, { refetch }] = createResource(() => props.orgId, fetchGraphData)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  const [zoom, setZoom] = createSignal(1)
  const [dragging, setDragging] = createSignal(false)
  const [dragStart, setDragStart] = createSignal({ x: 0, y: 0 })
  const [filterProject, setFilterProject] = createSignal<string>('')
  const [filterLabel, setFilterLabel] = createSignal<string>('')
  const [selectedNodeKey, setSelectedNodeKey] = createSignal<string | null>(null)
  const [mouseDownPos, setMouseDownPos] = createSignal<{ x: number; y: number } | null>(null)
  const [showAddUpstream, setShowAddUpstream] = createSignal(false)
  const [showAddDownstream, setShowAddDownstream] = createSignal(false)
  const [depLoading, setDepLoading] = createSignal(false)

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

  const selectedNode = createMemo(() => {
    const key = selectedNodeKey()
    if (!key) return null
    return filteredGraph().nodes.find((n) => refKey(n.ref) === key) ?? null
  })

  const selectedIssue = createMemo(() => {
    const key = selectedNodeKey()
    if (!key) return null
    return issueMap().get(key) ?? null
  })

  const drawerOpen = createMemo(() => selectedNode() !== null)

  // Build node-key-to-title map for dependency display
  const nodeTitleMap = createMemo(() => {
    const map = new Map<string, string>()
    for (const node of filteredGraph().nodes) {
      const key = refKey(node.ref)
      const issue = issueMap().get(key)
      map.set(key, issue?.title ?? refLabel(node.ref))
    }
    return map
  })

  // Available nodes for adding as upstream (excluding self and existing upstream deps)
  const availableUpstream = createMemo(() => {
    const node = selectedNode()
    if (!node) return []
    const selfKey = refKey(node.ref)
    const existingUpKeys = new Set(node.dependencies.map(refKey))
    return filteredGraph().nodes.filter((n) => {
      const k = refKey(n.ref)
      return k !== selfKey && !existingUpKeys.has(k)
    })
  })

  // Available nodes for adding as downstream (excluding self and existing downstream deps)
  const availableDownstream = createMemo(() => {
    const node = selectedNode()
    if (!node) return []
    const selfKey = refKey(node.ref)
    const existingDownKeys = new Set(node.dependents.map(refKey))
    return filteredGraph().nodes.filter((n) => {
      const k = refKey(n.ref)
      return k !== selfKey && !existingDownKeys.has(k)
    })
  })

  async function addDependency(from: EntityRef, to: EntityRef, type: 'depends_on' | 'blocks') {
    setDepLoading(true)
    try {
      await fetch(`/api/orgs/${encodeURIComponent(props.orgId)}/planning/dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, type })
      })
      await refetch()
    } finally {
      setDepLoading(false)
      setShowAddUpstream(false)
      setShowAddDownstream(false)
    }
  }

  async function removeDependency(from: EntityRef, to: EntityRef) {
    setDepLoading(true)
    try {
      await fetch(`/api/orgs/${encodeURIComponent(props.orgId)}/planning/dependencies`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to })
      })
      await refetch()
    } finally {
      setDepLoading(false)
    }
  }

  const projects = createMemo(() => {
    const d = data()
    if (!d) return [] as Array<{ id: string; name: string }>
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
    // Smooth proportional zoom — small trackpad gestures stay gentle, mouse wheel clicks are reasonable
    const raw = -e.deltaY * 0.002
    const clamped = Math.max(-0.05, Math.min(0.05, raw))
    setZoom((z) => Math.max(0.2, Math.min(3, z * (1 + clamped))))
  }

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      setDragging(true)
      setDragStart({ x: e.clientX - pan().x, y: e.clientY - pan().y })
      setMouseDownPos({ x: e.clientX, y: e.clientY })
    }
  }

  const handleMouseMove = (e: MouseEvent) => {
    if (dragging()) {
      setPan({ x: e.clientX - dragStart().x, y: e.clientY - dragStart().y })
    }
  }

  const handleMouseUp = (e: MouseEvent) => {
    const startPos = mouseDownPos()
    setDragging(false)
    // Close drawer on background click (not drag)
    if (startPos) {
      const dx = Math.abs(e.clientX - startPos.x)
      const dy = Math.abs(e.clientY - startPos.y)
      if (dx < 5 && dy < 5) {
        // It was a click, not a drag — close drawer
        setSelectedNodeKey(null)
        setShowAddUpstream(false)
        setShowAddDownstream(false)
      }
    }
    setMouseDownPos(null)
  }

  // Touch support for mobile pan/zoom
  let touchDragStart = { x: 0, y: 0 }
  let lastPinchDist = 0

  const pinchDistance = (t1: Touch, t2: Touch) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)

  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      setDragging(true)
      touchDragStart = { x: e.touches[0].clientX - pan().x, y: e.touches[0].clientY - pan().y }
    } else if (e.touches.length === 2) {
      setDragging(false)
      lastPinchDist = pinchDistance(e.touches[0], e.touches[1])
    }
  }

  const handleTouchMove = (e: TouchEvent) => {
    e.preventDefault()
    if (e.touches.length === 1 && dragging()) {
      setPan({ x: e.touches[0].clientX - touchDragStart.x, y: e.touches[0].clientY - touchDragStart.y })
    } else if (e.touches.length === 2) {
      const dist = pinchDistance(e.touches[0], e.touches[1])
      if (lastPinchDist > 0) {
        const scale = dist / lastPinchDist
        setZoom((z) => Math.max(0.2, Math.min(3, z * scale)))
      }
      lastPinchDist = dist
    }
  }

  const handleTouchEnd = () => {
    setDragging(false)
    lastPinchDist = 0
  }

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

      {/* Canvas + Drawer */}
      <div class="flex flex-1 overflow-hidden">
        {/* DAG Canvas */}
        <div class="flex-1 overflow-hidden" style={{ transition: 'width 0.3s ease' }}>
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
              style={{ 'touch-action': 'none' }}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={() => setDragging(false)}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
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
                    const isSelected = () => selectedNodeKey() === key

                    return (
                      <g
                        transform={`translate(${pos.x},${pos.y})`}
                        class="cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedNodeKey(key)
                          setShowAddUpstream(false)
                          setShowAddDownstream(false)
                        }}
                      >
                        <rect
                          width={NODE_WIDTH}
                          height={NODE_HEIGHT}
                          rx="6"
                          fill="var(--c-bg-secondary)"
                          stroke={isSelected() ? 'var(--c-accent)' : color}
                          stroke-width={isSelected() ? 3 : 2}
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

                {/* Draft nodes */}
                <For each={draftsStore.drafts().filter((d) => d.status === 'draft')}>
                  {(draft, i) => {
                    const totalProviderNodes = filteredGraph().nodes.length
                    const x = 40
                    const y = (totalProviderNodes + i()) * (NODE_HEIGHT + V_GAP) + 40
                    return (
                      <g
                        transform={`translate(${x},${y})`}
                        class="cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation()
                          draftsStore.selectDraft(draft.id)
                        }}
                      >
                        <rect
                          width={NODE_WIDTH}
                          height={NODE_HEIGHT}
                          rx="6"
                          fill="#FEF3C7"
                          stroke="#D97706"
                          stroke-width="2"
                          stroke-dasharray="6 3"
                        />
                        <circle cx="14" cy={NODE_HEIGHT / 2} r="5" fill="#D97706" />
                        <text x="28" y="24" font-size="11" fill="#78350F" font-family="sans-serif">
                          {(draft.title || 'Untitled').length > 26
                            ? (draft.title || 'Untitled').slice(0, 26) + '...'
                            : draft.title || 'Untitled'}
                        </text>
                        <text x="28" y="44" font-size="9" fill="#92400E" font-family="sans-serif">
                          {draft.labels.slice(0, 3).join(', ') || 'draft'}
                        </text>
                      </g>
                    )
                  }}
                </For>
              </g>
            </svg>
          </Show>
        </div>

        {/* Detail Drawer */}
        <div
          style={{
            width: drawerOpen() ? `${DRAWER_WIDTH}px` : '0px',
            'min-width': drawerOpen() ? `${DRAWER_WIDTH}px` : '0px',
            transition: 'width 0.3s ease, min-width 0.3s ease',
            'border-left': drawerOpen() ? '1px solid var(--c-border)' : 'none',
            background: 'var(--c-bg-raised)',
            overflow: 'hidden'
          }}
        >
          <Show when={selectedNode()}>
            {(node) => {
              const issue = () => selectedIssue()
              const title = () => issue()?.title ?? refLabel(node().ref)
              const stateColor = () => (node().state === 'open' ? 'var(--c-success)' : 'var(--c-text-muted)')

              return (
                <div style={{ width: `${DRAWER_WIDTH}px`, height: '100%', overflow: 'auto', padding: '12px' }}>
                  {/* Close button */}
                  <div class="flex items-center justify-between" style={{ 'margin-bottom': '12px' }}>
                    <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      {refLabel(node().ref)}
                    </span>
                    <button
                      class="hover:opacity-80"
                      style={{
                        color: 'var(--c-text-muted)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        'font-size': '16px',
                        'line-height': '1'
                      }}
                      onClick={() => {
                        setSelectedNodeKey(null)
                        setShowAddUpstream(false)
                        setShowAddDownstream(false)
                      }}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Title */}
                  <h3
                    style={{
                      color: 'var(--c-text)',
                      'font-size': '14px',
                      'font-weight': '600',
                      margin: '0 0 8px 0',
                      'line-height': '1.3'
                    }}
                  >
                    {title()}
                  </h3>

                  {/* State badge */}
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      'border-radius': '9999px',
                      'font-size': '11px',
                      'font-weight': '500',
                      color: '#fff',
                      background: stateColor(),
                      'margin-bottom': '10px'
                    }}
                  >
                    {node().state}
                  </span>

                  {/* Labels */}
                  <Show when={node().labels.length > 0}>
                    <div style={{ 'margin-bottom': '10px' }}>
                      <div
                        style={{
                          color: 'var(--c-text-muted)',
                          'font-size': '10px',
                          'text-transform': 'uppercase',
                          'letter-spacing': '0.05em',
                          'margin-bottom': '4px'
                        }}
                      >
                        Labels
                      </div>
                      <div class="flex flex-wrap gap-1">
                        <For each={node().labels}>
                          {(label) => (
                            <span
                              style={{
                                padding: '1px 6px',
                                'border-radius': '4px',
                                'font-size': '11px',
                                background: 'var(--c-bg-tertiary)',
                                color: 'var(--c-text)'
                              }}
                            >
                              {label}
                            </span>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  {/* Assignees */}
                  <Show when={node().assignees.length > 0}>
                    <div style={{ 'margin-bottom': '10px' }}>
                      <div
                        style={{
                          color: 'var(--c-text-muted)',
                          'font-size': '10px',
                          'text-transform': 'uppercase',
                          'letter-spacing': '0.05em',
                          'margin-bottom': '4px'
                        }}
                      >
                        Assignees
                      </div>
                      <div class="flex flex-wrap gap-1">
                        <For each={node().assignees}>
                          {(a) => (
                            <span
                              style={{
                                padding: '1px 6px',
                                'border-radius': '4px',
                                'font-size': '11px',
                                background: 'var(--c-bg-tertiary)',
                                color: 'var(--c-text)'
                              }}
                            >
                              {a}
                            </span>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  {/* Upstream dependencies */}
                  <div
                    style={{ 'margin-top': '16px', 'border-top': '1px solid var(--c-border)', 'padding-top': '12px' }}
                  >
                    <div
                      style={{
                        color: 'var(--c-text-muted)',
                        'font-size': '10px',
                        'text-transform': 'uppercase',
                        'letter-spacing': '0.05em',
                        'margin-bottom': '6px'
                      }}
                    >
                      Depends on ({node().dependencies.length})
                    </div>
                    <For each={node().dependencies}>
                      {(dep) => {
                        const depKey = refKey(dep)
                        const depTitle = () => nodeTitleMap().get(depKey) ?? refLabel(dep)
                        return (
                          <div
                            class="flex items-center justify-between"
                            style={{ padding: '4px 0', 'font-size': '12px' }}
                          >
                            <div style={{ 'min-width': '0', flex: '1' }}>
                              <div
                                style={{
                                  color: 'var(--c-text)',
                                  'white-space': 'nowrap',
                                  overflow: 'hidden',
                                  'text-overflow': 'ellipsis'
                                }}
                              >
                                {depTitle()}
                              </div>
                              <div style={{ color: 'var(--c-text-muted)', 'font-size': '10px' }}>{refLabel(dep)}</div>
                            </div>
                            <button
                              style={{
                                color: 'var(--c-error)',
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                'font-size': '14px',
                                padding: '0 4px',
                                'flex-shrink': '0'
                              }}
                              disabled={depLoading()}
                              onClick={() => removeDependency(node().ref, dep)}
                              title="Remove dependency"
                            >
                              ✕
                            </button>
                          </div>
                        )
                      }}
                    </For>
                    <Show when={!showAddUpstream()}>
                      <button
                        style={{
                          color: 'var(--c-accent)',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          'font-size': '11px',
                          padding: '4px 0'
                        }}
                        onClick={() => {
                          setShowAddUpstream(true)
                          setShowAddDownstream(false)
                        }}
                      >
                        + Add upstream dependency
                      </button>
                    </Show>
                    <Show when={showAddUpstream()}>
                      <div
                        style={{
                          'max-height': '150px',
                          overflow: 'auto',
                          border: '1px solid var(--c-border)',
                          'border-radius': '4px',
                          'margin-top': '4px'
                        }}
                      >
                        <For
                          each={availableUpstream()}
                          fallback={
                            <div style={{ padding: '6px', 'font-size': '11px', color: 'var(--c-text-muted)' }}>
                              No available nodes
                            </div>
                          }
                        >
                          {(n) => {
                            const nIssue = () => issueMap().get(refKey(n.ref))
                            return (
                              <div
                                style={{
                                  padding: '4px 8px',
                                  cursor: 'pointer',
                                  'font-size': '11px',
                                  'border-bottom': '1px solid var(--c-border)'
                                }}
                                class="hover:opacity-80"
                                onClick={() => addDependency(node().ref, n.ref, 'depends_on')}
                              >
                                <div style={{ color: 'var(--c-text)' }}>{nIssue()?.title ?? refLabel(n.ref)}</div>
                                <div style={{ color: 'var(--c-text-muted)', 'font-size': '10px' }}>
                                  {refLabel(n.ref)}
                                </div>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>

                  {/* Downstream dependents */}
                  <div
                    style={{ 'margin-top': '16px', 'border-top': '1px solid var(--c-border)', 'padding-top': '12px' }}
                  >
                    <div
                      style={{
                        color: 'var(--c-text-muted)',
                        'font-size': '10px',
                        'text-transform': 'uppercase',
                        'letter-spacing': '0.05em',
                        'margin-bottom': '6px'
                      }}
                    >
                      Blocks ({node().dependents.length})
                    </div>
                    <For each={node().dependents}>
                      {(dep) => {
                        const depKey = refKey(dep)
                        const depTitle = () => nodeTitleMap().get(depKey) ?? refLabel(dep)
                        return (
                          <div
                            class="flex items-center justify-between"
                            style={{ padding: '4px 0', 'font-size': '12px' }}
                          >
                            <div style={{ 'min-width': '0', flex: '1' }}>
                              <div
                                style={{
                                  color: 'var(--c-text)',
                                  'white-space': 'nowrap',
                                  overflow: 'hidden',
                                  'text-overflow': 'ellipsis'
                                }}
                              >
                                {depTitle()}
                              </div>
                              <div style={{ color: 'var(--c-text-muted)', 'font-size': '10px' }}>{refLabel(dep)}</div>
                            </div>
                            <button
                              style={{
                                color: 'var(--c-error)',
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                'font-size': '14px',
                                padding: '0 4px',
                                'flex-shrink': '0'
                              }}
                              disabled={depLoading()}
                              onClick={() => removeDependency(dep, node().ref)}
                              title="Remove dependent"
                            >
                              ✕
                            </button>
                          </div>
                        )
                      }}
                    </For>
                    <Show when={!showAddDownstream()}>
                      <button
                        style={{
                          color: 'var(--c-accent)',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          'font-size': '11px',
                          padding: '4px 0'
                        }}
                        onClick={() => {
                          setShowAddDownstream(true)
                          setShowAddUpstream(false)
                        }}
                      >
                        + Add downstream dependent
                      </button>
                    </Show>
                    <Show when={showAddDownstream()}>
                      <div
                        style={{
                          'max-height': '150px',
                          overflow: 'auto',
                          border: '1px solid var(--c-border)',
                          'border-radius': '4px',
                          'margin-top': '4px'
                        }}
                      >
                        <For
                          each={availableDownstream()}
                          fallback={
                            <div style={{ padding: '6px', 'font-size': '11px', color: 'var(--c-text-muted)' }}>
                              No available nodes
                            </div>
                          }
                        >
                          {(n) => {
                            const nIssue = () => issueMap().get(refKey(n.ref))
                            return (
                              <div
                                style={{
                                  padding: '4px 8px',
                                  cursor: 'pointer',
                                  'font-size': '11px',
                                  'border-bottom': '1px solid var(--c-border)'
                                }}
                                class="hover:opacity-80"
                                onClick={() => addDependency(n.ref, node().ref, 'depends_on')}
                              >
                                <div style={{ color: 'var(--c-text)' }}>{nIssue()?.title ?? refLabel(n.ref)}</div>
                                <div style={{ color: 'var(--c-text-muted)', 'font-size': '10px' }}>
                                  {refLabel(n.ref)}
                                </div>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>

                  {/* Open full detail link */}
                  <div
                    style={{ 'margin-top': '16px', 'border-top': '1px solid var(--c-border)', 'padding-top': '12px' }}
                  >
                    <button
                      style={{
                        color: 'var(--c-accent)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        'font-size': '11px',
                        padding: '0'
                      }}
                      onClick={() => openIssueDetail(node().ref.orgId, node().ref.projectId, node().ref.issueId)}
                    >
                      Open full detail →
                    </button>
                  </div>
                </div>
              )
            }}
          </Show>
        </div>
      </div>
    </div>
  )
}

export default PlanningDAGView

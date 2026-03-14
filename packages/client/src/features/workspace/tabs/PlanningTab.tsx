import { Component, createSignal, createResource, createEffect, Show, For, onCleanup, createMemo } from 'solid-js'
import { PlanningIcon } from '../../../ui/icons.js'

export interface PlanningNode {
  id: string
  title: string
  status: 'blocked' | 'ready' | 'in-progress' | 'done'
  critical: boolean
  dependencies: string[]
  entityType?: 'issue' | 'pr' | 'task'
  entityId?: string
}

export interface PlanningGraph {
  nodes: PlanningNode[]
  edges: { from: string; to: string }[]
}

export interface PlanningTabProps {
  orgId: string
  onClose?: () => void
  onNodeClick?: (node: PlanningNode) => void
}

async function fetchPlanningGraph(orgId: string): Promise<PlanningGraph> {
  const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/planning/graph`)
  if (!res.ok) throw new Error(`Failed to fetch planning graph: ${res.statusText}`)
  return res.json()
}

const statusIndicator: Record<PlanningNode['status'], { color: string; label: string }> = {
  blocked: { color: 'var(--c-error, #ef4444)', label: 'blocked' },
  ready: { color: 'var(--c-success, #22c55e)', label: 'ready' },
  'in-progress': { color: 'var(--c-warning, #f59e0b)', label: 'active' },
  done: { color: 'var(--c-text-muted)', label: '✅' }
}

const NODE_WIDTH = 200
const NODE_HEIGHT = 80
const HORIZONTAL_GAP = 60
const VERTICAL_GAP = 40

function layoutNodes(graph: PlanningGraph): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const inDegree = new Map<string, number>()
  const children = new Map<string, string[]>()

  for (const node of graph.nodes) {
    inDegree.set(node.id, 0)
    children.set(node.id, [])
  }
  for (const edge of graph.edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
    children.get(edge.from)?.push(edge.to)
  }

  // BFS topological sort for layered layout
  const layers: string[][] = []
  const queue = graph.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id)
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

  // Position nodes by layer
  for (let col = 0; col < layers.length; col++) {
    const layer = layers[col]
    const totalHeight = layer.length * NODE_HEIGHT + (layer.length - 1) * VERTICAL_GAP
    const startY = -totalHeight / 2
    for (let row = 0; row < layer.length; row++) {
      positions.set(layer[row], {
        x: col * (NODE_WIDTH + HORIZONTAL_GAP),
        y: startY + row * (NODE_HEIGHT + VERTICAL_GAP)
      })
    }
  }

  return positions
}

const PlanningTab: Component<PlanningTabProps> = (props) => {
  const [data, { refetch }] = createResource(() => props.orgId, fetchPlanningGraph)
  const [pan, setPan] = createSignal({ x: 100, y: 300 })
  const [zoom, setZoom] = createSignal(1)
  const [dragging, setDragging] = createSignal(false)
  const [dragStart, setDragStart] = createSignal({ x: 0, y: 0 })

  const positions = createMemo(() => {
    const g = data()
    return g ? layoutNodes(g) : new Map()
  })

  // WS subscription for live updates
  createEffect(() => {
    const orgId = props.orgId
    let ws: WebSocket | null = null
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'subscribe', channels: ['planning'], scope: { orgId } }))
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'planning.update') refetch()
        } catch {
          /* ignore non-JSON */
        }
      }
    } catch {
      /* WS unavailable */
    }

    onCleanup(() => ws?.close())
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
    <div class="flex h-full flex-col overflow-hidden" style={{ background: 'var(--c-bg-primary)' }}>
      {/* Header */}
      <div
        class="flex shrink-0 items-center justify-between border-b px-3 py-1.5 text-sm"
        style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text-secondary)' }}
      >
        <div class="flex items-center gap-2">
          <PlanningIcon class="h-4 w-4" />
          <span style={{ color: 'var(--c-text-primary)' }}>Planning DAG</span>
        </div>
        <Show when={props.onClose}>
          <button
            class="text-lg leading-none hover:opacity-80"
            style={{ color: 'var(--c-text-muted)' }}
            onClick={props.onClose}
            aria-label="Close tab"
          >
            ×
          </button>
        </Show>
      </div>

      {/* Canvas */}
      <div class="flex-1 overflow-hidden">
        <Show when={data.loading}>
          <div class="p-4 text-sm" style={{ color: 'var(--c-text-muted)' }}>
            Loading…
          </div>
        </Show>
        <Show when={data.error}>
          <div class="p-4 text-sm" style={{ color: 'var(--c-error)' }}>
            Error: {(data.error as Error).message}
          </div>
        </Show>
        <Show when={data()}>
          {(graph) => (
            <svg
              class="h-full w-full cursor-grab"
              classList={{ 'cursor-grabbing': dragging() }}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              <g transform={`translate(${pan().x},${pan().y}) scale(${zoom()})`}>
                {/* Edges */}
                <For each={graph().edges}>
                  {(edge) => {
                    const from = positions().get(edge.from)
                    const to = positions().get(edge.to)
                    if (!from || !to) return null
                    const fromNode = graph().nodes.find((n) => n.id === edge.from)
                    const toNode = graph().nodes.find((n) => n.id === edge.to)
                    const isCritical = fromNode?.critical && toNode?.critical
                    return (
                      <line
                        x1={from.x + NODE_WIDTH}
                        y1={from.y + NODE_HEIGHT / 2}
                        x2={to.x}
                        y2={to.y + NODE_HEIGHT / 2}
                        stroke={isCritical ? 'var(--c-accent, #3b82f6)' : 'var(--c-border)'}
                        stroke-width={isCritical ? 2.5 : 1.5}
                        marker-end="url(#arrowhead)"
                      />
                    )
                  }}
                </For>

                {/* Arrow marker */}
                <defs>
                  <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                    <polygon points="0 0, 8 3, 0 6" fill="var(--c-border)" />
                  </marker>
                </defs>

                {/* Nodes */}
                <For each={graph().nodes}>
                  {(node) => {
                    const pos = positions().get(node.id)
                    if (!pos) return null
                    const si = statusIndicator[node.status]
                    return (
                      <g
                        transform={`translate(${pos.x},${pos.y})`}
                        class="cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation()
                          props.onNodeClick?.(node)
                        }}
                      >
                        <rect
                          width={NODE_WIDTH}
                          height={NODE_HEIGHT}
                          rx="6"
                          fill="var(--c-bg-secondary)"
                          stroke={node.critical ? 'var(--c-accent, #3b82f6)' : 'var(--c-border)'}
                          stroke-width={node.critical ? 2 : 1}
                        />
                        <text
                          x="10"
                          y="24"
                          font-size="12"
                          fill="var(--c-text-primary)"
                          font-family="var(--font-sans, sans-serif)"
                        >
                          {node.title.length > 22 ? node.title.slice(0, 22) + '…' : node.title}
                        </text>
                        <text x="10" y="50" font-size="11" fill={si.color}>
                          {si.label} {node.status}
                        </text>
                      </g>
                    )
                  }}
                </For>
              </g>
            </svg>
          )}
        </Show>
      </div>
    </div>
  )
}

export default PlanningTab
export { fetchPlanningGraph, layoutNodes }

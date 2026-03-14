// §P.2 FlowGraph — SVG-based system data flow visualization
// Simplified port from voice-ui SystemFlowGraph.tsx — no ELK dependency, static layout

import { type Component, createSignal, For, Show } from 'solid-js'

interface FlowNode {
  id: string
  label: string
  icon: string
  group: string
  description: string
  x: number
  y: number
}

interface FlowEdge {
  source: string
  target: string
  label?: string
  dashed?: boolean
}

const GROUP_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  external: { bg: 'rgba(239,68,68,0.12)', border: '#ef4444', text: '#fca5a5' },
  input: { bg: 'rgba(59,130,246,0.12)', border: '#3b82f6', text: '#93c5fd' },
  processing: { bg: 'rgba(168,85,247,0.12)', border: '#a855f7', text: '#c4b5fd' },
  storage: { bg: 'rgba(34,197,94,0.12)', border: '#22c55e', text: '#86efac' },
  output: { bg: 'rgba(245,158,11,0.12)', border: '#f59e0b', text: '#fcd34d' }
}

const NODE_W = 140
const NODE_H = 52

// Static layout of the request/response flow
const NODES: FlowNode[] = [
  { id: 'user', label: 'User', icon: '👤', group: 'external', description: 'Client input', x: 40, y: 100 },
  { id: 'gateway', label: 'Gateway', icon: '🔀', group: 'input', description: 'Route & auth', x: 240, y: 40 },
  { id: 'ws', label: 'WebSocket', icon: '🔌', group: 'input', description: 'Real-time sync', x: 240, y: 160 },
  { id: 'agent', label: 'Agent', icon: '🤖', group: 'processing', description: 'LLM reasoning', x: 460, y: 100 },
  { id: 'tools', label: 'Tools', icon: '🔧', group: 'processing', description: 'Execute actions', x: 660, y: 40 },
  { id: 'events', label: 'Events', icon: '📡', group: 'storage', description: 'Event bus', x: 660, y: 160 },
  { id: 'response', label: 'Response', icon: '💬', group: 'output', description: 'Stream back', x: 860, y: 100 }
]

const EDGES: FlowEdge[] = [
  { source: 'user', target: 'gateway', label: 'HTTP/REST' },
  { source: 'user', target: 'ws', label: 'WS' },
  { source: 'gateway', target: 'agent', label: 'forward' },
  { source: 'ws', target: 'agent', label: 'stream' },
  { source: 'agent', target: 'tools', label: 'call' },
  { source: 'tools', target: 'agent', label: 'result', dashed: true },
  { source: 'agent', target: 'events', label: 'emit' },
  { source: 'agent', target: 'response', label: 'stream' },
  { source: 'response', target: 'user', label: 'deliver', dashed: true }
]

function getNodeCenter(node: FlowNode): { x: number; y: number } {
  return { x: node.x + NODE_W / 2, y: node.y + NODE_H / 2 }
}

function edgePath(src: FlowNode, tgt: FlowNode): string {
  const s = getNodeCenter(src)
  const t = getNodeCenter(tgt)
  // Determine exit/entry points
  const sx = src.x < tgt.x ? src.x + NODE_W : src.x
  const tx = src.x < tgt.x ? tgt.x : tgt.x + NODE_W
  const sy = s.y
  const ty = t.y
  const mx = (sx + tx) / 2
  return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`
}

const FlowGraph: Component = () => {
  const [hovered, setHovered] = createSignal<string | null>(null)

  const nodeMap = new Map(NODES.map((n) => [n.id, n]))

  const isHighlighted = (nodeId: string) => {
    const h = hovered()
    if (!h) return true
    if (nodeId === h) return true
    return EDGES.some((e) => (e.source === h && e.target === nodeId) || (e.target === h && e.source === nodeId))
  }

  const isEdgeHighlighted = (edge: FlowEdge) => {
    const h = hovered()
    if (!h) return true
    return edge.source === h || edge.target === h
  }

  const viewBox = '0 0 1040 280'

  return (
    <div class="space-y-3">
      {/* Legend */}
      <div class="flex flex-wrap gap-2">
        <For each={Object.entries(GROUP_COLORS)}>
          {([group, colors]) => (
            <div
              class="flex items-center gap-1 rounded px-2 py-0.5 text-[10px]"
              style={{ background: colors.bg, border: `1px solid ${colors.border}`, color: colors.text }}
            >
              {group}
            </div>
          )}
        </For>
      </div>

      {/* Graph */}
      <div
        class="overflow-auto rounded-lg border"
        style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
      >
        <svg viewBox={viewBox} class="w-full" style={{ 'min-height': '220px' }}>
          <defs>
            <marker
              id="flow-arrow"
              viewBox="0 0 10 6"
              refX="9"
              refY="3"
              markerWidth="8"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 3 L 0 6 z" fill="var(--c-text)" opacity="0.4" />
            </marker>
          </defs>

          {/* Edges */}
          <For each={EDGES}>
            {(edge) => {
              const src = nodeMap.get(edge.source)
              const tgt = nodeMap.get(edge.target)
              if (!src || !tgt) return null
              return (
                <g opacity={isEdgeHighlighted(edge) ? 1 : 0.15}>
                  <path
                    d={edgePath(src, tgt)}
                    fill="none"
                    stroke="var(--c-text)"
                    stroke-width={hovered() && isEdgeHighlighted(edge) ? 2 : 1.2}
                    stroke-dasharray={edge.dashed ? '4,3' : 'none'}
                    stroke-opacity="0.3"
                    marker-end="url(#flow-arrow)"
                  />
                  <Show when={edge.label}>
                    {(label) => {
                      const s = getNodeCenter(src)
                      const t = getNodeCenter(tgt)
                      return (
                        <text
                          x={(s.x + t.x) / 2}
                          y={(s.y + t.y) / 2 - 8}
                          text-anchor="middle"
                          font-size="9"
                          fill="var(--c-text)"
                          opacity={hovered() && isEdgeHighlighted(edge) ? 0.7 : 0.35}
                        >
                          {label()}
                        </text>
                      )
                    }}
                  </Show>
                </g>
              )
            }}
          </For>

          {/* Nodes */}
          <For each={NODES}>
            {(node) => {
              const colors = GROUP_COLORS[node.group] || GROUP_COLORS.processing
              return (
                <g
                  transform={`translate(${node.x}, ${node.y})`}
                  opacity={isHighlighted(node.id) ? 1 : 0.2}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx="8"
                    fill={colors.bg}
                    stroke={hovered() === node.id ? colors.text : colors.border}
                    stroke-width={hovered() === node.id ? 2 : 1}
                  />
                  <text x={NODE_W / 2} y={20} text-anchor="middle" font-size="12" fill={colors.text} font-weight="600">
                    {node.icon} {node.label}
                  </text>
                  <text x={NODE_W / 2} y={38} text-anchor="middle" font-size="9" fill="var(--c-text)" opacity="0.5">
                    {node.description}
                  </text>
                </g>
              )
            }}
          </For>
        </svg>
      </div>
    </div>
  )
}

export default FlowGraph

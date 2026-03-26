import { type Component, createSignal, onMount, onCleanup, For, Show, createMemo, type JSX } from 'solid-js'
import {
  viewMode,
  setViewMode,
  filters,
  setFilter,
  clearFilters,
  removeFilterValue,
  searchQuery,
  setSearchQuery,
  type PlanningViewMode
} from './store'
import {
  LinkIcon,
  KanbanIcon,
  ListIcon,
  TreeIcon,
  SearchIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon
} from '../../ui/icons.js'

// ── Server response types ────────────────────────────────────────────

interface EntityRef {
  orgId: string
  projectId: string
  remote: string
  issueId: string
}

interface ServerGraphNode {
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

interface ServerEdge {
  from: EntityRef
  to: EntityRef
  type: string
  source: string
}

interface ServerGraphResponse {
  nodes: ServerGraphNode[]
  edges: ServerEdge[]
  crossWorkspaceEdges?: ServerEdge[]
}

// ── Client types ─────────────────────────────────────────────────────

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
}

export interface PlanningEdge {
  from: string
  to: string
  crossWorkspace: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────

function refToId(ref: EntityRef): string {
  return `${ref.remote}:${ref.orgId}/${ref.projectId}#${ref.issueId}`
}

function deriveStatus(node: ServerGraphNode, nodeMap: Map<string, ServerGraphNode>): PlanningNode['status'] {
  if (node.state === 'closed') return 'done'
  const hasOpenDep = node.dependencies.some((dep) => {
    const depNode = nodeMap.get(refToId(dep))
    return depNode && depNode.state === 'open'
  })
  if (hasOpenDep) return 'blocked'
  if (node.assignees.length > 0) return 'in-progress'
  return 'open'
}

function derivePriority(node: ServerGraphNode): PlanningNode['priority'] {
  const labels = node.labels.map((l) => l.toLowerCase())
  if (labels.some((l) => l.includes('critical') || l.includes('p0'))) return 'critical'
  if (labels.some((l) => l.includes('high') || l.includes('p1') || l.includes('urgent'))) return 'high'
  if (labels.some((l) => l.includes('low') || l.includes('p3'))) return 'low'
  return 'medium'
}

function computeDepths(nodes: ServerGraphNode[]): Map<string, number> {
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

// ── Status colors ────────────────────────────────────────────────────

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

export function PriorityIcon(props: { priority: PlanningNode['priority']; class?: string }): JSX.Element {
  const size = props.class ?? 'h-3 w-3'
  switch (props.priority) {
    case 'critical':
      return (
        <svg class={size} viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" fill="#ef4444" stroke="#ef4444" stroke-width="1" />
          <path d="M6 3v4M6 8.5v.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      )
    case 'high':
      return (
        <svg class={size} viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" fill="#f97316" stroke="#f97316" stroke-width="1" />
          <path
            d="M6 8V4M4 6l2-2 2 2"
            stroke="#fff"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      )
    case 'medium':
      return (
        <svg class={size} viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" fill="#3b82f6" stroke="#3b82f6" stroke-width="1" />
          <path d="M3.5 6h5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      )
    case 'low':
      return (
        <svg class={size} viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" fill="#6b7280" stroke="#6b7280" stroke-width="1" />
          <path
            d="M6 4v4M4 6l2 2 2-2"
            stroke="#fff"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      )
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

const WORKSPACE_COLORS = [
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

export const VIEW_MODES: Array<{ key: PlanningViewMode; label: string; icon: () => JSX.Element }> = [
  { key: 'dag', label: 'DAG', icon: () => <LinkIcon class="h-3.5 w-3.5" /> },
  { key: 'kanban', label: 'Kanban', icon: () => <KanbanIcon class="h-3.5 w-3.5" /> },
  { key: 'list', label: 'List', icon: () => <ListIcon class="h-3.5 w-3.5" /> },
  { key: 'tree', label: 'Tree', icon: () => <TreeIcon class="h-3.5 w-3.5" /> }
]

export const FILTER_KEYS = ['workspace', 'project', 'status', 'assignee', 'label', 'priority'] as const

// ── DAG layout — exported for tests ──────────────────────────────────

export function dagLayout(nodes: PlanningNode[]): Array<{ node: PlanningNode; x: number; y: number }> {
  const byDepth = new Map<number, PlanningNode[]>()
  for (const n of nodes) {
    const list = byDepth.get(n.depth) || []
    list.push(n)
    byDepth.set(n.depth, list)
  }
  const result: Array<{ node: PlanningNode; x: number; y: number }> = []
  for (const [depth, items] of byDepth) {
    items.forEach((node, i) => {
      result.push({ node, x: depth * 250 + 50, y: i * 100 + 50 })
    })
  }
  return result
}

// ── Improved DAG layout: split connected vs unconnected ──────────────

const DAG_NODE_W = 220
const DAG_NODE_H = 68
const DAG_H_GAP = 60
const DAG_V_GAP = 24
const GRID_CARD_W = 180
const GRID_CARD_H = 52
const GRID_GAP = 12

interface LayoutResult {
  connected: Array<{ node: PlanningNode; x: number; y: number }>
  unconnected: Array<{ node: PlanningNode; x: number; y: number }>
  connectedBounds: { w: number; h: number }
  totalHeight: number
}

function improvedLayout(nodes: PlanningNode[], edges: PlanningEdge[]): LayoutResult {
  const edgeNodeIds = new Set<string>()
  for (const e of edges) {
    edgeNodeIds.add(e.from)
    edgeNodeIds.add(e.to)
  }
  // Also include transitive: any node with deps pointing to/from edge nodes
  for (const n of nodes) {
    if (n.dependencies.some((d) => edgeNodeIds.has(d))) edgeNodeIds.add(n.id)
  }

  const connected = nodes.filter((n) => edgeNodeIds.has(n.id))
  const unconnected = nodes.filter((n) => !edgeNodeIds.has(n.id))

  // Build adjacency for median heuristic
  // edge.from depends on edge.to, so edge.to is at lower depth (left)
  const leftNeighbors = new Map<string, string[]>() // node -> nodes in previous column it connects to
  for (const e of edges) {
    // e.from (dependent, higher depth) connects to e.to (dependency, lower depth)
    const list = leftNeighbors.get(e.from) || []
    list.push(e.to)
    leftNeighbors.set(e.from, list)
  }

  // Group by depth
  const byDepth = new Map<number, PlanningNode[]>()
  for (const n of connected) {
    const list = byDepth.get(n.depth) || []
    list.push(n)
    byDepth.set(n.depth, list)
  }

  const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b)

  // First pass: assign initial y positions
  const nodeYPos = new Map<string, number>()
  for (const depth of sortedDepths) {
    const items = byDepth.get(depth)!
    items.forEach((node, i) => {
      nodeYPos.set(node.id, i * (DAG_NODE_H + DAG_V_GAP) + 40)
    })
  }

  // Median heuristic: sort nodes in each column by median y of their left neighbors
  // Run a few iterations for convergence
  for (let iter = 0; iter < 3; iter++) {
    for (const depth of sortedDepths) {
      if (depth === 0) continue // first column has no left neighbors
      const items = byDepth.get(depth)!
      items.sort((a, b) => {
        const aNeighbors = (leftNeighbors.get(a.id) || []).map((id) => nodeYPos.get(id) ?? 0)
        const bNeighbors = (leftNeighbors.get(b.id) || []).map((id) => nodeYPos.get(id) ?? 0)
        const medianA = aNeighbors.length > 0 ? aNeighbors.sort((x, y) => x - y)[Math.floor(aNeighbors.length / 2)] : 0
        const medianB = bNeighbors.length > 0 ? bNeighbors.sort((x, y) => x - y)[Math.floor(bNeighbors.length / 2)] : 0
        return medianA - medianB
      })
      // Re-assign y positions after sort
      items.forEach((node, i) => {
        nodeYPos.set(node.id, i * (DAG_NODE_H + DAG_V_GAP) + 40)
      })
    }
  }

  // Center each column vertically relative to the tallest column
  let globalMaxItems = 0
  for (const depth of sortedDepths) {
    globalMaxItems = Math.max(globalMaxItems, byDepth.get(depth)!.length)
  }
  const totalColumnHeight = globalMaxItems * (DAG_NODE_H + DAG_V_GAP) - DAG_V_GAP

  const connectedPositions: Array<{ node: PlanningNode; x: number; y: number }> = []
  let maxX = 0
  let maxY = 0
  for (const depth of sortedDepths) {
    const items = byDepth.get(depth)!
    const colX = depth * (DAG_NODE_W + DAG_H_GAP) + 40
    const colHeight = items.length * (DAG_NODE_H + DAG_V_GAP) - DAG_V_GAP
    const offsetY = Math.max(0, (totalColumnHeight - colHeight) / 2)
    items.forEach((node, i) => {
      const y = i * (DAG_NODE_H + DAG_V_GAP) + 40 + offsetY
      nodeYPos.set(node.id, y) // update for edge routing
      connectedPositions.push({ node, x: colX, y })
      maxX = Math.max(maxX, colX + DAG_NODE_W)
      maxY = Math.max(maxY, y + DAG_NODE_H)
    })
  }

  const connectedBounds = { w: maxX + 40, h: maxY + 40 }

  // Grid layout for unconnected, grouped by project
  const byProject = new Map<string, PlanningNode[]>()
  for (const n of unconnected) {
    const key = `${n.workspaceName}/${n.projectName}`
    const list = byProject.get(key) || []
    list.push(n)
    byProject.set(key, list)
  }

  const unconnectedPositions: Array<{ node: PlanningNode; x: number; y: number }> = []
  const gridStartY = connectedBounds.h + 60
  // Compute available width — use a reasonable default
  const gridCols = 5
  let curX = 40
  let curY = gridStartY
  let colIdx = 0

  for (const [, items] of byProject) {
    for (const node of items) {
      unconnectedPositions.push({ node, x: curX, y: curY })
      colIdx++
      if (colIdx >= gridCols) {
        colIdx = 0
        curX = 40
        curY += GRID_CARD_H + GRID_GAP
      } else {
        curX += GRID_CARD_W + GRID_GAP
      }
    }
  }

  const totalHeight =
    unconnectedPositions.length > 0 ? Math.max(curY + GRID_CARD_H + 40, connectedBounds.h) : connectedBounds.h

  return { connected: connectedPositions, unconnected: unconnectedPositions, connectedBounds, totalHeight }
}

// ── Filter Dropdown Component ────────────────────────────────────────

function FilterDropdown(props: {
  label: string
  filterKey: string
  options: Array<{ value: string; label: string }>
  selected: string[]
  onToggle: (value: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [search, setSearch] = createSignal('')
  let containerRef: HTMLDivElement | undefined

  const filteredOptions = createMemo(() => {
    const q = search().toLowerCase()
    if (!q) return props.options
    return props.options.filter((o) => o.label.toLowerCase().includes(q))
  })

  // Close on outside click
  function handleClickOutside(e: MouseEvent) {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false)
    }
  }

  onMount(() => document.addEventListener('mousedown', handleClickOutside))
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))

  return (
    <div ref={containerRef} class="relative" data-testid={`filter-${props.filterKey}`}>
      <button
        class="flex items-center gap-1 rounded px-2 py-1 text-xs"
        style={{
          background: props.selected.length > 0 ? 'var(--c-accent, #89b4fa)' : 'var(--c-surface, #181825)',
          color: props.selected.length > 0 ? 'var(--c-bg, #1e1e2e)' : 'var(--c-text, #cdd6f4)',
          border: '1px solid var(--c-border, #45475a)'
        }}
        onClick={() => setOpen(!open())}
      >
        <span>{props.label}</span>
        <Show when={props.selected.length > 0}>
          <span
            class="flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold"
            style={{
              background: props.selected.length > 0 ? 'var(--c-bg, #1e1e2e)' : 'var(--c-accent)',
              color: props.selected.length > 0 ? 'var(--c-accent, #89b4fa)' : 'var(--c-bg)'
            }}
          >
            {props.selected.length}
          </span>
        </Show>
        <ChevronDownIcon class="h-3 w-3" />
      </button>
      <Show when={open()}>
        <div
          class="absolute top-full left-0 z-50 mt-1 flex w-56 flex-col rounded-lg shadow-lg"
          style={{
            background: 'var(--c-bg-raised, #1e1e2e)',
            border: '1px solid var(--c-border, #45475a)'
          }}
        >
          <Show when={props.options.length > 6}>
            <div class="p-1.5">
              <input
                type="text"
                placeholder="Search..."
                class="w-full rounded px-2 py-1 text-xs"
                style={{
                  background: 'var(--c-surface, #181825)',
                  color: 'var(--c-text, #cdd6f4)',
                  border: '1px solid var(--c-border, #45475a)'
                }}
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
              />
            </div>
          </Show>
          <div class="max-h-48 overflow-y-auto p-1">
            <For each={filteredOptions()}>
              {(opt) => {
                const isSelected = () => props.selected.includes(opt.value)
                return (
                  <button
                    class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:opacity-80"
                    style={{
                      background: isSelected() ? 'rgba(137, 180, 250, 0.1)' : 'transparent',
                      color: 'var(--c-text, #cdd6f4)'
                    }}
                    onClick={() => props.onToggle(opt.value)}
                  >
                    <span
                      class="flex h-3.5 w-3.5 items-center justify-center rounded border"
                      style={{
                        background: isSelected() ? 'var(--c-accent, #89b4fa)' : 'transparent',
                        'border-color': isSelected() ? 'var(--c-accent, #89b4fa)' : 'var(--c-border, #45475a)'
                      }}
                    >
                      <Show when={isSelected()}>
                        <CheckIcon class="h-2.5 w-2.5" style={{ color: 'var(--c-bg, #1e1e2e)' }} />
                      </Show>
                    </span>
                    <span>{opt.label}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────────

const GlobalPlanningView: Component = () => {
  const [nodes, setNodes] = createSignal<PlanningNode[]>([])
  const [edges, setEdges] = createSignal<PlanningEdge[]>([])
  const [orgs, setOrgs] = createSignal<Array<{ id: string; name: string }>>([])
  const [projectNames, setProjectNames] = createSignal<Map<string, string>>(new Map())
  const [criticalPathIds, setCriticalPathIds] = createSignal<Set<string>>(new Set())
  const [showCreateDialog, setShowCreateDialog] = createSignal(false)
  const [showAssignDialog, setShowAssignDialog] = createSignal(false)

  // Pan/zoom state
  const [panX, setPanX] = createSignal(0)
  const [panY, setPanY] = createSignal(0)
  const [zoom, setZoom] = createSignal(1)
  const [isPanning, setIsPanning] = createSignal(false)
  const [panStartX, setPanStartX] = createSignal(0)
  const [panStartY, setPanStartY] = createSignal(0)
  const [panStartPanX, setPanStartPanX] = createSignal(0)
  const [panStartPanY, setPanStartPanY] = createSignal(0)

  // Hover state for edge highlighting
  const [hoveredNodeId, setHoveredNodeId] = createSignal<string | null>(null)

  // Selected node for detail drawer
  const [selectedNodeId, setSelectedNodeId] = createSignal<string | null>(null)
  const [mouseDownPos, setMouseDownPos] = createSignal<{ x: number; y: number } | null>(null)
  const [showAddUpstream, setShowAddUpstream] = createSignal(false)
  const [showAddDownstream, setShowAddDownstream] = createSignal(false)
  const [depLoading, setDepLoading] = createSignal(false)

  // Unconnected grid page
  const [unconnectedPage, setUnconnectedPage] = createSignal(0)
  const UNCONNECTED_PAGE_SIZE = 50

  // Create dialog state
  const [createOrgId, setCreateOrgId] = createSignal('')
  const [createTitle, setCreateTitle] = createSignal('')
  const [createBody, setCreateBody] = createSignal('')
  const [createSubmitting, setCreateSubmitting] = createSignal(false)

  // Expose pan/zoom for legacy test compat
  const svgZoom = zoom
  const svgPanX = panX
  const svgPanY = panY

  let svgRef: SVGSVGElement | undefined

  async function fetchGraph() {
    try {
      const orgsRes = await fetch('/api/orgs')
      if (!orgsRes.ok) return
      const orgsData = await orgsRes.json()
      const orgList = (orgsData.orgs || orgsData || []).map((o: any) => ({
        id: o.id || o.orgId,
        name: o.name || o.id
      }))
      setOrgs(orgList)

      const names = new Map<string, string>()
      await Promise.all(
        orgList.map(async (org: { id: string }) => {
          try {
            const res = await fetch(`/api/orgs/${org.id}/projects`)
            if (!res.ok) return
            const projects = await res.json()
            for (const p of Array.isArray(projects) ? projects : projects.projects || []) {
              names.set(p.id || p.projectId, p.name || p.id)
            }
          } catch {
            /* skip */
          }
        })
      )
      setProjectNames(names)

      let graphData: ServerGraphResponse
      const graphRes = await fetch('/api/planning/graph')
      if (graphRes.ok) {
        graphData = await graphRes.json()
      } else {
        const allNodes: ServerGraphNode[] = []
        const allEdges: ServerEdge[] = []
        for (const org of orgList) {
          try {
            const res = await fetch(`/api/orgs/${org.id}/planning/graph`)
            if (!res.ok) continue
            const graph = await res.json()
            allNodes.push(...(graph.nodes || []))
            allEdges.push(...(graph.edges || []))
          } catch {
            /* skip */
          }
        }
        graphData = { nodes: allNodes, edges: allEdges }
      }

      const serverNodeMap = new Map<string, ServerGraphNode>()
      for (const n of graphData.nodes) serverNodeMap.set(refToId(n.ref), n)

      const depths = computeDepths(graphData.nodes)

      const cpIds = new Set<string>()
      try {
        const cpRes = await fetch('/api/planning/critical-path')
        if (cpRes.ok) {
          const cp = await cpRes.json()
          for (const ref of cp.path || []) cpIds.add(refToId(ref))
        }
      } catch {
        /* skip */
      }
      setCriticalPathIds(cpIds)

      const crossWsEdgeKeys = new Set<string>()
      for (const e of graphData.crossWorkspaceEdges || []) {
        crossWsEdgeKeys.add(`${refToId(e.from)}->${refToId(e.to)}`)
      }
      for (const e of graphData.edges) {
        if (e.from.orgId !== e.to.orgId) {
          crossWsEdgeKeys.add(`${refToId(e.from)}->${refToId(e.to)}`)
        }
      }

      const orgNameMap = new Map<string, string>()
      for (const org of orgList) orgNameMap.set(org.id, org.name)

      const planningNodes: PlanningNode[] = graphData.nodes.map((n) => {
        const id = refToId(n.ref)
        const title = n.title || n.draftTitle || `${n.ref.projectId}#${n.ref.issueId}`
        return {
          id,
          title,
          workspace: n.ref.orgId,
          workspaceName: n.ref.orgId === '_drafts' ? 'Drafts' : orgNameMap.get(n.ref.orgId) || n.ref.orgId,
          project: n.ref.projectId,
          projectName: n.ref.projectId === '_local' ? 'Local Drafts' : names.get(n.ref.projectId) || n.ref.projectId,
          status: deriveStatus(n, serverNodeMap),
          assignee: n.assignees[0],
          labels: n.labels,
          priority: derivePriority(n),
          dependencies: n.dependencies.map(refToId),
          isCriticalPath: cpIds.has(id),
          depth: depths.get(id) ?? 0,
          isDraft: n.source === 'draft',
          kind: n.kind,
          ref: n.ref
        }
      })

      const planningEdges: PlanningEdge[] = graphData.edges.map((e) => ({
        from: refToId(e.from),
        to: refToId(e.to),
        crossWorkspace: crossWsEdgeKeys.has(`${refToId(e.from)}->${refToId(e.to)}`)
      }))

      setNodes(planningNodes)
      setEdges(planningEdges)
    } catch {
      /* network error */
    }
  }

  onMount(async () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setViewMode('list')
    }
    await fetchGraph()
  })

  const allWorkspaces = createMemo(() => [...new Set(nodes().map((n) => n.workspace))])

  const filteredNodes = createMemo(() => {
    let result = nodes()
    const f = filters()
    const q = searchQuery().toLowerCase()

    if (f.workspace?.length) result = result.filter((n) => f.workspace.includes(n.workspace))
    if (f.project?.length) result = result.filter((n) => f.project.includes(n.project))
    if (f.status?.length) result = result.filter((n) => f.status.includes(n.status))
    if (f.assignee?.length) result = result.filter((n) => n.assignee && f.assignee.includes(n.assignee))
    if (f.label?.length) result = result.filter((n) => n.labels.some((l) => f.label.includes(l)))
    if (f.priority?.length) result = result.filter((n) => f.priority.includes(n.priority))
    if (q) result = result.filter((n) => n.title.toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q))

    return result
  })

  const filteredEdges = createMemo(() => {
    const nodeIds = new Set(filteredNodes().map((n) => n.id))
    return edges().filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
  })

  // Layout memo
  const layout = createMemo(() => improvedLayout(filteredNodes(), filteredEdges()))

  // Position lookup for edges
  const positionMap = createMemo(() => {
    const map = new Map<string, { x: number; y: number; w: number; h: number }>()
    for (const p of layout().connected) {
      map.set(p.node.id, { x: p.x, y: p.y, w: DAG_NODE_W, h: DAG_NODE_H })
    }
    for (const p of layout().unconnected) {
      map.set(p.node.id, { x: p.x, y: p.y, w: GRID_CARD_W, h: GRID_CARD_H })
    }
    return map
  })

  // Connected edges for highlighting
  const connectedEdgeIds = createMemo(() => {
    const hid = hoveredNodeId()
    if (!hid) return new Set<string>()
    const ids = new Set<string>()
    for (const e of filteredEdges()) {
      if (e.from === hid || e.to === hid) {
        ids.add(`${e.from}->${e.to}`)
        ids.add(e.from)
        ids.add(e.to)
      }
    }
    return ids
  })

  // Summary stats
  const stats = createMemo(() => {
    const n = filteredNodes()
    const issueCount = n.filter((x) => !x.isDraft).length
    const draftCount = n.filter((x) => x.isDraft).length
    const depCount = filteredEdges().length
    return { issueCount, draftCount, depCount }
  })

  // Selected node
  const selectedNode = createMemo(() => {
    const id = selectedNodeId()
    if (!id) return null
    return nodes().find((n) => n.id === id) ?? null
  })

  // Node title map for dependency display
  const nodeTitleMap = createMemo(() => {
    const map = new Map<string, string>()
    for (const n of nodes()) map.set(n.id, n.title)
    return map
  })

  // Upstream dependencies (nodes this one depends on)
  const upstreamDeps = createMemo(() => {
    const node = selectedNode()
    if (!node) return [] as PlanningNode[]
    return node.dependencies.map((depId) => nodes().find((n) => n.id === depId)).filter(Boolean) as PlanningNode[]
  })

  // Downstream dependents (nodes that depend on this one)
  const downstreamDeps = createMemo(() => {
    const node = selectedNode()
    if (!node) return [] as PlanningNode[]
    return nodes().filter((n) => n.dependencies.includes(node.id))
  })

  // Available nodes for adding as upstream
  const availableUpstream = createMemo(() => {
    const node = selectedNode()
    if (!node) return [] as PlanningNode[]
    const existingUp = new Set(node.dependencies)
    return filteredNodes().filter((n) => n.id !== node.id && !existingUp.has(n.id))
  })

  // Available nodes for adding as downstream
  const availableDownstream = createMemo(() => {
    const node = selectedNode()
    if (!node) return [] as PlanningNode[]
    const existingDown = new Set(downstreamDeps().map((n) => n.id))
    return filteredNodes().filter((n) => n.id !== node.id && !existingDown.has(n.id))
  })

  // Find orgId for dependency API calls (use first org or selected node's workspace)
  function getOrgIdForDeps(): string {
    const node = selectedNode()
    if (node) return node.ref.orgId
    const o = orgs()
    return o.length > 0 ? o[0].id : ''
  }

  async function addDependency(from: EntityRef, to: EntityRef, type: 'depends_on' | 'blocks') {
    const orgId = getOrgIdForDeps()
    if (!orgId) return
    setDepLoading(true)
    try {
      await fetch(`/api/orgs/${encodeURIComponent(orgId)}/planning/dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, type })
      })
      await fetchGraph()
    } finally {
      setDepLoading(false)
      setShowAddUpstream(false)
      setShowAddDownstream(false)
    }
  }

  async function removeDependency(from: EntityRef, to: EntityRef) {
    const orgId = getOrgIdForDeps()
    if (!orgId) return
    setDepLoading(true)
    try {
      await fetch(`/api/orgs/${encodeURIComponent(orgId)}/planning/dependencies`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to })
      })
      await fetchGraph()
    } finally {
      setDepLoading(false)
    }
  }

  // Active filter pills
  const activeFilterPills = createMemo(() => {
    const f = filters()
    const pills: Array<{ key: string; value: string }> = []
    for (const [key, values] of Object.entries(f)) {
      for (const v of values) pills.push({ key, value: v })
    }
    return pills
  })

  // Filter options
  const filterOptions = createMemo(() => {
    const n = nodes()
    const workspaces = [...new Set(n.map((x) => x.workspace))].map((w) => ({
      value: w,
      label: n.find((x) => x.workspace === w)?.workspaceName || w
    }))
    const projects = [...new Set(n.map((x) => x.project))].map((p) => ({
      value: p,
      label: n.find((x) => x.project === p)?.projectName || p
    }))
    const statuses = (['open', 'in-progress', 'review', 'done', 'blocked'] as const).map((s) => ({
      value: s,
      label: getStatusLabel(s)
    }))
    const assignees = [...new Set(n.map((x) => x.assignee).filter(Boolean))].map((a) => ({
      value: a!,
      label: a!
    }))
    const labels = [...new Set(n.flatMap((x) => x.labels))].map((l) => ({ value: l, label: l }))
    const priorities = (['low', 'medium', 'high', 'critical'] as const).map((p) => ({ value: p, label: p }))
    return {
      workspace: workspaces,
      project: projects,
      status: statuses,
      assignee: assignees,
      label: labels,
      priority: priorities
    }
  })

  function handleFilterToggle(key: string, value: string) {
    const current = filters()[key] || []
    if (current.includes(value)) {
      setFilter(
        key,
        current.filter((v) => v !== value)
      )
    } else {
      setFilter(key, [...current, value])
    }
  }

  function handleNodeClick(node: PlanningNode) {
    if (viewMode() === 'dag') {
      setSelectedNodeId(node.id)
      setShowAddUpstream(false)
      setShowAddDownstream(false)
      return
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('sovereign:navigate', {
          detail: { view: 'workspace', orgId: node.workspace, entityId: node.id }
        })
      )
    }
  }

  // Pan/zoom handlers
  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    setIsPanning(true)
    setPanStartX(e.clientX)
    setPanStartY(e.clientY)
    setPanStartPanX(panX())
    setPanStartPanY(panY())
    setMouseDownPos({ x: e.clientX, y: e.clientY })
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isPanning()) return
    const dx = e.clientX - panStartX()
    const dy = e.clientY - panStartY()
    setPanX(panStartPanX() + dx)
    setPanY(panStartPanY() + dy)
  }

  function handleMouseUp(e: MouseEvent) {
    setIsPanning(false)
    const startPos = mouseDownPos()
    if (startPos) {
      const dx = Math.abs(e.clientX - startPos.x)
      const dy = Math.abs(e.clientY - startPos.y)
      if (dx < 5 && dy < 5) {
        // Click on background — check if target is a node
        const target = e.target as SVGElement
        const isNodeClick = target.closest('[data-testid^="dag-node-"]')
        if (!isNodeClick) {
          setSelectedNodeId(null)
          setShowAddUpstream(false)
          setShowAddDownstream(false)
        }
      }
    }
    setMouseDownPos(null)
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault()
    // Use deltaY magnitude for smooth proportional zoom.
    // macOS trackpads fire many small-delta events; mouse wheels fire fewer large ones.
    // Clamp the per-event factor so a single tick never jumps more than ~5%.
    const raw = -e.deltaY * 0.002
    const clamped = Math.max(-0.05, Math.min(0.05, raw))
    const newZoom = Math.max(0.1, Math.min(3, zoom() * (1 + clamped)))

    // Zoom towards mouse position
    if (svgRef) {
      const rect = svgRef.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const scale = newZoom / zoom()
      setPanX(mx - scale * (mx - panX()))
      setPanY(my - scale * (my - panY()))
    }

    setZoom(newZoom)
  }

  function resetZoom() {
    // Fit all content in view
    const l = layout()
    const allPositions = [...l.connected, ...l.unconnected]
    if (allPositions.length === 0 || !svgRef) {
      setPanX(0)
      setPanY(0)
      setZoom(1)
      return
    }

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const p of allPositions) {
      const isConnected = l.connected.includes(p)
      const w = isConnected ? DAG_NODE_W : GRID_CARD_W
      const h = isConnected ? DAG_NODE_H : GRID_CARD_H
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + w)
      maxY = Math.max(maxY, p.y + h)
    }

    const contentW = maxX - minX + 80
    const contentH = maxY - minY + 80
    const rect = svgRef.getBoundingClientRect()
    const scaleX = rect.width / contentW
    const scaleY = rect.height / contentH
    const newZoom = Math.min(scaleX, scaleY, 1.5)

    setPanX(-minX * newZoom + 40)
    setPanY(-minY * newZoom + 40)
    setZoom(newZoom)
  }

  // Orthogonal Manhattan-style edge routing
  function edgePath(fromId: string, toId: string): string {
    const from = positionMap().get(fromId)
    const to = positionMap().get(toId)
    if (!from || !to) return ''

    // Edge goes from "from" (dependent, right) to "to" (dependency, left)
    // Visual: draw from RIGHT side of "from" to LEFT side of "to"
    // But since "from" is at higher depth (right) and "to" at lower depth (left),
    // we actually want to draw from the dependency (to) toward the dependent (from)
    // However, the arrow marker-end points at "to", so we keep the direction as-is:
    // Start at right side of from, end at left side of to

    // Determine source and target for routing
    const srcRight = from.x + from.w
    const srcCY = from.y + from.h / 2
    const tgtLeft = to.x
    const tgtCY = to.y + to.h / 2

    const STUB = 20

    if (srcRight < tgtLeft) {
      // Normal case: source is to the left of target (or same position)
      // Route: right stub → vertical → left stub into target
      const midX = (srcRight + tgtLeft) / 2
      if (Math.abs(srcCY - tgtCY) < 1) {
        // Same y — straight horizontal line
        return `M${srcRight},${srcCY} H${tgtLeft}`
      }
      return `M${srcRight},${srcCY} H${midX} V${tgtCY} H${tgtLeft}`
    } else {
      // Back-edge: source is to the right of target
      // Route around: go right, then up/down around, then left into target
      const allPositions = positionMap()
      let minY = Infinity
      let maxY = -Infinity
      for (const [, pos] of allPositions) {
        minY = Math.min(minY, pos.y)
        maxY = Math.max(maxY, pos.y + pos.h)
      }
      // Route above or below depending on which is closer
      const avgY = (srcCY + tgtCY) / 2
      const midGraph = (minY + maxY) / 2
      const routeY = avgY < midGraph ? minY - 30 : maxY + 30
      const exitX = srcRight + STUB
      const enterX = tgtLeft - STUB
      return `M${srcRight},${srcCY} H${exitX} V${routeY} H${enterX} V${tgtCY} H${tgtLeft}`
    }
  }

  // Paginated unconnected nodes
  const paginatedUnconnected = createMemo(() => {
    const all = layout().unconnected
    const start = unconnectedPage() * UNCONNECTED_PAGE_SIZE
    return all.slice(start, start + UNCONNECTED_PAGE_SIZE)
  })

  const totalUnconnectedPages = createMemo(() => Math.ceil(layout().unconnected.length / UNCONNECTED_PAGE_SIZE))

  async function handleCreateIssue() {
    const orgId = createOrgId()
    const title = createTitle()
    if (!orgId || !title) return

    setCreateSubmitting(true)
    try {
      const res = await fetch(`/api/orgs/${orgId}/planning/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body: createBody(), remote: '', projectId: '' })
      })
      if (res.ok) {
        setShowCreateDialog(false)
        setCreateOrgId('')
        setCreateTitle('')
        setCreateBody('')
        await fetchGraph()
      }
    } catch {
      /* network error */
    } finally {
      setCreateSubmitting(false)
    }
  }

  function handleAssignAgent(issueId: string) {
    const node = nodes().find((n) => n.id === issueId)
    if (!node) return
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sovereign:assign-agent', { detail: { ref: node.ref } }))
    }
    setShowAssignDialog(false)
  }

  const kanbanStatuses = ['open', 'in-progress', 'review', 'done', 'blocked'] as const

  return (
    <div
      class="relative flex h-full w-full flex-col overflow-hidden"
      style={{ background: 'var(--c-bg)', 'min-height': '100vh' }}
      data-testid="planning-view"
    >
      {/* Toolbar */}
      <div
        class="flex shrink-0 items-center gap-2 px-4 py-2"
        style={{
          background: 'var(--c-bg-raised, #1e1e2e)',
          'border-bottom': '1px solid var(--c-border, #45475a)'
        }}
        data-testid="planning-toolbar"
      >
        {/* Search */}
        <div class="relative max-w-xs flex-1">
          <span
            class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2"
            style={{ color: 'var(--c-text-muted, #a6adc8)' }}
          >
            <SearchIcon class="h-3 w-3" />
          </span>
          <input
            type="text"
            placeholder="Search issues..."
            class="w-full rounded py-1 pr-2 pl-7 text-xs"
            style={{
              background: 'var(--c-surface, #181825)',
              color: 'var(--c-text, #cdd6f4)',
              border: '1px solid var(--c-border, #45475a)'
            }}
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            data-testid="planning-search"
          />
        </div>

        {/* Filter dropdowns */}
        <For each={FILTER_KEYS}>
          {(filterKey) => (
            <FilterDropdown
              label={filterKey.charAt(0).toUpperCase() + filterKey.slice(1)}
              filterKey={filterKey}
              options={filterOptions()[filterKey] || []}
              selected={filters()[filterKey] || []}
              onToggle={(val) => handleFilterToggle(filterKey, val)}
            />
          )}
        </For>

        <div class="ml-auto flex items-center gap-2">
          {/* Stats */}
          <span class="text-xs opacity-60" style={{ color: 'var(--c-text-muted, #a6adc8)' }}>
            {stats().issueCount} issues, {stats().depCount} deps
            <Show when={stats().draftCount > 0}>, {stats().draftCount} drafts</Show>
          </span>

          {/* Action buttons */}
          <button
            class="rounded px-2 py-1 text-xs font-medium"
            style={{ background: 'var(--c-accent, #89b4fa)', color: 'var(--c-bg, #1e1e2e)' }}
            onClick={() => setShowAssignDialog(true)}
            data-testid="assign-agent-button"
          >
            Assign to Agent
          </button>
          <button
            class="rounded px-2 py-1 text-xs font-medium"
            style={{ background: 'var(--c-success, #22c55e)', color: 'var(--c-bg, #1e1e2e)' }}
            onClick={() => setShowCreateDialog(true)}
            data-testid="create-issue-button"
          >
            + Create Issue
          </button>
        </div>
      </div>

      {/* Filter pills */}
      <Show when={activeFilterPills().length > 0}>
        <div
          class="flex items-center gap-1.5 px-4 py-1.5"
          style={{ 'border-bottom': '1px solid var(--c-border, #45475a)' }}
          data-testid="filter-pills"
        >
          <For each={activeFilterPills()}>
            {(pill) => (
              <span
                class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                style={{ background: 'var(--c-accent, #89b4fa)', color: 'var(--c-bg, #1e1e2e)' }}
                data-testid={`filter-pill-${pill.key}-${pill.value}`}
              >
                {pill.key}: {pill.value}
                <button class="ml-0.5 font-bold" onClick={() => removeFilterValue(pill.key, pill.value)}>
                  x
                </button>
              </span>
            )}
          </For>
          <button
            class="ml-2 text-xs opacity-60 hover:opacity-100"
            style={{ color: 'var(--c-text, #cdd6f4)' }}
            onClick={() => clearFilters()}
            data-testid="clear-filters"
          >
            Clear all
          </button>
        </div>
      </Show>

      {/* Content area */}
      <div class="relative flex-1 overflow-hidden">
        {/* DAG View */}
        <Show when={viewMode() === 'dag'}>
          <div class="flex h-full">
            <div class="relative flex-1 overflow-hidden">
              {/* Zoom controls */}
              <div class="absolute top-3 right-3 z-10 flex flex-col gap-1">
                <button
                  class="flex h-7 w-7 items-center justify-center rounded text-xs font-bold"
                  style={{
                    background: 'var(--c-bg-raised, #1e1e2e)',
                    color: 'var(--c-text, #cdd6f4)',
                    border: '1px solid var(--c-border, #45475a)'
                  }}
                  onClick={() => setZoom(Math.min(3, zoom() * 1.2))}
                  title="Zoom in"
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  class="flex h-7 w-7 items-center justify-center rounded text-xs font-bold"
                  style={{
                    background: 'var(--c-bg-raised, #1e1e2e)',
                    color: 'var(--c-text, #cdd6f4)',
                    border: '1px solid var(--c-border, #45475a)'
                  }}
                  onClick={() => setZoom(Math.max(0.1, zoom() * 0.8))}
                  title="Zoom out"
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  class="flex h-7 w-7 items-center justify-center rounded text-[10px] font-bold"
                  style={{
                    background: 'var(--c-bg-raised, #1e1e2e)',
                    color: 'var(--c-text, #cdd6f4)',
                    border: '1px solid var(--c-border, #45475a)'
                  }}
                  onClick={resetZoom}
                  title="Fit to view"
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                  </svg>
                </button>
                <span class="mt-1 text-center text-[10px] opacity-50" style={{ color: 'var(--c-text-muted)' }}>
                  {Math.round(zoom() * 100)}%
                </span>
              </div>

              <svg
                ref={svgRef}
                class="h-full w-full"
                style={{ cursor: isPanning() ? 'grabbing' : 'grab' }}
                data-testid="dag-svg"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
              >
                <defs>
                  <marker
                    id="arrow"
                    viewBox="0 0 10 10"
                    refX="10"
                    refY="5"
                    markerWidth="8"
                    markerHeight="8"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--c-border, #45475a)" />
                  </marker>
                  <marker
                    id="arrow-amber"
                    viewBox="0 0 10 10"
                    refX="10"
                    refY="5"
                    markerWidth="8"
                    markerHeight="8"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#D97706" />
                  </marker>
                  <marker
                    id="arrow-highlight"
                    viewBox="0 0 10 10"
                    refX="10"
                    refY="5"
                    markerWidth="8"
                    markerHeight="8"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--c-accent, #89b4fa)" />
                  </marker>
                  <filter id="shadow" x="-10%" y="-10%" width="130%" height="130%">
                    <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.3)" flood-opacity="0.5" />
                  </filter>
                </defs>

                <g
                  style={{
                    transform: `translate(${panX()}px, ${panY()}px) scale(${zoom()})`,
                    'transform-origin': '0 0'
                  }}
                >
                  {/* Section label for connected DAG */}
                  <Show when={layout().connected.length > 0}>
                    <text
                      x="40"
                      y="24"
                      fill="var(--c-text-muted, #a6adc8)"
                      font-size="11"
                      font-weight="600"
                      opacity="0.5"
                    >
                      DEPENDENCY GRAPH
                    </text>
                  </Show>

                  {/* Edges — orthogonal Manhattan routing */}
                  <For each={filteredEdges()}>
                    {(edge) => {
                      const path = () => edgePath(edge.to, edge.from)
                      const edgeKey = () => `${edge.from}->${edge.to}`
                      const isHighlighted = () => connectedEdgeIds().has(edgeKey())
                      return (
                        <Show when={path()}>
                          <path
                            d={path()}
                            fill="none"
                            stroke={
                              isHighlighted()
                                ? 'var(--c-accent, #89b4fa)'
                                : edge.crossWorkspace
                                  ? '#D97706'
                                  : 'var(--c-border, #45475a)'
                            }
                            stroke-width={isHighlighted() ? 3 : 2}
                            stroke-linejoin="round"
                            stroke-dasharray={edge.crossWorkspace ? '6,4' : 'none'}
                            opacity={hoveredNodeId() && !isHighlighted() ? 0.15 : 0.9}
                            marker-end={
                              isHighlighted()
                                ? 'url(#arrow-highlight)'
                                : edge.crossWorkspace
                                  ? 'url(#arrow-amber)'
                                  : 'url(#arrow)'
                            }
                            data-testid={`edge-${edge.from}-${edge.to}`}
                            style={{ transition: 'opacity 0.15s, stroke-width 0.15s' }}
                          />
                        </Show>
                      )
                    }}
                  </For>

                  {/* Connected nodes */}
                  <For each={layout().connected}>
                    {({ node, x, y }) => {
                      const isHovered = () => hoveredNodeId() === node.id
                      const isSelected = () => selectedNodeId() === node.id
                      const isConnectedToHovered = () => connectedEdgeIds().has(node.id)
                      const dimmed = () => hoveredNodeId() !== null && !isHovered() && !isConnectedToHovered()
                      return (
                        <g
                          transform={`translate(${x}, ${y})`}
                          onClick={() => handleNodeClick(node)}
                          onMouseEnter={() => setHoveredNodeId(node.id)}
                          onMouseLeave={() => setHoveredNodeId(null)}
                          style={{
                            cursor: 'pointer',
                            transition: 'opacity 0.15s, transform 0.15s',
                            opacity: dimmed() ? 0.35 : 1
                          }}
                          data-testid={`dag-node-${node.id}`}
                        >
                          <g
                            style={{
                              transform: isHovered() ? 'scale(1.03)' : 'scale(1)',
                              'transform-origin': `${DAG_NODE_W / 2}px ${DAG_NODE_H / 2}px`,
                              transition: 'transform 0.15s'
                            }}
                          >
                            <rect
                              width={DAG_NODE_W}
                              height={DAG_NODE_H}
                              rx={8}
                              fill="var(--c-surface, #181825)"
                              stroke={
                                isSelected()
                                  ? 'var(--c-accent, #89b4fa)'
                                  : node.isDraft
                                    ? '#f59e0b'
                                    : isHovered()
                                      ? 'var(--c-accent, #89b4fa)'
                                      : 'var(--c-border, #45475a)'
                              }
                              stroke-width={isSelected() ? 3 : node.isCriticalPath ? 2.5 : isHovered() ? 2 : 1}
                              stroke-dasharray={node.isDraft ? '6,3' : 'none'}
                              filter="url(#shadow)"
                            />
                            {/* Workspace color strip */}
                            <rect
                              x={0}
                              y={0}
                              width={4}
                              height={DAG_NODE_H}
                              rx={2}
                              fill={getWorkspaceColor(node.workspace, allWorkspaces())}
                            />
                            {/* Status dot */}
                            <circle cx={DAG_NODE_W - 14} cy={14} r={4} fill={getStatusColor(node.status)} />
                            {/* PR icon */}
                            <Show when={node.kind === 'pr'}>
                              <g transform={`translate(${DAG_NODE_W - 30}, 8)`}>
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="var(--c-text-muted, #a6adc8)">
                                  <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 9.5a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm7.5-9.5a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM4.25 1A2.25 2.25 0 0 0 2 3.25v9.5A2.25 2.25 0 0 0 4.25 15a2.25 2.25 0 0 0 2.25-2.25V3.25A2.25 2.25 0 0 0 4.25 1Zm7.5 0A2.25 2.25 0 0 0 9.5 3.25v2.122a.75.75 0 0 0 1.5 0V3.25a.75.75 0 0 1 1.5 0v2.122a.75.75 0 0 0 1.5 0V3.25A2.25 2.25 0 0 0 11.75 1Z" />
                                </svg>
                              </g>
                            </Show>
                            {/* Title */}
                            <text x={14} y={24} fill="var(--c-text-heading, #cdd6f4)" font-size="12" font-weight="600">
                              <title>{node.title}</title>
                              {node.title.length > 26 ? node.title.slice(0, 26) + '...' : node.title}
                            </text>
                            {/* Subtitle */}
                            <text x={14} y={42} fill="var(--c-text-muted, #a6adc8)" font-size="10">
                              {node.workspaceName} / {node.projectName}
                            </text>
                            {/* Status label + draft badge */}
                            <text x={14} y={58} fill={getStatusColor(node.status)} font-size="9">
                              {getStatusLabel(node.status)}
                            </text>
                            <Show when={node.isDraft}>
                              <rect
                                x={DAG_NODE_W - 46}
                                y={46}
                                width={36}
                                height={16}
                                rx={3}
                                fill="#f59e0b"
                                opacity="0.9"
                              />
                              <text
                                x={DAG_NODE_W - 28}
                                y={58}
                                text-anchor="middle"
                                font-size="8"
                                fill="#000"
                                font-weight="700"
                              >
                                DRAFT
                              </text>
                            </Show>
                          </g>
                        </g>
                      )
                    }}
                  </For>

                  {/* Separator line between DAG and grid */}
                  <Show when={layout().connected.length > 0 && layout().unconnected.length > 0}>
                    <line
                      x1={20}
                      y1={layout().connectedBounds.h + 30}
                      x2={1000}
                      y2={layout().connectedBounds.h + 30}
                      stroke="var(--c-border, #45475a)"
                      stroke-width={0.5}
                      stroke-dasharray="4,4"
                      opacity="0.4"
                    />
                    <text
                      x={40}
                      y={layout().connectedBounds.h + 50}
                      fill="var(--c-text-muted, #a6adc8)"
                      font-size="11"
                      font-weight="600"
                      opacity="0.5"
                    >
                      UNCONNECTED ({layout().unconnected.length})
                    </text>
                  </Show>

                  {/* Unconnected nodes — compact cards */}
                  <For each={paginatedUnconnected()}>
                    {({ node, x, y }) => {
                      const isHovered = () => hoveredNodeId() === node.id
                      return (
                        <g
                          transform={`translate(${x}, ${y})`}
                          onClick={() => handleNodeClick(node)}
                          onMouseEnter={() => setHoveredNodeId(node.id)}
                          onMouseLeave={() => setHoveredNodeId(null)}
                          style={{ cursor: 'pointer' }}
                          data-testid={`dag-node-${node.id}`}
                        >
                          <rect
                            width={GRID_CARD_W}
                            height={GRID_CARD_H}
                            rx={6}
                            fill="var(--c-surface, #181825)"
                            stroke={
                              isHovered()
                                ? 'var(--c-accent, #89b4fa)'
                                : node.isDraft
                                  ? '#f59e0b'
                                  : 'var(--c-border, #45475a)'
                            }
                            stroke-width={isHovered() ? 1.5 : 0.5}
                            stroke-dasharray={node.isDraft ? '4,2' : 'none'}
                            opacity={0.85}
                          />
                          <rect
                            x={0}
                            y={0}
                            width={3}
                            height={GRID_CARD_H}
                            rx={1.5}
                            fill={getWorkspaceColor(node.workspace, allWorkspaces())}
                          />
                          <circle cx={GRID_CARD_W - 10} cy={10} r={3} fill={getStatusColor(node.status)} />
                          <text x={10} y={20} fill="var(--c-text-heading, #cdd6f4)" font-size="10" font-weight="500">
                            <title>{node.title}</title>
                            {node.title.length > 22 ? node.title.slice(0, 22) + '...' : node.title}
                          </text>
                          <text x={10} y={36} fill="var(--c-text-muted, #a6adc8)" font-size="8">
                            {node.projectName}
                          </text>
                          <Show when={node.isDraft}>
                            <text
                              x={GRID_CARD_W - 8}
                              y={44}
                              text-anchor="end"
                              font-size="7"
                              fill="#f59e0b"
                              font-weight="600"
                            >
                              DRAFT
                            </text>
                          </Show>
                        </g>
                      )
                    }}
                  </For>
                </g>
              </svg>

              {/* Pagination for unconnected */}
              <Show when={totalUnconnectedPages() > 1}>
                <div
                  class="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg px-3 py-1.5"
                  style={{
                    background: 'var(--c-bg-raised, #1e1e2e)',
                    border: '1px solid var(--c-border, #45475a)'
                  }}
                >
                  <button
                    class="text-xs"
                    style={{ color: 'var(--c-text, #cdd6f4)' }}
                    disabled={unconnectedPage() === 0}
                    onClick={() => setUnconnectedPage((p) => Math.max(0, p - 1))}
                  >
                    Prev
                  </button>
                  <span class="text-xs opacity-60" style={{ color: 'var(--c-text-muted)' }}>
                    {unconnectedPage() + 1} / {totalUnconnectedPages()}
                  </span>
                  <button
                    class="text-xs"
                    style={{ color: 'var(--c-text, #cdd6f4)' }}
                    disabled={unconnectedPage() >= totalUnconnectedPages() - 1}
                    onClick={() => setUnconnectedPage((p) => Math.min(totalUnconnectedPages() - 1, p + 1))}
                  >
                    Next
                  </button>
                </div>
              </Show>
            </div>

            {/* Detail Drawer */}
            <Show when={selectedNode()}>
              {(node) => {
                const getPriorityLabel = (p: string) => p.charAt(0).toUpperCase() + p.slice(1)
                return (
                  <div
                    style={{
                      width: '320px',
                      'min-width': '320px',
                      'border-left': '1px solid var(--c-border, #45475a)',
                      background: 'var(--c-bg-raised, #1e1e2e)',
                      'overflow-y': 'auto'
                    }}
                  >
                    <div style={{ padding: '12px' }}>
                      {/* Close button */}
                      <div class="flex items-center justify-between" style={{ 'margin-bottom': '12px' }}>
                        <span class="text-xs" style={{ color: 'var(--c-text-muted, #a6adc8)' }}>
                          {node().ref.projectId}#{node().ref.issueId}
                        </span>
                        <button
                          class="hover:opacity-80"
                          style={{
                            color: 'var(--c-text-muted, #a6adc8)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            'font-size': '16px',
                            'line-height': '1'
                          }}
                          onClick={() => {
                            setSelectedNodeId(null)
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
                          color: 'var(--c-text, #cdd6f4)',
                          'font-size': '14px',
                          'font-weight': '600',
                          margin: '0 0 8px 0',
                          'line-height': '1.3'
                        }}
                      >
                        {node().title}
                      </h3>

                      {/* Status badge */}
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          'border-radius': '9999px',
                          'font-size': '11px',
                          'font-weight': '500',
                          color: '#fff',
                          background: getStatusColor(node().status),
                          'margin-bottom': '10px'
                        }}
                      >
                        {getStatusLabel(node().status)}
                      </span>

                      {/* Priority */}
                      <div style={{ 'margin-bottom': '10px' }} class="flex items-center gap-1">
                        <PriorityIcon priority={node().priority} />
                        <span style={{ color: 'var(--c-text, #cdd6f4)', 'font-size': '11px' }}>
                          {getPriorityLabel(node().priority)}
                        </span>
                      </div>

                      {/* Workspace / Project */}
                      <div style={{ 'margin-bottom': '10px' }}>
                        <div
                          style={{
                            color: 'var(--c-text-muted, #a6adc8)',
                            'font-size': '10px',
                            'text-transform': 'uppercase',
                            'letter-spacing': '0.05em',
                            'margin-bottom': '4px'
                          }}
                        >
                          Location
                        </div>
                        <div class="flex items-center gap-1">
                          <span
                            class="inline-block h-2 w-2 rounded-full"
                            style={{ background: getWorkspaceColor(node().workspace, allWorkspaces()) }}
                          />
                          <span style={{ color: 'var(--c-text, #cdd6f4)', 'font-size': '12px' }}>
                            {node().workspaceName} / {node().projectName}
                          </span>
                        </div>
                      </div>

                      {/* Labels */}
                      <Show when={node().labels.length > 0}>
                        <div style={{ 'margin-bottom': '10px' }}>
                          <div
                            style={{
                              color: 'var(--c-text-muted, #a6adc8)',
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
                                    background: 'var(--c-surface, #181825)',
                                    color: 'var(--c-text, #cdd6f4)',
                                    border: '1px solid var(--c-border, #45475a)'
                                  }}
                                >
                                  {label}
                                </span>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      {/* Assignee */}
                      <Show when={node().assignee}>
                        <div style={{ 'margin-bottom': '10px' }}>
                          <div
                            style={{
                              color: 'var(--c-text-muted, #a6adc8)',
                              'font-size': '10px',
                              'text-transform': 'uppercase',
                              'letter-spacing': '0.05em',
                              'margin-bottom': '4px'
                            }}
                          >
                            Assignee
                          </div>
                          <span
                            style={{
                              padding: '1px 6px',
                              'border-radius': '4px',
                              'font-size': '11px',
                              background: 'var(--c-surface, #181825)',
                              color: 'var(--c-text, #cdd6f4)',
                              border: '1px solid var(--c-border, #45475a)'
                            }}
                          >
                            {node().assignee}
                          </span>
                        </div>
                      </Show>

                      {/* Upstream dependencies */}
                      <div
                        style={{
                          'margin-top': '16px',
                          'border-top': '1px solid var(--c-border, #45475a)',
                          'padding-top': '12px'
                        }}
                      >
                        <div
                          style={{
                            color: 'var(--c-text-muted, #a6adc8)',
                            'font-size': '10px',
                            'text-transform': 'uppercase',
                            'letter-spacing': '0.05em',
                            'margin-bottom': '6px'
                          }}
                        >
                          Depends on ({upstreamDeps().length})
                        </div>
                        <For each={upstreamDeps()}>
                          {(dep) => (
                            <div
                              class="flex items-center justify-between"
                              style={{ padding: '4px 0', 'font-size': '12px' }}
                            >
                              <div style={{ 'min-width': '0', flex: '1' }}>
                                <div
                                  style={{
                                    color: 'var(--c-text, #cdd6f4)',
                                    'white-space': 'nowrap',
                                    overflow: 'hidden',
                                    'text-overflow': 'ellipsis'
                                  }}
                                >
                                  {dep.title}
                                </div>
                                <div style={{ color: 'var(--c-text-muted, #a6adc8)', 'font-size': '10px' }}>
                                  {dep.ref.projectId}#{dep.ref.issueId}
                                </div>
                              </div>
                              <button
                                style={{
                                  color: 'var(--c-error, #ef4444)',
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  'font-size': '14px',
                                  padding: '0 4px',
                                  'flex-shrink': '0'
                                }}
                                disabled={depLoading()}
                                onClick={() => removeDependency(node().ref, dep.ref)}
                                title="Remove dependency"
                              >
                                ✕
                              </button>
                            </div>
                          )}
                        </For>
                        <Show when={!showAddUpstream()}>
                          <button
                            style={{
                              color: 'var(--c-accent, #89b4fa)',
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
                              border: '1px solid var(--c-border, #45475a)',
                              'border-radius': '4px',
                              'margin-top': '4px'
                            }}
                          >
                            <For
                              each={availableUpstream()}
                              fallback={
                                <div
                                  style={{ padding: '6px', 'font-size': '11px', color: 'var(--c-text-muted, #a6adc8)' }}
                                >
                                  No available nodes
                                </div>
                              }
                            >
                              {(n) => (
                                <div
                                  style={{
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    'font-size': '11px',
                                    'border-bottom': '1px solid var(--c-border, #45475a)'
                                  }}
                                  class="hover:opacity-80"
                                  onClick={() => addDependency(node().ref, n.ref, 'depends_on')}
                                >
                                  <div style={{ color: 'var(--c-text, #cdd6f4)' }}>{n.title}</div>
                                  <div style={{ color: 'var(--c-text-muted, #a6adc8)', 'font-size': '10px' }}>
                                    {n.ref.projectId}#{n.ref.issueId}
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>

                      {/* Downstream dependents */}
                      <div
                        style={{
                          'margin-top': '16px',
                          'border-top': '1px solid var(--c-border, #45475a)',
                          'padding-top': '12px'
                        }}
                      >
                        <div
                          style={{
                            color: 'var(--c-text-muted, #a6adc8)',
                            'font-size': '10px',
                            'text-transform': 'uppercase',
                            'letter-spacing': '0.05em',
                            'margin-bottom': '6px'
                          }}
                        >
                          Blocks ({downstreamDeps().length})
                        </div>
                        <For each={downstreamDeps()}>
                          {(dep) => (
                            <div
                              class="flex items-center justify-between"
                              style={{ padding: '4px 0', 'font-size': '12px' }}
                            >
                              <div style={{ 'min-width': '0', flex: '1' }}>
                                <div
                                  style={{
                                    color: 'var(--c-text, #cdd6f4)',
                                    'white-space': 'nowrap',
                                    overflow: 'hidden',
                                    'text-overflow': 'ellipsis'
                                  }}
                                >
                                  {dep.title}
                                </div>
                                <div style={{ color: 'var(--c-text-muted, #a6adc8)', 'font-size': '10px' }}>
                                  {dep.ref.projectId}#{dep.ref.issueId}
                                </div>
                              </div>
                              <button
                                style={{
                                  color: 'var(--c-error, #ef4444)',
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  'font-size': '14px',
                                  padding: '0 4px',
                                  'flex-shrink': '0'
                                }}
                                disabled={depLoading()}
                                onClick={() => removeDependency(dep.ref, node().ref)}
                                title="Remove dependent"
                              >
                                ✕
                              </button>
                            </div>
                          )}
                        </For>
                        <Show when={!showAddDownstream()}>
                          <button
                            style={{
                              color: 'var(--c-accent, #89b4fa)',
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
                              border: '1px solid var(--c-border, #45475a)',
                              'border-radius': '4px',
                              'margin-top': '4px'
                            }}
                          >
                            <For
                              each={availableDownstream()}
                              fallback={
                                <div
                                  style={{ padding: '6px', 'font-size': '11px', color: 'var(--c-text-muted, #a6adc8)' }}
                                >
                                  No available nodes
                                </div>
                              }
                            >
                              {(n) => (
                                <div
                                  style={{
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    'font-size': '11px',
                                    'border-bottom': '1px solid var(--c-border, #45475a)'
                                  }}
                                  class="hover:opacity-80"
                                  onClick={() => addDependency(n.ref, node().ref, 'depends_on')}
                                >
                                  <div style={{ color: 'var(--c-text, #cdd6f4)' }}>{n.title}</div>
                                  <div style={{ color: 'var(--c-text-muted, #a6adc8)', 'font-size': '10px' }}>
                                    {n.ref.projectId}#{n.ref.issueId}
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>

                      {/* Open full detail */}
                      <div
                        style={{
                          'margin-top': '16px',
                          'border-top': '1px solid var(--c-border, #45475a)',
                          'padding-top': '12px'
                        }}
                      >
                        <button
                          style={{
                            color: 'var(--c-accent, #89b4fa)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            'font-size': '11px',
                            padding: '0'
                          }}
                          onClick={() => {
                            if (typeof window !== 'undefined') {
                              window.dispatchEvent(
                                new CustomEvent('sovereign:navigate', {
                                  detail: { view: 'workspace', orgId: node().workspace, entityId: node().id }
                                })
                              )
                            }
                          }}
                        >
                          Open full detail →
                        </button>
                      </div>
                    </div>
                  </div>
                )
              }}
            </Show>
          </div>
        </Show>

        {/* Kanban View */}
        <Show when={viewMode() === 'kanban'}>
          <div class="flex h-full gap-4 overflow-x-auto p-4" data-testid="kanban-board">
            <For each={kanbanStatuses}>
              {(status) => {
                const columnNodes = createMemo(() => filteredNodes().filter((n) => n.status === status))
                return (
                  <div
                    class="flex w-72 flex-shrink-0 flex-col overflow-hidden rounded-lg"
                    style={{
                      background: 'var(--c-bg-raised, #1e1e2e)',
                      border: '1px solid var(--c-border, #45475a)'
                    }}
                    data-testid={`kanban-column-${status}`}
                  >
                    <div
                      class="flex items-center gap-2 p-3"
                      style={{ 'border-bottom': '1px solid var(--c-border, #45475a)' }}
                    >
                      <span class="h-2 w-2 rounded-full" style={{ background: getStatusColor(status) }} />
                      <span class="text-sm font-semibold" style={{ color: 'var(--c-text-heading, #cdd6f4)' }}>
                        {getStatusLabel(status)}
                      </span>
                      <span class="ml-auto text-xs opacity-50" style={{ color: 'var(--c-text-muted)' }}>
                        {columnNodes().length}
                      </span>
                    </div>
                    <div class="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                      <For each={columnNodes()}>
                        {(node) => (
                          <div
                            class="cursor-pointer rounded p-2.5 hover:opacity-90"
                            style={{
                              background: node.isDraft ? 'rgba(245, 158, 11, 0.08)' : 'var(--c-surface, #181825)',
                              'border-left': `3px solid ${node.isDraft ? '#f59e0b' : getWorkspaceColor(node.workspace, allWorkspaces())}`,
                              border: node.isDraft ? '1px dashed #f59e0b' : 'none',
                              'border-left-width': '3px',
                              'border-left-style': 'solid'
                            }}
                            onClick={() => handleNodeClick(node)}
                            data-testid={`kanban-card-${node.id}`}
                          >
                            <div class="flex items-center gap-1">
                              <div
                                class="flex-1 text-xs font-medium"
                                style={{ color: 'var(--c-text-heading, #cdd6f4)' }}
                              >
                                {node.title}
                              </div>
                              <Show when={node.isDraft}>
                                <span
                                  class="rounded px-1 py-0.5 text-[9px] font-semibold"
                                  style={{ background: '#f59e0b', color: '#000' }}
                                >
                                  DRAFT
                                </span>
                              </Show>
                            </div>
                            <div class="mt-1 text-xs opacity-60" style={{ color: 'var(--c-text-muted)' }}>
                              {node.workspaceName} / {node.projectName}
                            </div>
                            <div class="mt-1.5 flex items-center gap-1">
                              <PriorityIcon priority={node.priority} />
                              <Show when={node.assignee}>
                                <span class="text-xs opacity-50" style={{ color: 'var(--c-text-muted)' }}>
                                  {node.assignee}
                                </span>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        {/* List View */}
        <Show when={viewMode() === 'list'}>
          <div class="overflow-auto p-4" data-testid="list-view">
            <table class="w-full text-xs" style={{ color: 'var(--c-text, #cdd6f4)' }}>
              <thead>
                <tr style={{ 'border-bottom': '1px solid var(--c-border, #45475a)' }}>
                  <th class="p-2 text-left font-medium">Title</th>
                  <th class="p-2 text-left font-medium">Workspace</th>
                  <th class="p-2 text-left font-medium">Project</th>
                  <th class="p-2 text-left font-medium">Status</th>
                  <th class="p-2 text-left font-medium">Assignee</th>
                  <th class="p-2 text-left font-medium">Priority</th>
                  <th class="p-2 text-left font-medium">Deps</th>
                </tr>
              </thead>
              <tbody>
                <For each={filteredNodes()}>
                  {(node) => (
                    <tr
                      class="cursor-pointer hover:opacity-80"
                      style={{ 'border-bottom': '1px solid var(--c-border, #45475a)' }}
                      onClick={() => handleNodeClick(node)}
                      data-testid={`list-row-${node.id}`}
                    >
                      <td class="p-2 font-medium">
                        <span class="flex items-center gap-1.5">
                          {node.title}
                          <Show when={node.isDraft}>
                            <span
                              class="rounded px-1 py-0.5 text-[9px] font-semibold"
                              style={{ background: '#f59e0b', color: '#000' }}
                            >
                              DRAFT
                            </span>
                          </Show>
                        </span>
                      </td>
                      <td class="p-2">
                        <span
                          class="mr-1 inline-block h-2 w-2 rounded-full"
                          style={{ background: getWorkspaceColor(node.workspace, allWorkspaces()) }}
                        />
                        {node.workspaceName}
                      </td>
                      <td class="p-2">{node.projectName}</td>
                      <td class="p-2">
                        <span style={{ color: getStatusColor(node.status) }}>{getStatusLabel(node.status)}</span>
                      </td>
                      <td class="p-2">{node.assignee || '--'}</td>
                      <td class="p-2">
                        <span class="flex items-center gap-1">
                          <PriorityIcon priority={node.priority} />
                          {node.priority}
                        </span>
                      </td>
                      <td class="p-2">{node.dependencies.length}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        {/* Tree View */}
        <Show when={viewMode() === 'tree'}>
          <div class="overflow-auto p-4" data-testid="tree-view">
            <For each={allWorkspaces()}>
              {(ws) => {
                const wsNodes = createMemo(() => filteredNodes().filter((n) => n.workspace === ws))
                const wsName = () => orgs().find((o) => o.id === ws)?.name || ws
                return (
                  <Show when={wsNodes().length > 0}>
                    <details open class="mb-3" data-testid={`tree-workspace-${ws}`}>
                      <summary
                        class="cursor-pointer rounded p-2 text-sm font-semibold"
                        style={{
                          color: getWorkspaceColor(ws, allWorkspaces()),
                          background: 'var(--c-bg-raised, #1e1e2e)'
                        }}
                      >
                        {wsName()} ({wsNodes().length})
                      </summary>
                      <div class="mt-1 ml-4 flex flex-col gap-1">
                        <For each={wsNodes()}>
                          {(node) => (
                            <div
                              class="flex cursor-pointer items-center gap-2 rounded p-2 text-xs hover:opacity-80"
                              style={{
                                background: node.isDraft ? 'rgba(245, 158, 11, 0.08)' : 'var(--c-surface, #181825)',
                                color: 'var(--c-text, #cdd6f4)',
                                border: node.isDraft ? '1px dashed #f59e0b' : 'none'
                              }}
                              onClick={() => handleNodeClick(node)}
                              data-testid={`tree-node-${node.id}`}
                            >
                              <span style={{ color: getStatusColor(node.status) }}>&#x25CF;</span>
                              <span class="font-medium">{node.title}</span>
                              <Show when={node.isDraft}>
                                <span
                                  class="rounded px-1 py-0.5 text-[9px] font-semibold"
                                  style={{ background: '#f59e0b', color: '#000' }}
                                >
                                  DRAFT
                                </span>
                              </Show>
                              <span class="ml-auto opacity-50">{node.projectName}</span>
                              <PriorityIcon priority={node.priority} />
                            </div>
                          )}
                        </For>
                      </div>
                    </details>
                  </Show>
                )
              }}
            </For>
          </div>
        </Show>
      </div>

      {/* Create Issue Dialog */}
      <Show when={showCreateDialog()}>
        <div
          class="absolute inset-0 z-30 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          data-testid="create-issue-dialog"
        >
          <div
            class="flex w-96 flex-col gap-3 rounded-lg p-6"
            style={{ background: 'var(--c-bg-raised, #1e1e2e)', border: '1px solid var(--c-border, #45475a)' }}
          >
            <h3 class="text-sm font-semibold" style={{ color: 'var(--c-text-heading, #cdd6f4)' }}>
              Create Issue
            </h3>
            <select
              class="rounded px-2 py-1.5 text-xs"
              style={{ background: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
              value={createOrgId()}
              onChange={(e) => setCreateOrgId(e.currentTarget.value)}
              data-testid="create-issue-workspace"
            >
              <option value="">Select workspace</option>
              <For each={orgs()}>{(o) => <option value={o.id}>{o.name}</option>}</For>
            </select>
            <input
              type="text"
              placeholder="Title"
              class="rounded px-2 py-1.5 text-xs"
              style={{ background: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
              value={createTitle()}
              onInput={(e) => setCreateTitle(e.currentTarget.value)}
              data-testid="create-issue-title"
            />
            <textarea
              placeholder="Description"
              class="h-20 resize-none rounded px-2 py-1.5 text-xs"
              style={{ background: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
              value={createBody()}
              onInput={(e) => setCreateBody(e.currentTarget.value)}
              data-testid="create-issue-description"
            />
            <div class="flex justify-end gap-2">
              <button
                class="rounded px-3 py-1 text-xs"
                style={{ color: 'var(--c-text)' }}
                onClick={() => setShowCreateDialog(false)}
              >
                Cancel
              </button>
              <button
                class="rounded px-3 py-1 text-xs font-medium"
                style={{ background: 'var(--c-success)', color: 'var(--c-bg)' }}
                disabled={createSubmitting() || !createOrgId() || !createTitle()}
                onClick={handleCreateIssue}
                data-testid="create-issue-submit"
              >
                {createSubmitting() ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Assign to Agent Dialog */}
      <Show when={showAssignDialog()}>
        <div
          class="absolute inset-0 z-30 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          data-testid="assign-agent-dialog"
        >
          <div
            class="flex w-96 flex-col gap-3 rounded-lg p-6"
            style={{ background: 'var(--c-bg-raised, #1e1e2e)', border: '1px solid var(--c-border, #45475a)' }}
          >
            <h3 class="text-sm font-semibold" style={{ color: 'var(--c-text-heading, #cdd6f4)' }}>
              Assign to Agent
            </h3>
            <select
              class="rounded px-2 py-1.5 text-xs"
              style={{ background: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
              data-testid="assign-issue-select"
              onChange={(e) => {
                if (e.currentTarget.value) handleAssignAgent(e.currentTarget.value)
              }}
            >
              <option value="">Select issue</option>
              <For each={nodes().filter((n) => n.status !== 'done')}>
                {(n) => <option value={n.id}>{n.title}</option>}
              </For>
            </select>
            <div class="flex justify-end gap-2">
              <button
                class="rounded px-3 py-1 text-xs"
                style={{ color: 'var(--c-text)' }}
                onClick={() => setShowAssignDialog(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default GlobalPlanningView

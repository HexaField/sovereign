import { type Component, createSignal, onMount, For, Show, createMemo } from 'solid-js'
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

// Types
export interface PlanningNode {
  id: string
  title: string
  body?: string
  workspace: string
  workspaceName: string
  project: string
  status: 'open' | 'in-progress' | 'review' | 'done' | 'blocked'
  assignee?: string
  labels: string[]
  priority: 'low' | 'medium' | 'high' | 'critical'
  dependencies: string[]
  isCriticalPath: boolean
  depth: number
}

export interface PlanningEdge {
  from: string
  to: string
  crossWorkspace: boolean
}

// Status colors
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

export function getPriorityIcon(priority: PlanningNode['priority']): string {
  switch (priority) {
    case 'critical':
      return '🔴'
    case 'high':
      return '🟠'
    case 'medium':
      return '🟡'
    case 'low':
      return '🟢'
  }
}

// Workspace color palette
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
  return WORKSPACE_COLORS[idx % WORKSPACE_COLORS.length]
}

// View mode labels/icons
export const VIEW_MODES: Array<{ key: PlanningViewMode; label: string; icon: string }> = [
  { key: 'dag', label: 'DAG', icon: '🔗' },
  { key: 'kanban', label: 'Kanban', icon: '📋' },
  { key: 'list', label: 'List', icon: '📃' },
  { key: 'tree', label: 'Tree', icon: '🌳' }
]

// Filter keys
export const FILTER_KEYS = ['workspace', 'project', 'status', 'assignee', 'label', 'priority'] as const

// DAG layout helper: position nodes by depth
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

const GlobalPlanningView: Component = () => {
  const [nodes, setNodes] = createSignal<PlanningNode[]>([])
  const [edges, setEdges] = createSignal<PlanningEdge[]>([])
  const [orgs, setOrgs] = createSignal<Array<{ id: string; name: string }>>([])
  const [showCreateDialog, setShowCreateDialog] = createSignal(false)
  const [showAssignDialog, setShowAssignDialog] = createSignal(false)
  const [svgZoom, _setSvgZoom] = createSignal(1)
  const [svgPanX, _setSvgPanX] = createSignal(0)
  const [svgPanY, _setSvgPanY] = createSignal(0)

  // Fetch planning data
  onMount(async () => {
    // §7.5 — Default to list view on mobile
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setViewMode('list')
    }
    try {
      const orgsRes = await fetch('/api/orgs')
      if (!orgsRes.ok) return
      const orgsData = await orgsRes.json()
      const orgList = (orgsData.orgs || orgsData || []).map((o: any) => ({
        id: o.id || o.orgId,
        name: o.name || o.id
      }))
      setOrgs(orgList)

      const allNodes: PlanningNode[] = []
      const allEdges: PlanningEdge[] = []

      for (const org of orgList) {
        try {
          const res = await fetch(`/api/orgs/${org.id}/planning/graph`)
          if (!res.ok) continue
          const graph = await res.json()
          for (const n of graph.nodes || []) {
            allNodes.push({
              id: n.id,
              title: n.title || n.id,
              body: n.body,
              workspace: org.id,
              workspaceName: org.name,
              project: n.project || '',
              status: n.status || 'open',
              assignee: n.assignee,
              labels: n.labels || [],
              priority: n.priority || 'medium',
              dependencies: n.dependencies || [],
              isCriticalPath: !!n.isCriticalPath,
              depth: n.depth ?? 0
            })
          }
          for (const e of graph.edges || []) {
            allEdges.push({
              from: e.from,
              to: e.to,
              crossWorkspace: !!e.crossWorkspace
            })
          }
        } catch {
          /* skip */
        }
      }

      setNodes(allNodes)
      setEdges(allEdges)
    } catch {
      /* network error */
    }
  })

  const allWorkspaces = createMemo(() => [...new Set(nodes().map((n) => n.workspace))])

  // Apply filters + search
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

  // Active filter pills
  const activeFilterPills = createMemo(() => {
    const f = filters()
    const pills: Array<{ key: string; value: string }> = []
    for (const [key, values] of Object.entries(f)) {
      for (const v of values) {
        pills.push({ key, value: v })
      }
    }
    return pills
  })

  function handleNodeClick(node: PlanningNode) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('sovereign:navigate', {
          detail: { view: 'workspace', orgId: node.workspace, entityId: node.id }
        })
      )
    }
  }

  // Kanban columns
  const kanbanStatuses = ['open', 'in-progress', 'review', 'done', 'blocked'] as const

  return (
    <div
      class="relative flex h-full w-full flex-col overflow-hidden"
      style={{ background: 'var(--c-bg)', 'min-height': '100vh' }}
      data-testid="planning-view"
    >
      {/* Toolbar */}
      <div
        class="flex shrink-0 items-center gap-3 px-4 py-2"
        style={{
          background: 'var(--c-bg-raised, #1e1e2e)',
          'border-bottom': '1px solid var(--c-border, #45475a)'
        }}
        data-testid="planning-toolbar"
      >
        {/* View mode selector */}
        <div class="flex gap-1" data-testid="view-mode-selector">
          <For each={VIEW_MODES}>
            {(mode) => (
              <button
                class="rounded px-2 py-1 text-xs font-medium"
                style={{
                  background: viewMode() === mode.key ? 'var(--c-accent, #89b4fa)' : 'transparent',
                  color: viewMode() === mode.key ? 'var(--c-bg, #1e1e2e)' : 'var(--c-text, #cdd6f4)',
                  border: viewMode() === mode.key ? 'none' : '1px solid var(--c-border, #45475a)'
                }}
                onClick={() => setViewMode(mode.key)}
                data-testid={`view-mode-${mode.key}`}
              >
                {mode.icon} {mode.label}
              </button>
            )}
          </For>
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search issues..."
          class="max-w-xs flex-1 rounded px-2 py-1 text-xs"
          style={{
            background: 'var(--c-surface, #181825)',
            color: 'var(--c-text, #cdd6f4)',
            border: '1px solid var(--c-border, #45475a)'
          }}
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          data-testid="planning-search"
        />

        {/* Filter dropdowns */}
        <For each={FILTER_KEYS}>
          {(filterKey) => (
            <select
              class="rounded px-1 py-1 text-xs"
              style={{
                background: 'var(--c-surface, #181825)',
                color: 'var(--c-text, #cdd6f4)',
                border: '1px solid var(--c-border, #45475a)'
              }}
              onChange={(e) => {
                const val = e.currentTarget.value
                if (val) {
                  const current = filters()[filterKey] || []
                  if (!current.includes(val)) setFilter(filterKey, [...current, val])
                }
                e.currentTarget.value = ''
              }}
              data-testid={`filter-${filterKey}`}
            >
              <option value="">{filterKey}</option>
              <Show when={filterKey === 'workspace'}>
                <For each={orgs()}>{(o) => <option value={o.id}>{o.name}</option>}</For>
              </Show>
              <Show when={filterKey === 'status'}>
                <For each={kanbanStatuses}>{(s) => <option value={s}>{getStatusLabel(s)}</option>}</For>
              </Show>
              <Show when={filterKey === 'priority'}>
                <For each={['low', 'medium', 'high', 'critical'] as const}>{(p) => <option value={p}>{p}</option>}</For>
              </Show>
            </select>
          )}
        </For>

        {/* Action buttons */}
        <button
          class="rounded px-2 py-1 text-xs font-medium"
          style={{
            background: 'var(--c-accent, #89b4fa)',
            color: 'var(--c-bg, #1e1e2e)'
          }}
          onClick={() => setShowAssignDialog(true)}
          data-testid="assign-agent-button"
        >
          🤖 Assign to Agent
        </button>
        <button
          class="rounded px-2 py-1 text-xs font-medium"
          style={{
            background: 'var(--c-success, #22c55e)',
            color: 'var(--c-bg, #1e1e2e)'
          }}
          onClick={() => setShowCreateDialog(true)}
          data-testid="create-issue-button"
        >
          ＋ Create Issue
        </button>
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
                style={{
                  background: 'var(--c-accent, #89b4fa)',
                  color: 'var(--c-bg, #1e1e2e)'
                }}
                data-testid={`filter-pill-${pill.key}-${pill.value}`}
              >
                {pill.key}: {pill.value}
                <button class="ml-0.5 font-bold" onClick={() => removeFilterValue(pill.key, pill.value)}>
                  ×
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
      <div class="relative flex-1 overflow-auto">
        {/* DAG View */}
        <Show when={viewMode() === 'dag'}>
          <svg class="h-full w-full" style={{ 'min-height': '600px', cursor: 'grab' }} data-testid="dag-svg">
            <g transform={`translate(${svgPanX()}, ${svgPanY()}) scale(${svgZoom()})`}>
              {/* Edges */}
              <For each={filteredEdges()}>
                {(edge) => {
                  const fromNode = () => dagLayout(filteredNodes()).find((n) => n.node.id === edge.from)
                  const toNode = () => dagLayout(filteredNodes()).find((n) => n.node.id === edge.to)
                  return (
                    <Show when={fromNode() && toNode()}>
                      <line
                        x1={fromNode()!.x + 100}
                        y1={fromNode()!.y + 30}
                        x2={toNode()!.x}
                        y2={toNode()!.y + 30}
                        stroke={edge.crossWorkspace ? 'var(--c-warning, #f59e0b)' : 'var(--c-border, #45475a)'}
                        stroke-width={fromNode()!.node.isCriticalPath && toNode()!.node.isCriticalPath ? 3 : 1.5}
                        stroke-dasharray={edge.crossWorkspace ? '6,4' : 'none'}
                        marker-end="url(#arrow)"
                        data-testid={`edge-${edge.from}-${edge.to}`}
                      />
                    </Show>
                  )
                }}
              </For>

              {/* Arrow marker */}
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
              </defs>

              {/* Nodes */}
              <For each={dagLayout(filteredNodes())}>
                {({ node, x, y }) => (
                  <g
                    transform={`translate(${x}, ${y})`}
                    onClick={() => handleNodeClick(node)}
                    style={{ cursor: 'pointer' }}
                    data-testid={`dag-node-${node.id}`}
                  >
                    <rect
                      width={200}
                      height={60}
                      rx={6}
                      fill="var(--c-surface, #181825)"
                      stroke={getStatusColor(node.status)}
                      stroke-width={node.isCriticalPath ? 2.5 : 1.5}
                    />
                    {/* Workspace color indicator */}
                    <rect width={4} height={60} rx={2} fill={getWorkspaceColor(node.workspace, allWorkspaces())} />
                    <text x={14} y={22} fill="var(--c-text-heading, #cdd6f4)" font-size="12" font-weight="600">
                      {node.title.length > 22 ? node.title.slice(0, 22) + '…' : node.title}
                    </text>
                    <text x={14} y={40} fill="var(--c-text-muted, #a6adc8)" font-size="10">
                      {node.workspaceName} / {node.project}
                    </text>
                    <text x={14} y={54} fill={getStatusColor(node.status)} font-size="10">
                      ● {getStatusLabel(node.status)}
                    </text>
                    <text x={170} y={22} text-anchor="end" font-size="10" fill="var(--c-text-muted)">
                      {getPriorityIcon(node.priority)}
                    </text>
                  </g>
                )}
              </For>
            </g>
          </svg>
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
                              background: 'var(--c-surface, #181825)',
                              'border-left': `3px solid ${getWorkspaceColor(node.workspace, allWorkspaces())}`
                            }}
                            onClick={() => handleNodeClick(node)}
                            data-testid={`kanban-card-${node.id}`}
                          >
                            <div class="text-xs font-medium" style={{ color: 'var(--c-text-heading, #cdd6f4)' }}>
                              {node.title}
                            </div>
                            <div class="mt-1 text-xs opacity-60" style={{ color: 'var(--c-text-muted)' }}>
                              {node.workspaceName} / {node.project}
                            </div>
                            <div class="mt-1.5 flex items-center gap-1">
                              <span class="text-xs">{getPriorityIcon(node.priority)}</span>
                              <Show when={node.assignee}>
                                <span class="text-xs opacity-50" style={{ color: 'var(--c-text-muted)' }}>
                                  👤 {node.assignee}
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
          <div class="p-4" data-testid="list-view">
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
                      <td class="p-2 font-medium">{node.title}</td>
                      <td class="p-2">
                        <span
                          class="mr-1 inline-block h-2 w-2 rounded-full"
                          style={{ background: getWorkspaceColor(node.workspace, allWorkspaces()) }}
                        />
                        {node.workspaceName}
                      </td>
                      <td class="p-2">{node.project}</td>
                      <td class="p-2">
                        <span style={{ color: getStatusColor(node.status) }}>● {getStatusLabel(node.status)}</span>
                      </td>
                      <td class="p-2">{node.assignee || '—'}</td>
                      <td class="p-2">
                        {getPriorityIcon(node.priority)} {node.priority}
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
          <div class="p-4" data-testid="tree-view">
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
                                background: 'var(--c-surface, #181825)',
                                color: 'var(--c-text, #cdd6f4)'
                              }}
                              onClick={() => handleNodeClick(node)}
                              data-testid={`tree-node-${node.id}`}
                            >
                              <span style={{ color: getStatusColor(node.status) }}>●</span>
                              <span class="font-medium">{node.title}</span>
                              <span class="ml-auto opacity-50">{node.project}</span>
                              <span>{getPriorityIcon(node.priority)}</span>
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
              data-testid="create-issue-title"
            />
            <textarea
              placeholder="Description"
              class="h-20 resize-none rounded px-2 py-1.5 text-xs"
              style={{ background: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
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
                data-testid="create-issue-submit"
              >
                Create
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
            >
              <option value="">Select issue</option>
              <For each={nodes()}>{(n) => <option value={n.id}>{n.title}</option>}</For>
            </select>
            <div class="flex justify-end gap-2">
              <button
                class="rounded px-3 py-1 text-xs"
                style={{ color: 'var(--c-text)' }}
                onClick={() => setShowAssignDialog(false)}
              >
                Cancel
              </button>
              <button
                class="rounded px-3 py-1 text-xs font-medium"
                style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
                data-testid="assign-agent-submit"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default GlobalPlanningView

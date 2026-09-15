// Tasks View — holonic task DAG visualization.
//
// Fetches all tasks from /api/tasks/graph, lays them out in topological
// layers (Sugiyama-style), and renders an interactive flow diagram with
// SVG edges and HTML nodes. Filters by state, thread, and root-only.

import { createSignal, createMemo, onMount, onCleanup, For, Show, type Component } from 'solid-js'

// ── Types ───────────────────────────────────────────────────────────────

interface TaskRef {
  id: string
  name: string
  state: string
}

interface TaskNode {
  id: string
  name: string
  state: string
  threadId: string | null
  threadLabel: string | null
  description: string | null
  transientState: string | null
  createdAt: string
  updatedAt: string | null
  parentTasks: TaskRef[]
  childTasks: TaskRef[]
  tags: string[]
}

type StateFilter = 'all' | 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'active'

// ── Constants ───────────────────────────────────────────────────────────

const STATE_COLORS: Record<string, { bg: string; fg: string; border: string; glow: string }> = {
  pending: { bg: '#6b728015', fg: '#9ca3af', border: '#6b728044', glow: 'none' },
  in_progress: { bg: '#3b82f618', fg: '#60a5fa', border: '#3b82f655', glow: '0 0 12px #3b82f633' },
  completed: { bg: '#22c55e15', fg: '#4ade80', border: '#22c55e44', glow: 'none' },
  cancelled: { bg: '#ef444415', fg: '#f87171', border: '#ef444444', glow: 'none' }
}

const NODE_W = 240
const NODE_H = 72
const GAP_X = 80
const GAP_Y = 40
const PAD = 40

// ── DAG layout ──────────────────────────────────────────────────────────

interface LayoutNode {
  task: TaskNode
  x: number
  y: number
  layer: number
  index: number
}

interface LayoutEdge {
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
}

interface Layout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
}

/** Assign each node to a layer via longest-path from roots. */
function assignLayers(tasks: TaskNode[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const layers = new Map<string, number>()
  const visited = new Set<string>()

  function dfs(id: string): number {
    if (layers.has(id)) return layers.get(id)!
    if (visited.has(id)) return 0 // cycle guard
    visited.add(id)
    const task = byId.get(id)
    if (!task || task.parentTasks.length === 0) {
      layers.set(id, 0)
      return 0
    }
    let maxParent = 0
    for (const p of task.parentTasks) {
      if (byId.has(p.id)) {
        maxParent = Math.max(maxParent, dfs(p.id) + 1)
      }
    }
    layers.set(id, maxParent)
    return maxParent
  }

  for (const t of tasks) dfs(t.id)
  return layers
}

/** Lay out the DAG in horizontal layers (left→right flow). */
function layoutDag(tasks: TaskNode[]): Layout {
  if (tasks.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const layerMap = assignLayers(tasks)

  // Group by layer
  const layerBuckets = new Map<number, TaskNode[]>()
  for (const t of tasks) {
    const l = layerMap.get(t.id) ?? 0
    if (!layerBuckets.has(l)) layerBuckets.set(l, [])
    layerBuckets.get(l)!.push(t)
  }

  // Sort layers; within each layer sort by name for stability
  const sortedLayers = [...layerBuckets.entries()].sort((a, b) => a[0] - b[0])
  for (const [, bucket] of sortedLayers) {
    bucket.sort((a, b) => a.name.localeCompare(b.name))
  }

  // Position nodes
  const nodePositions = new Map<string, LayoutNode>()
  let maxX = 0
  let maxY = 0

  for (const [layerIdx, bucket] of sortedLayers) {
    for (let i = 0; i < bucket.length; i++) {
      const x = PAD + layerIdx * (NODE_W + GAP_X)
      const y = PAD + i * (NODE_H + GAP_Y)
      const ln: LayoutNode = { task: bucket[i], x, y, layer: layerIdx, index: i }
      nodePositions.set(bucket[i].id, ln)
      maxX = Math.max(maxX, x + NODE_W)
      maxY = Math.max(maxY, y + NODE_H)
    }
  }

  // Build edges (parent → child)
  const edges: LayoutEdge[] = []
  for (const t of tasks) {
    const child = nodePositions.get(t.id)
    if (!child) continue
    for (const p of t.parentTasks) {
      const parent = nodePositions.get(p.id)
      if (!parent) continue
      edges.push({
        from: p.id,
        to: t.id,
        x1: parent.x + NODE_W,
        y1: parent.y + NODE_H / 2,
        x2: child.x,
        y2: child.y + NODE_H / 2
      })
    }
  }

  return {
    nodes: [...nodePositions.values()],
    edges,
    width: maxX + PAD,
    height: maxY + PAD
  }
}

// ── Edge rendering ──────────────────────────────────────────────────────

function edgePath(e: LayoutEdge): string {
  const midX = (e.x1 + e.x2) / 2
  return `M ${e.x1} ${e.y1} C ${midX} ${e.y1}, ${midX} ${e.y2}, ${e.x2} ${e.y2}`
}

// ── Components ──────────────────────────────────────────────────────────

function TaskCard(props: { node: LayoutNode; selected: boolean; onSelect: () => void }) {
  const t = () => props.node.task
  const colors = () => STATE_COLORS[t().state] ?? STATE_COLORS.pending

  return (
    <div
      class="absolute cursor-pointer rounded-lg border transition-all"
      style={{
        left: `${props.node.x}px`,
        top: `${props.node.y}px`,
        width: `${NODE_W}px`,
        height: `${NODE_H}px`,
        background: colors().bg,
        'border-color': props.selected ? 'var(--c-accent)' : colors().border,
        'box-shadow': props.selected ? '0 0 0 2px var(--c-accent)' : colors().glow
      }}
      onClick={props.onSelect}
    >
      <div class="flex h-full flex-col justify-between p-2.5">
        <div class="flex items-start gap-1.5">
          <span class="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: colors().fg }} />
          <span
            class="line-clamp-2 text-xs leading-tight font-medium"
            style={{ color: 'var(--c-text)' }}
            title={t().name}
          >
            {t().name}
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-[10px]" style={{ color: colors().fg }}>
            {t().state.replace('_', ' ')}
          </span>
          <Show when={t().threadLabel}>
            <span
              class="max-w-[120px] truncate text-[10px]"
              style={{ color: 'var(--c-text-muted)' }}
              title={t().threadLabel!}
            >
              {t().threadLabel}
            </span>
          </Show>
        </div>
      </div>
    </div>
  )
}

function TaskDetail(props: { task: TaskNode; onClose: () => void }) {
  const t = () => props.task
  const colors = () => STATE_COLORS[t().state] ?? STATE_COLORS.pending

  return (
    <div
      class="shrink-0 overflow-y-auto border-l"
      style={{
        width: '320px',
        background: 'var(--c-bg-raised)',
        'border-color': 'var(--c-border)'
      }}
    >
      <div class="space-y-4 p-4">
        {/* Header */}
        <div class="flex items-start justify-between">
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
              {t().name}
            </h3>
            <div class="mt-1 flex items-center gap-2">
              <span
                class="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ background: colors().bg, color: colors().fg, border: `1px solid ${colors().border}` }}
              >
                {t().state.replace('_', ' ')}
              </span>
              <Show when={t().threadLabel}>
                <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                  {t().threadLabel}
                </span>
              </Show>
            </div>
          </div>
          <button
            class="shrink-0 cursor-pointer rounded border-none p-1 text-xs"
            style={{ background: 'transparent', color: 'var(--c-text-muted)' }}
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>

        {/* Transient state */}
        <Show when={t().transientState}>
          <div
            class="rounded border px-3 py-2 text-xs"
            style={{
              background: '#3b82f610',
              'border-color': '#3b82f633',
              color: '#60a5fa'
            }}
          >
            {t().transientState}
          </div>
        </Show>

        {/* Description */}
        <Show when={t().description}>
          <div>
            <div class="mb-1 text-[10px] font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
              Description
            </div>
            <p class="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--c-text)' }}>
              {t().description}
            </p>
          </div>
        </Show>

        {/* Tags */}
        <Show when={t().tags.length > 0}>
          <div>
            <div class="mb-1 text-[10px] font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
              Tags
            </div>
            <div class="flex flex-wrap gap-1">
              <For each={t().tags}>
                {(tag) => (
                  <span
                    class="rounded-full px-2 py-0.5 text-[10px]"
                    style={{ background: 'var(--c-border)', color: 'var(--c-text)' }}
                  >
                    {tag}
                  </span>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Relationships */}
        <Show when={t().parentTasks.length > 0}>
          <div>
            <div class="mb-1 text-[10px] font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
              Parents ({t().parentTasks.length})
            </div>
            <div class="space-y-1">
              <For each={t().parentTasks}>
                {(ref) => {
                  const c = () => STATE_COLORS[ref.state] ?? STATE_COLORS.pending
                  return (
                    <div class="flex items-center gap-1.5 text-xs" style={{ color: 'var(--c-text)' }}>
                      <span class="inline-block h-1.5 w-1.5 rounded-full" style={{ background: c().fg }} />
                      {ref.name}
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        <Show when={t().childTasks.length > 0}>
          <div>
            <div class="mb-1 text-[10px] font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
              Children ({t().childTasks.length})
            </div>
            <div class="space-y-1">
              <For each={t().childTasks}>
                {(ref) => {
                  const c = () => STATE_COLORS[ref.state] ?? STATE_COLORS.pending
                  return (
                    <div class="flex items-center gap-1.5 text-xs" style={{ color: 'var(--c-text)' }}>
                      <span class="inline-block h-1.5 w-1.5 rounded-full" style={{ background: c().fg }} />
                      {ref.name}
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* Timestamps */}
        <div class="space-y-1 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
          <div>Created: {new Date(t().createdAt).toLocaleString()}</div>
          <Show when={t().updatedAt}>
            <div>Updated: {new Date(t().updatedAt!).toLocaleString()}</div>
          </Show>
          <div class="font-mono break-all opacity-50">{t().id}</div>
        </div>
      </div>
    </div>
  )
}

// ── Main view ───────────────────────────────────────────────────────────

const TasksView: Component = () => {
  const [nodes, setNodes] = createSignal<TaskNode[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [stateFilter, setStateFilter] = createSignal<StateFilter>('all')
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  const loadGraph = async () => {
    try {
      const res = await fetch('/api/tasks/graph')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setNodes(data.nodes ?? [])
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load tasks')
    } finally {
      setLoading(false)
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    loadGraph()
    pollTimer = setInterval(loadGraph, 5_000)
    onCleanup(() => {
      if (pollTimer) clearInterval(pollTimer)
    })
  })

  const filtered = createMemo(() => {
    const f = stateFilter()
    const all = nodes()
    if (f === 'all') return all
    if (f === 'active') return all.filter((t) => t.state === 'pending' || t.state === 'in_progress')
    return all.filter((t) => t.state === f)
  })

  const layout = createMemo(() => layoutDag(filtered()))

  const selectedTask = createMemo(() => {
    const id = selectedId()
    if (!id) return null
    return nodes().find((t) => t.id === id) ?? null
  })

  const stateCounts = createMemo(() => {
    const all = nodes()
    return {
      total: all.length,
      pending: all.filter((t) => t.state === 'pending').length,
      in_progress: all.filter((t) => t.state === 'in_progress').length,
      completed: all.filter((t) => t.state === 'completed').length,
      cancelled: all.filter((t) => t.state === 'cancelled').length
    }
  })

  const FILTER_OPTIONS: Array<{ value: StateFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'pending', label: 'Pending' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' }
  ]

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
      {/* Toolbar */}
      <div
        class="flex shrink-0 items-center justify-between px-4 py-2"
        style={{ 'border-bottom': '1px solid var(--c-border)' }}
      >
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-bold">Tasks</h2>
          <Show when={stateCounts().in_progress > 0}>
            <span
              class="rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ background: '#3b82f622', color: '#3b82f6' }}
            >
              {stateCounts().in_progress} in progress
            </span>
          </Show>
          <Show when={stateCounts().pending > 0}>
            <span
              class="rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ background: '#6b728022', color: '#9ca3af' }}
            >
              {stateCounts().pending} pending
            </span>
          </Show>
          <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            {stateCounts().total} total
          </span>
        </div>

        <div class="flex items-center gap-2">
          {/* State filter pills */}
          <div class="flex items-center gap-0.5">
            <For each={FILTER_OPTIONS}>
              {(opt) => (
                <button
                  class="shrink-0 cursor-pointer rounded-md border-none px-2.5 py-1 text-[11px] font-medium transition-colors"
                  style={{
                    background: stateFilter() === opt.value ? 'var(--c-accent)' : 'transparent',
                    color: stateFilter() === opt.value ? '#fff' : 'var(--c-text-muted)'
                  }}
                  onClick={() => setStateFilter(opt.value)}
                >
                  {opt.label}
                </button>
              )}
            </For>
          </div>

          <button
            class="rounded border px-3 py-1 text-xs"
            style={{ background: 'transparent', 'border-color': 'var(--c-border)', color: 'var(--c-text-muted)' }}
            onClick={loadGraph}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      <Show when={error()}>
        <div class="mx-4 mt-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>
      </Show>

      {/* Loading */}
      <Show when={loading() && nodes().length === 0}>
        <div class="flex flex-1 items-center justify-center">
          <span class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
            Loading tasks…
          </span>
        </div>
      </Show>

      {/* Empty state */}
      <Show when={!loading() && nodes().length === 0}>
        <div class="flex flex-1 flex-col items-center justify-center gap-2">
          <span class="text-4xl opacity-20">⬡</span>
          <span class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
            No tasks yet
          </span>
          <span class="text-xs" style={{ color: 'var(--c-text-muted)', opacity: 0.6 }}>
            Tasks created via MCP tools appear here as a flow graph
          </span>
        </div>
      </Show>

      {/* Empty after filter */}
      <Show when={!loading() && nodes().length > 0 && filtered().length === 0}>
        <div class="flex flex-1 items-center justify-center">
          <span class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
            No tasks match the current filter
          </span>
        </div>
      </Show>

      {/* DAG canvas + detail panel */}
      <Show when={filtered().length > 0}>
        <div class="flex flex-1 overflow-hidden">
          {/* Canvas — scrollable in both axes */}
          <div class="flex-1 overflow-auto">
            <div
              class="relative"
              style={{
                width: `${layout().width}px`,
                height: `${layout().height}px`,
                'min-width': '100%',
                'min-height': '100%'
              }}
            >
              {/* SVG edges */}
              <svg
                class="pointer-events-none absolute inset-0"
                width={layout().width}
                height={layout().height}
                style={{ overflow: 'visible' }}
              >
                <For each={layout().edges}>
                  {(e) => {
                    const fromTask = nodes().find((t) => t.id === e.from)
                    const edgeColor = fromTask ? (STATE_COLORS[fromTask.state]?.fg ?? '#6b7280') : '#6b7280'
                    return (
                      <path d={edgePath(e)} fill="none" stroke={edgeColor} stroke-width="1.5" stroke-opacity="0.4" />
                    )
                  }}
                </For>
                {/* Arrowheads */}
                <For each={layout().edges}>
                  {(e) => {
                    const fromTask = nodes().find((t) => t.id === e.from)
                    const arrowColor = fromTask ? (STATE_COLORS[fromTask.state]?.fg ?? '#6b7280') : '#6b7280'
                    // Small triangle at the target end
                    const dx = 8
                    const dy = 4
                    return (
                      <polygon
                        points={`${e.x2},${e.y2} ${e.x2 - dx},${e.y2 - dy} ${e.x2 - dx},${e.y2 + dy}`}
                        fill={arrowColor}
                        fill-opacity="0.5"
                      />
                    )
                  }}
                </For>
              </svg>

              {/* Task cards */}
              <For each={layout().nodes}>
                {(ln) => (
                  <TaskCard
                    node={ln}
                    selected={selectedId() === ln.task.id}
                    onSelect={() => setSelectedId(selectedId() === ln.task.id ? null : ln.task.id)}
                  />
                )}
              </For>
            </div>
          </div>

          {/* Detail panel */}
          <Show when={selectedTask()}>
            <TaskDetail task={selectedTask()!} onClose={() => setSelectedId(null)} />
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default TasksView

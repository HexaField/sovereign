import { type Component, createSignal, onMount, onCleanup, For, Show, createEffect } from 'solid-js'
import { wsStore } from '../../ws/index.js'
import {
  zoom,
  panX,
  panY,
  setSelectedNode,
  drillDownTarget,
  eventSidebarOpen,
  toggleEventSidebar,
  eventFilterWorkspace,
  setEventFilterWorkspace,
  eventFilterType,
  setEventFilterType,
  eventFlowEnabled,
  setEventFlowEnabled,
  applyZoomDelta,
  applyPanDelta,
  zoomToNode,
  zoomOut
} from './store'

// Types
export interface OrgNode {
  id: string
  name: string
  health: 'healthy' | 'warning' | 'error'
  projectCount: number
  activeAgents: number
  unreadCount: number
}

export interface CanvasEvent {
  id: string
  type: string
  workspace: string
  targetWorkspace?: string
  summary: string
  timestamp: number
}

export interface ProjectNode {
  id: string
  name: string
  branch: string
  activeAgents: number
}

// Health colors
export function getHealthColor(health: OrgNode['health']): string {
  switch (health) {
    case 'healthy':
      return 'var(--c-success, #22c55e)'
    case 'warning':
      return 'var(--c-warning, #f59e0b)'
    case 'error':
      return 'var(--c-error, #ef4444)'
  }
}

export function getHealthGlowFilter(health: OrgNode['health']): string {
  switch (health) {
    case 'healthy':
      return 'drop-shadow(0 0 6px rgba(34,197,94,0.4))'
    case 'warning':
      return 'drop-shadow(0 0 6px rgba(245,158,11,0.4))'
    case 'error':
      return 'drop-shadow(0 0 6px rgba(239,68,68,0.4))'
  }
}

// Layout: position workspace nodes in a grid
export function layoutNodes(nodes: OrgNode[]): Array<{ node: OrgNode; x: number; y: number; w: number; h: number }> {
  const cols = Math.ceil(Math.sqrt(nodes.length))
  const nodeW = 220
  const nodeH = 140
  const gap = 60
  return nodes.map((node, i) => {
    const isGlobal = node.id === '_global'
    const col = i % cols
    const row = Math.floor(i / cols)
    return {
      node,
      x: col * (nodeW + gap) + (isGlobal ? -20 : 0),
      y: row * (nodeH + gap) + (isGlobal ? -20 : 0),
      w: isGlobal ? nodeW + 40 : nodeW,
      h: isGlobal ? nodeH + 40 : nodeH
    }
  })
}

// Format event time
export function formatEventTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Event type icon
export function getEventIcon(type: string): string {
  if (type.includes('issue')) return 'list'
  if (type.includes('review') || type.includes('pr')) return 'git'
  if (type.includes('sync')) return 'refresh'
  if (type.includes('agent')) return 'bot'
  if (type.includes('build') || type.includes('ci')) return 'wrench'
  return 'signal'
}

const CanvasView: Component = () => {
  const [orgs, setOrgs] = createSignal<OrgNode[]>([])
  const [events, setEvents] = createSignal<CanvasEvent[]>([])
  const [pulsingNodes, setPulsingNodes] = createSignal<Set<string>>(new Set())
  const [isDragging, setIsDragging] = createSignal(false)
  const [dragStart, setDragStart] = createSignal<{ x: number; y: number } | null>(null)
  const [projects, setProjects] = createSignal<ProjectNode[]>([])
  const [eventFlows, setEventFlows] = createSignal<Array<{ id: string; from: string; to: string; createdAt: number }>>(
    []
  )
  let svgRef: SVGSVGElement | undefined

  // Fetch orgs
  onMount(async () => {
    try {
      const res = await fetch('/api/orgs')
      if (res.ok) {
        const data = await res.json()
        const mapped: OrgNode[] = (data.orgs || data || []).map((o: any) => ({
          id: o.id || o.orgId,
          name: o.name || o.id || o.orgId,
          health: o.health || 'healthy',
          projectCount: o.projectCount || 0,
          activeAgents: o.activeAgents || 0,
          unreadCount: o.unreadCount || 0
        }))
        setOrgs(mapped)
      }
    } catch {
      /* network error */
    }
  })

  // Subscribe to WS event stream via wsStore
  onMount(() => {
    wsStore.subscribe(['events'])

    const offNew = wsStore.on('event.new', (msg: Record<string, unknown>) => {
      const event = msg.event as Record<string, unknown> | undefined
      const evt: CanvasEvent = {
        id: (msg.id as string) || crypto.randomUUID(),
        type: (event?.type as string) || (msg.type as string) || 'unknown',
        workspace: (event?.source as string) || (msg.source as string) || '',
        targetWorkspace: undefined,
        summary: (event?.type as string) || '',
        timestamp: Date.now()
      }
      setEvents((prev) => [evt, ...prev].slice(0, 100))

      // Pulse the workspace node
      if (evt.workspace) {
        setPulsingNodes((prev) => new Set([...prev, evt.workspace]))
        setTimeout(() => {
          setPulsingNodes((prev) => {
            const next = new Set(prev)
            next.delete(evt.workspace)
            return next
          })
        }, 2000) // 2-second decay
      }

      // Event flow animation (if enabled and has target)
      if (eventFlowEnabled() && evt.targetWorkspace && evt.workspace !== evt.targetWorkspace) {
        const flowId = `flow-${Date.now()}-${Math.random()}`
        setEventFlows((prev) => [
          ...prev,
          { id: flowId, from: evt.workspace, to: evt.targetWorkspace!, createdAt: Date.now() }
        ])
        setTimeout(() => {
          setEventFlows((prev) => prev.filter((f) => f.id !== flowId))
        }, 2000)
      }
    })

    // Decay timer — clean up old event flows
    const decayTimer = setInterval(() => {
      const now = Date.now()
      setEventFlows((prev) => prev.filter((f) => now - f.createdAt < 2000))
    }, 500)

    onCleanup(() => {
      offNew()
      wsStore.unsubscribe(['events'])
      clearInterval(decayTimer)
    })
  })

  // Fetch projects for drill-down
  createEffect(() => {
    const target = drillDownTarget()
    if (!target) {
      setProjects([])
      return
    }
    fetch(`/api/orgs/${target}/projects`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setProjects(
            (data.projects || data || []).map((p: any) => ({
              id: p.id || p.projectId,
              name: p.name || p.id,
              branch: p.branch || 'main',
              activeAgents: p.activeAgents || 0
            }))
          )
        }
      })
      .catch(() => {})
  })

  // Mouse handlers for pan
  function handleMouseDown(e: MouseEvent) {
    if (e.button === 0) {
      setIsDragging(true)
      setDragStart({ x: e.clientX, y: e.clientY })
    }
  }

  function handleMouseMove(e: MouseEvent) {
    if (isDragging() && dragStart()) {
      const ds = dragStart()!
      const dx = e.clientX - ds.x
      const dy = e.clientY - ds.y
      applyPanDelta(dx, dy)
      setDragStart({ x: e.clientX, y: e.clientY })
    }
  }

  function handleMouseUp() {
    setIsDragging(false)
    setDragStart(null)
  }

  // Wheel handler for zoom
  function handleWheel(e: WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    applyZoomDelta(delta)
  }

  // Touch handlers
  let lastTouchDist = 0

  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length === 1) {
      setIsDragging(true)
      setDragStart({ x: e.touches[0].clientX, y: e.touches[0].clientY })
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX
      const dy = e.touches[1].clientY - e.touches[0].clientY
      lastTouchDist = Math.sqrt(dx * dx + dy * dy)
    }
  }

  function handleTouchMove(e: TouchEvent) {
    e.preventDefault()
    if (e.touches.length === 1 && isDragging() && dragStart()) {
      const ds = dragStart()!
      const dx = e.touches[0].clientX - ds.x
      const dy = e.touches[0].clientY - ds.y
      applyPanDelta(dx, dy)
      setDragStart({ x: e.touches[0].clientX, y: e.touches[0].clientY })
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX
      const dy = e.touches[1].clientY - e.touches[0].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (lastTouchDist > 0) {
        const scale = dist / lastTouchDist
        applyZoomDelta((scale - 1) * 0.5)
      }
      lastTouchDist = dist
    }
  }

  function handleTouchEnd() {
    setIsDragging(false)
    setDragStart(null)
    lastTouchDist = 0
  }

  // Click on workspace node
  function handleNodeClick(orgId: string) {
    if (drillDownTarget() === orgId) return
    zoomToNode(orgId)
  }

  // Double-click on project to switch to workspace view
  function handleProjectDblClick(orgId: string, projectId: string) {
    // Dispatch navigation event — workspace view will handle it
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('sovereign:navigate', {
          detail: { view: 'workspace', orgId, projectId }
        })
      )
    }
  }

  // Filter events for sidebar
  function filteredEvents(): CanvasEvent[] {
    let evts = events()
    const ws = eventFilterWorkspace()
    const tp = eventFilterType()
    if (ws) evts = evts.filter((e) => e.workspace === ws)
    if (tp) evts = evts.filter((e) => e.type.includes(tp))
    return evts
  }

  const nodes = () => layoutNodes(orgs())

  return (
    <div
      class="relative h-full w-full overflow-hidden"
      style={{ background: 'var(--c-bg)', 'min-height': '100vh' }}
      data-testid="canvas-view"
    >
      {/* Breadcrumb / Zoom out */}
      <Show when={drillDownTarget()}>
        <div
          class="absolute top-4 left-4 z-20 flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm"
          style={{
            background: 'var(--c-bg-raised, #1e1e2e)',
            color: 'var(--c-text, #cdd6f4)',
            border: '1px solid var(--c-border, #45475a)'
          }}
          onClick={() => zoomOut()}
          data-testid="zoom-out-button"
        >
          <span>←</span>
          <span>All Workspaces</span>
          <span class="opacity-50">/ {orgs().find((o) => o.id === drillDownTarget())?.name || drillDownTarget()}</span>
        </div>
      </Show>

      {/* Event sidebar toggle */}
      <button
        class="absolute top-4 right-4 z-20 rounded-lg px-3 py-1.5 text-sm"
        style={{
          background: 'var(--c-bg-raised, #1e1e2e)',
          color: 'var(--c-text, #cdd6f4)',
          border: '1px solid var(--c-border, #45475a)'
        }}
        onClick={() => toggleEventSidebar()}
        data-testid="event-sidebar-toggle"
      >
        {eventSidebarOpen() ? '▶' : '◀'} Events
      </button>

      {/* Performance toggle */}
      <button
        class="absolute top-14 right-4 z-20 rounded-lg px-3 py-1.5 text-sm"
        style={{
          background: 'var(--c-bg-raised, #1e1e2e)',
          color: 'var(--c-text, #cdd6f4)',
          border: '1px solid var(--c-border, #45475a)'
        }}
        onClick={() => setEventFlowEnabled(!eventFlowEnabled())}
        data-testid="performance-toggle"
      >
        {eventFlowEnabled() ? 'Animations On' : 'Animations Off'}
      </button>

      {/* SVG Canvas */}
      <svg
        ref={svgRef}
        class="h-full w-full"
        style={{ cursor: isDragging() ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        data-testid="canvas-svg"
      >
        <g transform={`translate(${panX()}, ${panY()}) scale(${zoom()})`} data-testid="canvas-transform-group">
          {/* Workspace membrane nodes */}
          <Show when={!drillDownTarget()}>
            <For each={nodes()}>
              {({ node, x, y, w, h }) => {
                const isGlobal = node.id === '_global'
                const isPulsing = () => pulsingNodes().has(node.id)
                return (
                  <g
                    transform={`translate(${x}, ${y})`}
                    onClick={() => handleNodeClick(node.id)}
                    style={{ cursor: 'pointer' }}
                    data-testid={`workspace-node-${node.id}`}
                    data-org-id={node.id}
                    class="workspace-membrane"
                  >
                    {/* Membrane rect */}
                    <rect
                      width={w}
                      height={h}
                      rx={isGlobal ? 20 : 12}
                      ry={isGlobal ? 20 : 12}
                      fill={isGlobal ? 'var(--c-bg-raised, #1e1e2e)' : 'var(--c-surface, #181825)'}
                      stroke={getHealthColor(node.health)}
                      stroke-width={isGlobal ? 3 : 2}
                      style={{ filter: getHealthGlowFilter(node.health) }}
                    >
                      {isPulsing() && (
                        <animate attributeName="stroke-opacity" values="1;0.3;1" dur="0.8s" repeatCount={1} />
                      )}
                    </rect>

                    {/* Pulse animation overlay */}
                    <Show when={isPulsing()}>
                      <rect
                        width={w}
                        height={h}
                        rx={isGlobal ? 20 : 12}
                        ry={isGlobal ? 20 : 12}
                        fill="none"
                        stroke={getHealthColor(node.health)}
                        stroke-width={1}
                        opacity={0.5}
                        data-testid={`pulse-${node.id}`}
                      >
                        <animate attributeName="stroke-width" values="2;8;2" dur="1s" repeatCount={1} />
                        <animate attributeName="opacity" values="0.5;0;0.5" dur="1s" repeatCount={1} />
                      </rect>
                    </Show>

                    {/* Global badge */}
                    <Show when={isGlobal}>
                      <text x={w - 30} y={22} font-size="14" fill="var(--c-text-muted, #a6adc8)">
                        lock
                      </text>
                    </Show>

                    {/* Name */}
                    <text
                      x={w / 2}
                      y={isGlobal ? 45 : 35}
                      text-anchor="middle"
                      fill="var(--c-text-heading, #cdd6f4)"
                      style={{ 'font-size': `${isGlobal ? 16 : 14}px`, 'font-weight': '600' }}
                    >
                      {node.name}
                    </text>

                    {/* Badges */}
                    <text x={12} y={h - 30} font-size="11" fill="var(--c-text-muted, #a6adc8)">
                      dir {node.projectCount}
                    </text>
                    <text x={w / 2 - 20} y={h - 30} font-size="11" fill="var(--c-text-muted, #a6adc8)">
                      agent {node.activeAgents}
                    </text>
                    <Show when={node.unreadCount > 0}>
                      <text x={w - 50} y={h - 30} font-size="11" fill="var(--c-accent, #89b4fa)">
                        bell {node.unreadCount}
                      </text>
                    </Show>

                    {/* Health indicator text */}
                    <text x={12} y={h - 12} font-size="10" fill={getHealthColor(node.health)}>
                      ● {node.health}
                    </text>
                  </g>
                )
              }}
            </For>
          </Show>

          {/* Drill-down: projects within a workspace */}
          <Show when={drillDownTarget()}>
            <For each={projects()}>
              {(project, i) => {
                const x = () => (i() % 3) * 200 + 50
                const y = () => Math.floor(i() / 3) * 120 + 50
                return (
                  <g
                    transform={`translate(${x()}, ${y()})`}
                    onDblClick={() => handleProjectDblClick(drillDownTarget()!, project.id)}
                    style={{ cursor: 'pointer' }}
                    data-testid={`project-node-${project.id}`}
                  >
                    <rect
                      width={180}
                      height={90}
                      rx={8}
                      fill="var(--c-surface, #181825)"
                      stroke="var(--c-border, #45475a)"
                      stroke-width={1.5}
                    />
                    <text
                      x={90}
                      y={30}
                      text-anchor="middle"
                      fill="var(--c-text-heading, #cdd6f4)"
                      font-size="13"
                      font-weight="600"
                    >
                      {project.name}
                    </text>
                    <text x={90} y={50} text-anchor="middle" fill="var(--c-text-muted, #a6adc8)" font-size="10">
                      🌿 {project.branch}
                    </text>
                    <text x={90} y={70} text-anchor="middle" fill="var(--c-text-muted, #a6adc8)" font-size="10">
                      agent {project.activeAgents} agents
                    </text>
                  </g>
                )
              }}
            </For>
          </Show>

          {/* Cross-workspace event flow animations (2s decay) */}
          <Show when={eventFlowEnabled()}>
            <For each={eventFlows()}>
              {(flow) => {
                const sourceLayout = () => nodes().find((n) => n.node.id === flow.from)
                const targetLayout = () => nodes().find((n) => n.node.id === flow.to)
                return (
                  <Show when={sourceLayout() && targetLayout()}>
                    <line
                      x1={sourceLayout()!.x + sourceLayout()!.w / 2}
                      y1={sourceLayout()!.y + sourceLayout()!.h / 2}
                      x2={targetLayout()!.x + targetLayout()!.w / 2}
                      y2={targetLayout()!.y + targetLayout()!.h / 2}
                      stroke="var(--c-accent, #89b4fa)"
                      stroke-width={2}
                      stroke-dasharray="6,4"
                      opacity={0.7}
                      data-testid={`event-flow-${flow.id}`}
                    >
                      <animate attributeName="stroke-dashoffset" from="0" to="-20" dur="1s" repeatCount="indefinite" />
                      <animate attributeName="opacity" from="0.7" to="0" dur="2s" fill="freeze" />
                    </line>
                    {/* Pulse particle along path */}
                    <circle r="4" fill="var(--c-accent, #89b4fa)" opacity="0.8">
                      <animateMotion
                        dur="1s"
                        repeatCount={1}
                        path={`M${sourceLayout()!.x + sourceLayout()!.w / 2},${sourceLayout()!.y + sourceLayout()!.h / 2} L${targetLayout()!.x + targetLayout()!.w / 2},${targetLayout()!.y + targetLayout()!.h / 2}`}
                      />
                      <animate attributeName="opacity" from="0.8" to="0" dur="2s" fill="freeze" />
                    </circle>
                  </Show>
                )
              }}
            </For>
          </Show>
        </g>
      </svg>

      {/* Event Sidebar */}
      <Show when={eventSidebarOpen()}>
        <div
          class="absolute top-0 right-0 z-10 h-full w-80 overflow-y-auto"
          style={{
            background: 'var(--c-bg-raised, #1e1e2e)',
            'border-left': '1px solid var(--c-border, #45475a)'
          }}
          data-testid="event-sidebar"
        >
          <div
            class="flex items-center justify-between p-3"
            style={{ 'border-bottom': '1px solid var(--c-border, #45475a)' }}
          >
            <span class="text-sm font-semibold" style={{ color: 'var(--c-text-heading, #cdd6f4)' }}>
              Live Events
            </span>
            <button onClick={() => toggleEventSidebar()} class="text-xs opacity-60 hover:opacity-100">
              ✕
            </button>
          </div>

          {/* Filters */}
          <div class="flex gap-2 p-2" style={{ 'border-bottom': '1px solid var(--c-border, #45475a)' }}>
            <select
              class="flex-1 rounded px-1 py-0.5 text-xs"
              style={{
                background: 'var(--c-surface, #181825)',
                color: 'var(--c-text, #cdd6f4)',
                border: '1px solid var(--c-border, #45475a)'
              }}
              value={eventFilterWorkspace() || ''}
              onChange={(e) => setEventFilterWorkspace(e.currentTarget.value || null)}
              data-testid="event-filter-workspace"
            >
              <option value="">All workspaces</option>
              <For each={orgs()}>{(org) => <option value={org.id}>{org.name}</option>}</For>
            </select>
            <select
              class="flex-1 rounded px-1 py-0.5 text-xs"
              style={{
                background: 'var(--c-surface, #181825)',
                color: 'var(--c-text, #cdd6f4)',
                border: '1px solid var(--c-border, #45475a)'
              }}
              value={eventFilterType() || ''}
              onChange={(e) => setEventFilterType(e.currentTarget.value || null)}
              data-testid="event-filter-type"
            >
              <option value="">All types</option>
              <option value="issue">Issues</option>
              <option value="pr">PRs</option>
              <option value="agent">Agents</option>
              <option value="sync">Sync</option>
              <option value="ci">CI</option>
            </select>
          </div>

          {/* Event list */}
          <div class="flex flex-col gap-1 p-2">
            <For
              each={filteredEvents()}
              fallback={
                <div class="p-2 text-xs opacity-50" style={{ color: 'var(--c-text-muted)' }}>
                  No events yet
                </div>
              }
            >
              {(evt) => (
                <div
                  class="cursor-pointer rounded p-2 text-xs hover:opacity-80"
                  style={{
                    background: 'var(--c-surface, #181825)',
                    color: 'var(--c-text, #cdd6f4)'
                  }}
                  onClick={() => {
                    setSelectedNode(evt.workspace)
                  }}
                  data-testid={`event-item-${evt.id}`}
                >
                  <div class="flex items-center gap-1.5">
                    <span>{getEventIcon(evt.type)}</span>
                    <span class="font-medium">{evt.type}</span>
                    <span class="ml-auto opacity-50">{formatEventTime(evt.timestamp)}</span>
                  </div>
                  <div class="mt-0.5 truncate opacity-70">{evt.summary}</div>
                  <div class="mt-0.5">
                    <span
                      class="inline-block rounded px-1 py-0.5 text-xs"
                      style={{ background: 'var(--c-accent, #89b4fa)', color: 'var(--c-bg, #1e1e2e)' }}
                    >
                      {evt.workspace}
                    </span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default CanvasView

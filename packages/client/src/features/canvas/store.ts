import { createSignal } from 'solid-js'

// §4.1 — Canvas state
export const [zoom, setZoom] = createSignal(1)
export const [panX, setPanX] = createSignal(0)
export const [panY, setPanY] = createSignal(0)

// §4.4 — Selected node for drill-down
export const [selectedNode, setSelectedNode] = createSignal<string | null>(null)

// §4.4 — Drill-down level: 'overview' or a specific orgId
export const [drillDownTarget, setDrillDownTarget] = createSignal<string | null>(null)

// §4.5 — Event sidebar
export const [eventSidebarOpen, setEventSidebarOpen] = createSignal(false)
export const [eventFilterWorkspace, setEventFilterWorkspace] = createSignal<string | null>(null)
export const [eventFilterType, setEventFilterType] = createSignal<string | null>(null)

export function toggleEventSidebar(): void {
  setEventSidebarOpen(!eventSidebarOpen())
}

export function resetCanvasView(): void {
  setZoom(1)
  setPanX(0)
  setPanY(0)
  setSelectedNode(null)
  setDrillDownTarget(null)
}

export function zoomToNode(orgId: string): void {
  setSelectedNode(orgId)
  setDrillDownTarget(orgId)
  setZoom(2.5)
}

export function zoomOut(): void {
  setDrillDownTarget(null)
  setSelectedNode(null)
  setZoom(1)
  setPanX(0)
  setPanY(0)
}

// Clamp zoom to reasonable bounds
export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 5

export function applyZoomDelta(delta: number): void {
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom() + delta))
  setZoom(next)
}

export function applyPanDelta(dx: number, dy: number): void {
  setPanX(panX() + dx)
  setPanY(panY() + dy)
}

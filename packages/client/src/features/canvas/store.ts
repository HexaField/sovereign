import { createSignal } from 'solid-js'

export const [zoom, setZoom] = createSignal(1)
export const [panX, setPanX] = createSignal(0)
export const [panY, setPanY] = createSignal(0)
export const [selectedNode, setSelectedNode] = createSignal<string | null>(null)

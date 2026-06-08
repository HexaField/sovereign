import type { PlanningNode, PlanningEdge } from './planning-types.js'

export const DAG_NODE_W = 220
export const DAG_NODE_H = 68
const DAG_H_GAP = 60
const DAG_V_GAP = 24
export const GRID_CARD_W = 180
export const GRID_CARD_H = 52
const GRID_GAP = 12
const COMPONENT_GAP = 50

export interface LayoutResult {
  connected: Array<{ node: PlanningNode; x: number; y: number }>
  unconnected: Array<{ node: PlanningNode; x: number; y: number }>
  connectedBounds: { w: number; h: number }
  totalHeight: number
}

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

function findConnectedComponents(nodes: PlanningNode[], edges: PlanningEdge[]): PlanningNode[][] {
  const nodeMap = new Map<string, PlanningNode>()
  for (const n of nodes) nodeMap.set(n.id, n)

  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n.id, new Set())
  for (const e of edges) {
    adj.get(e.from)?.add(e.to)
    adj.get(e.to)?.add(e.from)
  }

  const visited = new Set<string>()
  const components: PlanningNode[][] = []

  for (const n of nodes) {
    if (visited.has(n.id)) continue
    const component: PlanningNode[] = []
    const queue = [n.id]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      const node = nodeMap.get(id)
      if (node) component.push(node)
      for (const neighbor of adj.get(id) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor)
      }
    }
    if (component.length > 0) components.push(component)
  }

  return components
}

function layoutComponent(
  compNodes: PlanningNode[],
  compEdges: PlanningEdge[],
  yStart: number
): { positions: Array<{ node: PlanningNode; x: number; y: number }>; maxX: number; maxY: number } {
  const leftNeighbors = new Map<string, string[]>()
  for (const e of compEdges) {
    const list = leftNeighbors.get(e.from) || []
    list.push(e.to)
    leftNeighbors.set(e.from, list)
  }

  const byDepth = new Map<number, PlanningNode[]>()
  for (const n of compNodes) {
    const list = byDepth.get(n.depth) || []
    list.push(n)
    byDepth.set(n.depth, list)
  }

  const minDepth = Math.min(...byDepth.keys())
  if (minDepth !== 0) {
    const entries = [...byDepth.entries()]
    byDepth.clear()
    for (const [d, items] of entries) byDepth.set(d - minDepth, items)
  }

  const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b)
  const nodeYPos = new Map<string, number>()

  for (const depth of sortedDepths) {
    const items = byDepth.get(depth)!
    items.forEach((node, i) => {
      nodeYPos.set(node.id, i * (DAG_NODE_H + DAG_V_GAP) + yStart)
    })
  }

  for (let iter = 0; iter < 3; iter++) {
    for (const depth of sortedDepths) {
      if (depth === 0) continue
      const items = byDepth.get(depth)!
      items.sort((a, b) => {
        const aNeighbors = (leftNeighbors.get(a.id) || []).map((id) => nodeYPos.get(id) ?? 0)
        const bNeighbors = (leftNeighbors.get(b.id) || []).map((id) => nodeYPos.get(id) ?? 0)
        const medianA = aNeighbors.length > 0 ? aNeighbors.sort((x, y) => x - y)[Math.floor(aNeighbors.length / 2)] : 0
        const medianB = bNeighbors.length > 0 ? bNeighbors.sort((x, y) => x - y)[Math.floor(bNeighbors.length / 2)] : 0
        return (medianA ?? 0) - (medianB ?? 0)
      })
      items.forEach((node, i) => {
        nodeYPos.set(node.id, i * (DAG_NODE_H + DAG_V_GAP) + yStart)
      })
    }
  }

  let compMaxItems = 0
  for (const depth of sortedDepths) {
    compMaxItems = Math.max(compMaxItems, byDepth.get(depth)!.length)
  }
  const totalColHeight = compMaxItems * (DAG_NODE_H + DAG_V_GAP) - DAG_V_GAP

  const positions: Array<{ node: PlanningNode; x: number; y: number }> = []
  let maxX = 0
  let maxY = 0

  for (const depth of sortedDepths) {
    const items = byDepth.get(depth)!
    const colX = depth * (DAG_NODE_W + DAG_H_GAP) + 40
    const colHeight = items.length * (DAG_NODE_H + DAG_V_GAP) - DAG_V_GAP
    const offsetY = Math.max(0, (totalColHeight - colHeight) / 2)
    items.forEach((node, i) => {
      const y = i * (DAG_NODE_H + DAG_V_GAP) + yStart + offsetY
      nodeYPos.set(node.id, y)
      positions.push({ node, x: colX, y })
      maxX = Math.max(maxX, colX + DAG_NODE_W)
      maxY = Math.max(maxY, y + DAG_NODE_H)
    })
  }

  return { positions, maxX, maxY }
}

export function improvedLayout(nodes: PlanningNode[], edges: PlanningEdge[]): LayoutResult {
  const edgeNodeIds = new Set<string>()
  for (const e of edges) {
    edgeNodeIds.add(e.from)
    edgeNodeIds.add(e.to)
  }
  for (const n of nodes) {
    if (n.dependencies.some((d) => edgeNodeIds.has(d))) edgeNodeIds.add(n.id)
  }

  const connected = nodes.filter((n) => edgeNodeIds.has(n.id))
  const unconnected = nodes.filter((n) => !edgeNodeIds.has(n.id))

  const components = findConnectedComponents(connected, edges)
  components.sort((a, b) => b.length - a.length)

  const connectedPositions: Array<{ node: PlanningNode; x: number; y: number }> = []
  let maxX = 0
  let maxY = 40

  for (const comp of components) {
    const compNodeIds = new Set(comp.map((n) => n.id))
    const compEdges = edges.filter((e) => compNodeIds.has(e.from) && compNodeIds.has(e.to))

    const result = layoutComponent(comp, compEdges, maxY)
    connectedPositions.push(...result.positions)
    maxX = Math.max(maxX, result.maxX)
    maxY = result.maxY + COMPONENT_GAP
  }

  const connectedBounds = { w: maxX + 40, h: maxY }

  const byProject = new Map<string, PlanningNode[]>()
  for (const n of unconnected) {
    const key = `${n.workspaceName}/${n.projectName}`
    const list = byProject.get(key) || []
    list.push(n)
    byProject.set(key, list)
  }

  const unconnectedPositions: Array<{ node: PlanningNode; x: number; y: number }> = []
  const gridStartY = connectedBounds.h + 60
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

// ── Forest store ────────────────────────────────────────────────────
// Central state for the knowledge forest visualisation.

import { createSignal, createMemo } from 'solid-js'
import type { ForestIndex, ForestNode, ForestLink, ForestSettings, ForestFilter, Vec3 } from './types.js'
import { getStrategy } from './projections/registry.js'

// ── Defaults ────────────────────────────────────────────────────────

const SETTINGS_KEY = 'sovereign:forest-settings'

const DEFAULT_SETTINGS: ForestSettings = {
  transition: { duration: 500, easing: 'easeInOut' },
  node: {
    size: 0.4,
    sizeMapping: 'uniform',
    shape: 'sphere',
    colorMapping: 'byType',
    opacity: 0.9,
    labelVisibility: 'hover'
  },
  link: {
    visibility: 'selected-neighborhood',
    style: 'line',
    colorMapping: 'byPredicate',
    opacity: 0.3,
    width: 1
  },
  projection: { strategy: 'hash', dimensions: [0, 1, 2] },
  styles: { graph: true, cloud: false }
}

const EMPTY_FILTER: ForestFilter = {
  types: [],
  tags: [],
  search: '',
  predicates: [],
  timeRange: null
}

function loadSettings(): ForestSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function persistSettings(s: ForestSettings): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* quota exceeded — ignore */
  }
}

// ── Signals ─────────────────────────────────────────────────────────

export const [forestIndex, setForestIndex] = createSignal<ForestIndex | null>(null)
export const [forestSettings, setForestSettings] = createSignal<ForestSettings>(loadSettings())
export const [forestFilter, setForestFilter] = createSignal<ForestFilter>(EMPTY_FILTER)
export const [forestLoading, setForestLoading] = createSignal(false)
export const [forestError, setForestError] = createSignal<string | null>(null)
export const [selectedNodeIri, setSelectedNodeIri] = createSignal<string | null>(null)
export const [hoveredNodeIri, setHoveredNodeIri] = createSignal<string | null>(null)
export const [queryOpen, setQueryOpen] = createSignal(false)
export const [settingsOpen, setSettingsOpen] = createSignal(false)

// ── Derived ─────────────────────────────────────────────────────────

export const filteredNodes = createMemo<ForestNode[]>(() => {
  const index = forestIndex()
  if (!index) return []
  const f = forestFilter()
  return index.nodes.filter((n) => {
    if (f.types.length > 0 && !f.types.includes(n.entityType)) return false
    if (f.tags.length > 0 && !f.tags.some((t) => n.tags.includes(t))) return false
    if (f.search) {
      const q = f.search.toLowerCase()
      if (!n.name.toLowerCase().includes(q) && !n.content.toLowerCase().includes(q)) return false
    }
    if (f.timeRange) {
      const [lo, hi] = f.timeRange
      if (n.timestamp < lo || n.timestamp > hi) return false
    }
    return true
  })
})

export const nodePositions = createMemo<Map<string, Vec3>>(() => {
  const nodes = filteredNodes()
  const settings = forestSettings()
  const index = forestIndex()
  const strategy = getStrategy(settings.projection.strategy)
  if (!strategy || nodes.length === 0) return new Map()

  const context = {
    pcaBasis: index?.pcaBasis ?? null,
    pcaMean: index?.pcaMean ?? null,
    dimensions: settings.projection.dimensions,
    allNodes: nodes
  }

  const map = new Map<string, Vec3>()
  for (const node of nodes) {
    map.set(node.iri, strategy.project(node, context))
  }
  return map
})

export const filteredLinks = createMemo<ForestLink[]>(() => {
  const index = forestIndex()
  if (!index) return []
  const visible = new Set(filteredNodes().map((n) => n.iri))
  return index.links.filter((l) => visible.has(l.source) && visible.has(l.target))
})

export const availableTypes = createMemo<string[]>(() => {
  const index = forestIndex()
  if (!index) return []
  return [...new Set(index.nodes.map((n) => n.entityType))].sort()
})

export const availableTags = createMemo<string[]>(() => {
  const index = forestIndex()
  if (!index) return []
  return [...new Set(index.nodes.flatMap((n) => n.tags))].sort()
})

export const nodeByIri = createMemo<Map<string, ForestNode>>(() => {
  const index = forestIndex()
  if (!index) return new Map()
  const map = new Map<string, ForestNode>()
  for (const n of index.nodes) map.set(n.iri, n)
  return map
})

// ── Actions ─────────────────────────────────────────────────────────

export async function loadForestIndex(): Promise<void> {
  setForestLoading(true)
  setForestError(null)
  try {
    const res = await fetch('/api/forest/index')
    if (!res.ok) throw new Error(`Forest index request failed: ${res.status}`)
    const data: ForestIndex = await res.json()
    setForestIndex(data)
  } catch (err) {
    setForestError((err as Error).message)
  } finally {
    setForestLoading(false)
  }
}

export async function rebuildForestIndex(): Promise<void> {
  setForestLoading(true)
  setForestError(null)
  try {
    const res = await fetch('/api/forest/rebuild', { method: 'POST' })
    if (!res.ok) throw new Error(`Forest rebuild failed: ${res.status}`)
    const data: ForestIndex = await res.json()
    setForestIndex(data)
  } catch (err) {
    setForestError((err as Error).message)
  } finally {
    setForestLoading(false)
  }
}

export function updateSettings(fn: (prev: ForestSettings) => ForestSettings): void {
  setForestSettings((prev) => {
    const next = fn(prev)
    persistSettings(next)
    return next
  })
}

export function updateFilter(partial: Partial<ForestFilter>): void {
  setForestFilter((prev) => ({ ...prev, ...partial }))
}

export function clearFilter(): void {
  setForestFilter(EMPTY_FILTER)
}

export function resetSettings(): void {
  setForestSettings(DEFAULT_SETTINGS)
  persistSettings(DEFAULT_SETTINGS)
}

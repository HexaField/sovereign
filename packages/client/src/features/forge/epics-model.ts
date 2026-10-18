// Epics panel — pure. Epics are work streams. The list order depends only on
// the streams' names and parents (hierarchy first, then name, natural sort),
// never on selection or counts, so it holds still while the user picks.
// Selected epics live in the view's saved filters (`filters.workstreams`) and
// focus the canvas on their members (and, by default, their neighbours).

import type { ForgeFilters, WorkEdge, WorkNode, WorkStream } from '@sovereign/core'
import { streamFocus, toggleFilterValue } from './filters.js'

export type EpicsMode = 'dropdown' | 'modal'
export const LS_EPICS_MODE = 'sovereign:forge:epics-mode'

export function parseEpicsMode(v: string | null | undefined): EpicsMode {
  return v === 'modal' ? 'modal' : 'dropdown'
}

export const otherEpicsMode = (m: EpicsMode): EpicsMode => (m === 'modal' ? 'dropdown' : 'modal')

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byName = (a: WorkStream, b: WorkStream): number => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1)

export interface EpicRow {
  stream: WorkStream
  depth: number
}

/** Each epic under its parent; siblings by name ("Plan 2" before "Plan 10"). A parent outside the list or a cycle makes a root. */
export function orderEpics(streams: WorkStream[]): EpicRow[] {
  const ids = new Set(streams.map((s) => s.id))
  const children = new Map<string, WorkStream[]>()
  const roots: WorkStream[] = []
  for (const s of streams) {
    if (s.parentId && s.parentId !== s.id && ids.has(s.parentId)) {
      const list = children.get(s.parentId) ?? []
      list.push(s)
      children.set(s.parentId, list)
    } else roots.push(s)
  }
  const out: EpicRow[] = []
  const seen = new Set<string>()
  const walk = (s: WorkStream, depth: number): void => {
    if (seen.has(s.id)) return
    seen.add(s.id)
    out.push({ stream: s, depth })
    for (const c of [...(children.get(s.id) ?? [])].sort(byName)) walk(c, depth + 1)
  }
  for (const r of [...roots].sort(byName)) walk(r, 0)
  // Streams caught in a parent cycle: none of them is a root. List them at the top level.
  for (const s of [...streams].sort(byName)) walk(s, 0)
  return out
}

/** Rows whose name holds every word of `q`, with their ancestors so each match keeps its place in the tree. */
export function searchEpics(rows: EpicRow[], q: string): EpicRow[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rows
  const byId = new Map(rows.map((r) => [r.stream.id, r.stream]))
  const keep = new Set<string>()
  for (const r of rows) {
    const name = r.stream.name.toLowerCase()
    if (!words.every((w) => name.includes(w))) continue
    let cur: WorkStream | undefined = r.stream
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }
  return rows.filter((r) => keep.has(r.stream.id))
}

/** The selected epics that exist in `streams` (an archived or removed one drops out). */
export function selectedEpics(f: ForgeFilters, streams: WorkStream[]): string[] {
  const ids = new Set(streams.map((s) => s.id))
  return (f.workstreams ?? []).filter((id) => ids.has(id))
}

/** The selection with every sub-epic of a selected epic. */
export function withSubEpics(selected: string[], streams: WorkStream[]): string[] {
  const out = new Set(selected)
  for (let grew = true; grew; ) {
    grew = false
    for (const s of streams) {
      if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id)
        grew = true
      }
    }
  }
  return [...out]
}

/** The nodes the selected epics focus the canvas on, or null when none is selected. */
export function epicFocus(
  f: ForgeFilters,
  streams: WorkStream[],
  nodes: WorkNode[],
  edges: WorkEdge[]
): Set<string> | null {
  const selected = selectedEpics(f, streams)
  if (!selected.length) return null
  return streamFocus(withSubEpics(selected, streams), nodes, edges, f.epicNeighbours !== false)
}

export const toggleEpic = (f: ForgeFilters, id: string): ForgeFilters => toggleFilterValue(f, 'workstreams', id)

export function clearEpics(f: ForgeFilters): ForgeFilters {
  const { workstreams: _drop, ...rest } = f
  return rest
}

export function setEpicNeighbours(f: ForgeFilters, on: boolean): ForgeFilters {
  const { epicNeighbours: _drop, ...rest } = f
  return on ? rest : { ...rest, epicNeighbours: false }
}

export function setDim(f: ForgeFilters, on: boolean): ForgeFilters {
  const { dim: _drop, ...rest } = f
  return on ? { ...rest, dim: true } : rest
}

/** "Epics (12)", or "Epics (2/12)" while two are selected. */
export function epicsButtonLabel(f: ForgeFilters, streams: WorkStream[]): string {
  const n = selectedEpics(f, streams).length
  return n ? `Epics (${n}/${streams.length})` : `Epics (${streams.length})`
}

/** "Plan: <project>/<path>" for an epic a plan file made, else "" (made by hand or by the rethink thread). */
export const epicSource = (s: WorkStream): string => (s.plan ? `Plan: ${s.plan.replace(/^plan:/, '')}` : '')

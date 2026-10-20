// Epic selection for the Tree panel — pure. Epics are work streams, the nodes of
// the goal tree (tree-model.ts holds the outline and placement). The list order depends only on
// the streams' names and parents (hierarchy first, then name, natural sort),
// never on selection or counts, so it holds still while the user picks.
// Selected epics live in the view's saved filters (`filters.workstreams`) and
// focus the canvas on their members (and, by default, their neighbours). An
// epic owns its members; a plan's epic is also related to what the plan names,
// which joins the focus with "Owned + related" (`filters.epicRelated`).
// Status chips (`filters.epicStatus`) pick which epics the panel lists; with
// statuses chosen and no epic picked, every listed epic is selected, so
// "Active" focuses the canvas, lanes and Kanban on every active epic.

import type { EpicStatus, ForgeFilters, WorkEdge, WorkNode, WorkStream } from '@sovereign/core'
import { EPIC_STATUSES } from '@sovereign/core/forge'
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

/** The statuses the panel lists: the chosen ones, else every status but archived. */
export function shownStatuses(f: ForgeFilters): EpicStatus[] {
  const chosen = EPIC_STATUSES.filter((s) => f.epicStatus?.includes(s))
  return chosen.length ? chosen : EPIC_STATUSES.filter((s) => s !== 'archived')
}

/** The epics the panel lists: those with a shown status. */
export function shownEpics(f: ForgeFilters, streams: WorkStream[]): WorkStream[] {
  const statuses = new Set(shownStatuses(f))
  return streams.filter((s) => statuses.has(s.status))
}

/** The epics picked one by one that the panel lists (an epic of a hidden status, archived or removed drops out). */
export function pickedEpics(f: ForgeFilters, streams: WorkStream[]): string[] {
  const ids = new Set(shownEpics(f, streams).map((s) => s.id))
  return (f.workstreams ?? []).filter((id) => ids.has(id))
}

/**
 * The selected epics: the picked ones; with none picked and statuses chosen,
 * every epic with those statuses; else none.
 */
export function selectedEpics(f: ForgeFilters, streams: WorkStream[]): string[] {
  const picked = pickedEpics(f, streams)
  if (picked.length || !f.epicStatus?.length) return picked
  return shownEpics(f, streams).map((s) => s.id)
}

/** The selection with its sub-epics, kept to the shown statuses: whose members the canvas, lanes and Kanban focus on. */
export function focusedEpics(f: ForgeFilters, streams: WorkStream[]): string[] {
  const selected = selectedEpics(f, streams)
  if (!selected.length) return []
  const shown = new Set(shownEpics(f, streams).map((s) => s.id))
  return withSubEpics(selected, streams).filter((id) => shown.has(id))
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
  const focused = focusedEpics(f, streams)
  if (!focused.length) return null
  return streamFocus(focused, nodes, edges, f.epicNeighbours !== false, f.epicRelated === true)
}

/**
 * What a panel shows: the filter result narrowed to the epic focus (or, in
 * dim mode, with the nodes outside the focus faded). The canvas draws
 * `visible` with `dimmed` faded; the Kanban lists `visible` minus `dimmed`.
 */
export function panelVisibility(
  filtered: { visible: Set<string>; dimmed: Set<string> },
  focus: Set<string> | null,
  dim: boolean | undefined
): { visible: Set<string>; dimmed: Set<string> } {
  if (!focus) return { visible: filtered.visible, dimmed: filtered.dimmed }
  if (dim) {
    const dimmed = new Set(filtered.dimmed)
    for (const id of filtered.visible) if (!focus.has(id)) dimmed.add(id)
    return { visible: filtered.visible, dimmed }
  }
  return { visible: new Set([...filtered.visible].filter((id) => focus.has(id))), dimmed: filtered.dimmed }
}

/** The ids a panel shows undimmed. */
export function panelShown(v: { visible: Set<string>; dimmed: Set<string> }): Set<string> {
  return v.dimmed.size ? new Set([...v.visible].filter((id) => !v.dimmed.has(id))) : v.visible
}

/**
 * The streams the canvas makes lanes of: with nothing selected, every shown
 * epic. With a selection, lanes follow the picked node's children: the top of
 * each focused branch and each of its children (laneFold folds the rest in).
 */
export function laneStreams(f: ForgeFilters, streams: WorkStream[]): WorkStream[] {
  const fold = laneFold(f, streams)
  if (!fold) return shownEpics(f, streams)
  const lanes = new Set(fold.values())
  return streams.filter((s) => lanes.has(s.id))
}

/**
 * With a selection: the lane each focused stream folds into. The top of each
 * focused branch keeps its own lane, each of its children gets one, and every
 * stream deeper down joins its ancestor's child lane. Undefined with nothing selected.
 */
export function laneFold(f: ForgeFilters, streams: WorkStream[]): Map<string, string> | undefined {
  const focused = focusedEpics(f, streams)
  if (!focused.length) return undefined
  const keep = new Set(focused)
  const byId = new Map(streams.map((s) => [s.id, s]))
  const parentIn = (id: string): string | undefined => {
    const p = byId.get(id)?.parentId
    return p && keep.has(p) && p !== id ? p : undefined
  }
  const out = new Map<string, string>()
  for (const id of focused) {
    // Climb while the parent is not the branch top: `lane` ends as the top or one of its children.
    let lane = id
    const seen = new Set([id])
    for (let up = parentIn(lane); up && parentIn(up) && !seen.has(up); up = parentIn(lane)) {
      seen.add(up)
      lane = up
    }
    out.set(id, lane)
  }
  return out
}

export const toggleEpic = (f: ForgeFilters, id: string): ForgeFilters => toggleFilterValue(f, 'workstreams', id)

/** Drop the epic selection: the picked epics and the status chips. */
export function clearEpics(f: ForgeFilters): ForgeFilters {
  const { workstreams: _drop, epicStatus: _status, ...rest } = f
  return rest
}

export function setEpicNeighbours(f: ForgeFilters, on: boolean): ForgeFilters {
  const { epicNeighbours: _drop, ...rest } = f
  return on ? rest : { ...rest, epicNeighbours: false }
}

/** "Owned | Owned + related": whether the selected epics' related items join the focus and their lanes. */
export function setEpicRelated(f: ForgeFilters, on: boolean): ForgeFilters {
  const { epicRelated: _drop, ...rest } = f
  return on ? { ...rest, epicRelated: true } : rest
}

export function setDim(f: ForgeFilters, on: boolean): ForgeFilters {
  const { dim: _drop, ...rest } = f
  return on ? { ...rest, dim: true } : rest
}

export const toggleEpicStatus = (f: ForgeFilters, s: EpicStatus): ForgeFilters => toggleFilterValue(f, 'epicStatus', s)

/** Whether the window needs archived epics from the server (`?archived=1`): the Archived chip is on. */
export const wantsArchived = (f: ForgeFilters): boolean => f.epicStatus?.includes('archived') === true

/** "Plan: <project>/<path>" for an epic a plan file made, else "" (made by hand or by the rethink thread). */
export const epicSource = (s: WorkStream): string => (s.plan ? `Plan: ${s.plan.replace(/^plan:/, '')}` : '')

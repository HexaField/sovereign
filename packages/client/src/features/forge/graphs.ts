// Graphs (saved views) per membrane — pure list operations, plus the panel
// arrangement (all stacked, or one solo).

import type { ForgeFilters, ForgeView } from '@sovereign/core'

export type Arrangement = { mode: 'all' } | { mode: 'solo'; id: string }

export function newViewId(existing: ForgeView[], rand: () => number = Math.random): string {
  const ids = new Set(existing.map((v) => v.id))
  for (;;) {
    const id = `view-${Math.floor(rand() * 36 ** 6)
      .toString(36)
      .padStart(6, '0')}`
    if (!ids.has(id)) return id
  }
}

/** The seeded view a membrane gets when it has none: every repo, no filters. */
export function seedView(membrane: string, title = 'All repos'): ForgeView {
  return { id: `view-${membrane}-all`, membrane, title, repos: [], filters: {} }
}

export function addView(
  views: ForgeView[],
  membrane: string,
  title: string,
  id: string,
  filters: ForgeFilters = {}
): ForgeView[] {
  return [...views, { id, membrane, title: title.trim() || 'Untitled graph', repos: [], filters }]
}

export function removeView(views: ForgeView[], id: string): ForgeView[] {
  return views.filter((v) => v.id !== id)
}

/** Move a view by `delta` places (−1 up, +1 down), clamped at the ends. */
export function moveView(views: ForgeView[], id: string, delta: number): ForgeView[] {
  const i = views.findIndex((v) => v.id === id)
  if (i === -1) return views
  const j = Math.max(0, Math.min(views.length - 1, i + delta))
  if (i === j) return views
  const out = [...views]
  const [v] = out.splice(i, 1)
  out.splice(j, 0, v)
  return out
}

export function updateView(
  views: ForgeView[],
  id: string,
  patch: Partial<Omit<ForgeView, 'id' | 'membrane'>>
): ForgeView[] {
  return views.map((v) => (v.id === id ? { ...v, ...patch } : v))
}

/** Which views show, in order. A solo id that no longer exists falls back to all. */
export function shownViews(views: ForgeView[], arr: Arrangement): ForgeView[] {
  if (arr.mode === 'solo') {
    const v = views.find((x) => x.id === arr.id)
    if (v) return [v]
  }
  return views
}

/**
 * The filters a view applies: its chips, narrowed to the view's repo list.
 * Chips naming only repos outside the list fall back to the whole list.
 */
export function viewFilters(v: ForgeView): ForgeFilters {
  if (!v.repos.length) return v.filters
  const picked = v.filters.repos?.filter((r) => v.repos.includes(r)) ?? []
  return { ...v.filters, repos: picked.length ? picked : v.repos }
}

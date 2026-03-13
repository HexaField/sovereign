import { createSignal } from 'solid-js'

export type PlanningViewMode = 'dag' | 'kanban' | 'list' | 'tree'

const FILTERS_STORAGE_KEY = 'sovereign:planning-filters'
const VIEW_MODE_STORAGE_KEY = 'sovereign:planning-view-mode'

function loadFiltersFromStorage(): Record<string, string[]> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore */
  }
  return {}
}

function saveFiltersToStorage(f: Record<string, string[]>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(f))
  } catch {
    /* ignore */
  }
}

function loadViewModeFromStorage(): PlanningViewMode {
  if (typeof localStorage === 'undefined') return 'dag'
  try {
    const val = localStorage.getItem(VIEW_MODE_STORAGE_KEY)
    const valid: PlanningViewMode[] = ['dag', 'kanban', 'list', 'tree']
    if (val && valid.includes(val as PlanningViewMode)) return val as PlanningViewMode
  } catch {
    /* ignore */
  }
  return 'dag'
}

export const [viewMode, _setViewMode] = createSignal<PlanningViewMode>(loadViewModeFromStorage())
export const [filters, _setFilters] = createSignal<Record<string, string[]>>(loadFiltersFromStorage())
export const [searchQuery, setSearchQuery] = createSignal('')

export function setViewMode(mode: PlanningViewMode): void {
  _setViewMode(mode)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
    } catch {
      /* ignore */
    }
  }
}

export function setFilters(f: Record<string, string[]>): void {
  _setFilters(f)
  saveFiltersToStorage(f)
}

export function setFilter(key: string, values: string[]): void {
  const current = filters()
  const next = { ...current, [key]: values }
  if (values.length === 0) delete next[key]
  setFilters(next)
}

export function clearFilters(): void {
  setFilters({})
  setSearchQuery('')
}

export function removeFilterValue(key: string, value: string): void {
  const current = filters()
  const values = (current[key] || []).filter((v) => v !== value)
  setFilter(key, values)
}

/** @internal — for testing */
export function _resetPlanningStore(): void {
  _setViewMode('dag')
  _setFilters({})
  setSearchQuery('')
}

import { createSignal } from 'solid-js'

export type PlanningViewMode = 'dag' | 'kanban' | 'list' | 'tree'

export const [viewMode, setViewMode] = createSignal<PlanningViewMode>('dag')
export const [filters, setFilters] = createSignal<Record<string, string[]>>({})
export const [searchQuery, setSearchQuery] = createSignal('')

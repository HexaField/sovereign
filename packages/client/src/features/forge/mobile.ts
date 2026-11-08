// The Forge's compact phone layout: when it applies, and what it shows.
// Narrow = below Tailwind's `sm` breakpoint (640 px), so the `max-sm:`
// classes in the components and this signal switch at the same width.

import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js'

export const NARROW_MAX_PX = 640
const NARROW_QUERY = `(max-width: ${NARROW_MAX_PX - 0.02}px)`

/** Pure: does a viewport this wide get the phone layout? */
export const isNarrowWidth = (width: number): boolean => width < NARROW_MAX_PX

/** A signal that follows the viewport width (call inside a component). */
export function createNarrow(): Accessor<boolean> {
  const initial = typeof window !== 'undefined' ? isNarrowWidth(window.innerWidth) : false
  const [narrow, setNarrow] = createSignal(initial)
  onMount(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(NARROW_QUERY)
    const update = (): void => void setNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    onCleanup(() => mq.removeEventListener('change', update))
  })
  return narrow
}

/**
 * The graph panels to mount. A phone shows one panel filling the screen
 * (the first of the arrangement: "Show all, stacked" or the solo pick);
 * the others stay one tap away in ⋯ → Graphs. Desktop shows them all.
 */
export function panelsToShow(ids: string[], narrow: boolean): string[] {
  return narrow ? ids.slice(0, 1) : ids
}

/** The status line of a graph panel (the ⋯ menu shows it on a phone; the header on desktop). */
export function panelStatusParts(s: {
  visible: number
  total: number
  since: string
  syncing?: boolean
  syncOff?: boolean
  lastSyncAt?: string | null
  loading?: boolean
}): string[] {
  const parts = [`${s.visible} / ${s.total} nodes`, `history from ${s.since}`]
  if (s.syncing) parts.push('first sync running…')
  if (s.syncOff) parts.push('GitHub sync off (forge.enabled)')
  if (s.lastSyncAt) parts.push(`synced ${new Date(s.lastSyncAt).toLocaleTimeString()}`)
  if (s.loading) parts.push('loading…')
  return parts
}

/** What a graph panel lends the phone top bar: its filter count and sheet, and the ⋯ menu's panel items. */
export interface PanelControls {
  filterCount: () => number
  openFilters: () => void
  status: () => string[]
  error: () => string | null
  treeLabel: () => string
  openTree: () => void
  history: () => void
  historyDisabled: () => boolean
  fit: () => void
  /** Graph mode only (Kanban has nothing to fit). */
  canFit: () => boolean
}

/** What the Decisions view lends the phone top bar. */
export interface DecisionControls {
  filterCount: () => number
  openFilters: () => void
}

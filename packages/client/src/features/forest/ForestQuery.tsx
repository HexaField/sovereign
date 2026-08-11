// ── Forest query / filter modal ─────────────────────────────────────
// Mobile-friendly modal for filtering the forest by type, tag, text.

import { Show, For, createSignal } from 'solid-js'
import {
  forestFilter,
  updateFilter,
  clearFilter,
  availableTypes,
  availableTags,
  queryOpen,
  setQueryOpen,
  filteredNodes,
  forestIndex
} from './store.js'

export default function ForestQuery() {
  const [localSearch, setLocalSearch] = createSignal(forestFilter().search)

  const applySearch = () => updateFilter({ search: localSearch() })

  const toggleType = (t: string) => {
    const current = forestFilter().types
    const next = current.includes(t) ? current.filter((x) => x !== t) : [...current, t]
    updateFilter({ types: next })
  }

  const toggleTag = (t: string) => {
    const current = forestFilter().tags
    const next = current.includes(t) ? current.filter((x) => x !== t) : [...current, t]
    updateFilter({ tags: next })
  }

  const activeFilterCount = () => {
    const f = forestFilter()
    let count = 0
    if (f.types.length > 0) count++
    if (f.tags.length > 0) count++
    if (f.search) count++
    if (f.timeRange) count++
    return count
  }

  return (
    <Show when={queryOpen()}>
      {/* Backdrop */}
      <div
        class="fixed inset-0 z-[400]"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={() => setQueryOpen(false)}
      />

      {/* Panel */}
      <div
        class="fixed right-0 bottom-0 left-0 z-[401] max-h-[70vh] overflow-y-auto rounded-t-2xl p-4 md:top-1/2 md:bottom-auto md:left-1/2 md:max-h-[80vh] md:w-[420px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
      >
        {/* Header */}
        <div class="mb-4 flex items-center justify-between">
          <span class="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
            Filter Forest
          </span>
          <div class="flex items-center gap-2">
            <Show when={activeFilterCount() > 0}>
              <button
                class="cursor-pointer rounded-md border-none px-2 py-1 text-xs"
                style={{ background: 'var(--c-hover-bg)', color: 'var(--c-text-muted)' }}
                onClick={() => {
                  clearFilter()
                  setLocalSearch('')
                }}
              >
                Clear all
              </button>
            </Show>
            <button
              class="cursor-pointer rounded-md border-none px-2 py-1 text-sm"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={() => setQueryOpen(false)}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Search */}
        <div class="mb-4">
          <label class="mb-1 block text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
            Search
          </label>
          <div class="flex gap-2">
            <input
              type="text"
              class="flex-1 rounded-lg border px-3 py-1.5 text-sm"
              style={{
                background: 'var(--c-bg)',
                color: 'var(--c-text)',
                'border-color': 'var(--c-border)'
              }}
              placeholder="Search nodes..."
              value={localSearch()}
              onInput={(e) => setLocalSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applySearch()
              }}
            />
            <button
              class="cursor-pointer rounded-lg border-none px-3 py-1.5 text-xs font-medium"
              style={{ background: 'var(--c-accent)', color: '#fff' }}
              onClick={applySearch}
            >
              Go
            </button>
          </div>
        </div>

        {/* Types */}
        <Show when={availableTypes().length > 0}>
          <div class="mb-4">
            <label class="mb-2 block text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
              Entity types
            </label>
            <div class="flex flex-wrap gap-1.5">
              <For each={availableTypes()}>
                {(t) => {
                  const active = () => forestFilter().types.includes(t)
                  return (
                    <button
                      class="cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors"
                      style={{
                        background: active() ? 'var(--c-accent)' : 'transparent',
                        color: active() ? '#fff' : 'var(--c-text-muted)',
                        'border-color': active() ? 'var(--c-accent)' : 'var(--c-border)'
                      }}
                      onClick={() => toggleType(t)}
                    >
                      {t}
                    </button>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* Tags */}
        <Show when={availableTags().length > 0}>
          <div class="mb-4">
            <label class="mb-2 block text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
              Tags
            </label>
            <div class="flex flex-wrap gap-1.5">
              <For each={availableTags()}>
                {(t) => {
                  const active = () => forestFilter().tags.includes(t)
                  return (
                    <button
                      class="cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors"
                      style={{
                        background: active() ? 'var(--c-accent)' : 'transparent',
                        color: active() ? '#fff' : 'var(--c-text-muted)',
                        'border-color': active() ? 'var(--c-accent)' : 'var(--c-border)'
                      }}
                      onClick={() => toggleTag(t)}
                    >
                      {t}
                    </button>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* Stats */}
        <div class="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
          Showing {filteredNodes().length} of {forestIndex()?.nodes.length ?? 0} nodes
        </div>
      </div>
    </Show>
  )
}

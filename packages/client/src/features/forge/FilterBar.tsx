// Filter chips for one graph: the most used fields as chips (Repo, State,
// Assignee, Requested from me, Agent, Updated), the rest behind "More", a
// text filter. Epics are picked in the epics panel, not here.

import { createSignal, For, Show, type Component } from 'solid-js'
import type { ForgeFilters } from '@sovereign/core'
import {
  clearFilters,
  hasActiveFilters,
  moreActiveCount,
  MORE_MENUS,
  PRIMARY_MENUS,
  toggleFilterValue,
  type FilterMenu,
  type FilterOptions,
  type OptionKey
} from './filters.js'
import { useDismiss } from './dismiss.js'

export interface FilterBarProps {
  filters: ForgeFilters
  /** In a stable order (stableOptions): picking never moves an option. */
  options: FilterOptions
  onChange: (f: ForgeFilters) => void
  /** The search input, so '/' can focus it. */
  searchRef?: (el: HTMLInputElement) => void
  /** Shown beside the search box while a history search runs. */
  searching?: boolean
  hasIdentity: boolean
}

type Open = OptionKey | 'more' | null

const chip =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap transition-colors'
const menuBox =
  'absolute top-full left-0 z-[61] mt-1 max-h-72 min-w-[180px] overflow-y-auto rounded border py-1 shadow-lg'
const menuStyle = { background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }

const FilterBar: Component<FilterBarProps> = (props) => {
  const [open, setOpen] = createSignal<Open>(null)
  let openEl: HTMLDivElement | undefined
  useDismiss(
    () => open() !== null,
    () => openEl,
    () => setOpen(null)
  )
  const active = (key: OptionKey): string[] => (props.filters[key] as string[] | undefined) ?? []
  const set = (patch: Partial<ForgeFilters>): void => {
    const next = { ...props.filters, ...patch } as Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) if (v === undefined || v === false || v === '') delete next[k]
    props.onChange(next as ForgeFilters)
  }
  const labelOf = (key: OptionKey, v: string): string => props.options[key].find((o) => o.value === v)?.label ?? v
  const chipStyle = (on: boolean) => ({
    'border-color': on ? 'var(--c-accent)' : 'var(--c-border)',
    color: on ? 'var(--c-accent)' : 'var(--c-text)',
    background: 'var(--c-bg)'
  })
  const toggleOpen = (which: Exclude<Open, null>, e: MouseEvent): void => {
    openEl = (e.currentTarget as HTMLElement).parentElement as HTMLDivElement
    setOpen(open() === which ? null : which)
  }

  const Options: Component<{ m: FilterMenu }> = (p) => (
    <Show
      when={props.options[p.m.key].length}
      fallback={<div class="px-3 py-1 text-xs opacity-60">Nothing loaded</div>}
    >
      <For each={props.options[p.m.key]}>
        {(o) => (
          <button
            class="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-[var(--c-hover-bg)]"
            style={{ color: 'var(--c-text)' }}
            onClick={() => props.onChange(toggleFilterValue(props.filters, p.m.key, o.value))}
            data-testid={`forge-filter-option-${p.m.key}`}
          >
            <span class="w-3">{active(p.m.key).includes(o.value) ? '✓' : ''}</span>
            <span class="flex-1 truncate">{o.label}</span>
            <span style={{ color: 'var(--c-text-muted)' }}>{o.count}</span>
          </button>
        )}
      </For>
    </Show>
  )

  return (
    <div class="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="forge-filters">
      <input
        ref={(el) => props.searchRef?.(el)}
        type="search"
        placeholder="Filter…  (/)"
        class="w-40 rounded border px-2 py-0.5 text-xs"
        style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-text)' }}
        value={props.filters.text ?? ''}
        onInput={(e) => set({ text: e.currentTarget.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            set({ text: '' })
            e.currentTarget.blur()
          }
        }}
        data-testid="forge-filter-text"
      />
      <Show when={props.searching}>
        <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
          searching history…
        </span>
      </Show>
      <For each={PRIMARY_MENUS}>
        {(m) => (
          <div class="relative">
            <button
              class={chip}
              style={chipStyle(active(m.key).length > 0)}
              onClick={(e) => toggleOpen(m.key, e)}
              data-testid={`forge-filter-${m.key}`}
            >
              {m.label}
              <Show when={active(m.key).length}>
                <span>
                  :{' '}
                  {active(m.key)
                    .map((v) => labelOf(m.key, v))
                    .join(', ')}
                </span>
              </Show>
              <span style={{ color: 'var(--c-text-muted)' }}>▾</span>
            </button>
            <Show when={open() === m.key}>
              <div class={menuBox} style={menuStyle} data-testid={`forge-filter-menu-${m.key}`}>
                <Options m={m} />
              </div>
            </Show>
          </div>
        )}
      </For>
      <button
        class={chip}
        style={chipStyle(!!props.filters.requestedFromMe)}
        disabled={!props.hasIdentity}
        title={props.hasIdentity ? 'Review requested from you' : 'The server has not reported a forge identity'}
        onClick={() => set({ requestedFromMe: !props.filters.requestedFromMe })}
        data-testid="forge-filter-mine"
      >
        Requested from me
      </button>
      <select
        class={chip}
        style={chipStyle(!!props.filters.agent)}
        value={props.filters.agent ?? ''}
        onChange={(e) => set({ agent: (e.currentTarget.value || undefined) as ForgeFilters['agent'] })}
        data-testid="forge-filter-agent"
      >
        <option value="">Agent: any state</option>
        <option value="any">Has agent</option>
        <option value="waiting-ci">Waiting on CI</option>
        <option value="waiting-review">Waiting on review</option>
      </select>
      <select
        class={chip}
        style={chipStyle(!!props.filters.updatedWithinDays)}
        value={String(props.filters.updatedWithinDays ?? '')}
        onChange={(e) => set({ updatedWithinDays: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })}
        data-testid="forge-filter-updated"
      >
        <option value="">Updated: any time</option>
        <option value="1">Updated today</option>
        <option value="7">Updated ≤ 7 days</option>
        <option value="30">Updated ≤ 30 days</option>
      </select>
      <div class="relative">
        <button
          class={chip}
          style={chipStyle(moreActiveCount(props.filters) > 0)}
          onClick={(e) => toggleOpen('more', e)}
          title="Zone, author, reviewer, label"
          data-testid="forge-filter-more"
        >
          More
          <Show when={moreActiveCount(props.filters)}>
            <span>({moreActiveCount(props.filters)})</span>
          </Show>
          <span style={{ color: 'var(--c-text-muted)' }}>▾</span>
        </button>
        <Show when={open() === 'more'}>
          <div class={`${menuBox} min-w-[220px]`} style={menuStyle} data-testid="forge-filter-menu-more">
            <For each={MORE_MENUS}>
              {(m) => (
                <div data-testid={`forge-filter-menu-${m.key}`}>
                  <div
                    class="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wider uppercase"
                    style={{ color: 'var(--c-text-muted)' }}
                  >
                    {m.label}
                  </div>
                  <Options m={m} />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <button
        class={chip}
        style={chipStyle(!!props.filters.dim)}
        title="Dim non-matching nodes instead of hiding them"
        onClick={() => set({ dim: !props.filters.dim })}
        data-testid="forge-filter-dim"
      >
        Dim instead
      </button>
      <Show when={hasActiveFilters(props.filters)}>
        <button
          class={chip}
          style={chipStyle(false)}
          onClick={() => props.onChange(clearFilters(props.filters))}
          data-testid="forge-filter-clear"
        >
          Clear
        </button>
      </Show>
    </div>
  )
}

export default FilterBar

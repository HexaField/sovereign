// Filter chips for one graph: the most used fields as chips (Repo, Type, the
// category chip group, State, Assignee, Requested from me, Not in a tree,
// Agent, Updated), the rest behind "More", a text filter. Tree nodes are picked in the tree panel, not here.

import { createSignal, For, Show, type Component, type JSX } from 'solid-js'
import type { ForgeFilters, WorkCategory } from '@sovereign/core'
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
import { CATEGORY_COLORS, CATEGORY_LABELS } from './style.js'

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
  /** 'sheet': the phone Filters sheet — every control laid out in sections, options as 40 px chips, no popovers. */
  layout?: 'bar' | 'sheet'
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

  // One toggle per category, in its colour, beside the Type menu.
  const CategoryChips: Component = () => (
    <div
      class="inline-flex items-center gap-0.5"
      role="group"
      aria-label="Category"
      data-testid="forge-filter-categories"
    >
      <For each={props.options.categories}>
        {(o) => {
          const c = o.value as WorkCategory
          const on = () => active('categories').includes(c)
          return (
            <button
              class={chip}
              style={{
                'border-color': on() ? CATEGORY_COLORS[c].fg : 'var(--c-border)',
                color: CATEGORY_COLORS[c].fg,
                background: on() ? CATEGORY_COLORS[c].bg : 'var(--c-bg)'
              }}
              aria-pressed={on()}
              title={`Category: ${CATEGORY_LABELS[c].long} (${o.count} loaded)`}
              onClick={() => props.onChange(toggleFilterValue(props.filters, 'categories', c))}
              data-testid="forge-filter-category"
              data-category={c}
            >
              {o.label}
            </button>
          )
        }}
      </For>
    </div>
  )

  if (props.layout === 'sheet') return <FilterSheet {...props} set={set} active={active} chipStyle={chipStyle} />

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
          <>
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
            <Show when={m.key === 'kinds'}>
              <CategoryChips />
            </Show>
          </>
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
      <button
        class={chip}
        style={chipStyle(!!props.filters.orphans)}
        title="Open issues and PRs that no node of the goal tree owns"
        onClick={() => set({ orphans: !props.filters.orphans })}
        data-testid="forge-filter-orphans"
      >
        Not in a tree
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
      <button
        class={chip}
        style={chipStyle(!!props.filters.showPaused)}
        title="Show paused items and goals (hidden by default)"
        onClick={() => set({ showPaused: !props.filters.showPaused })}
        data-testid="forge-filter-paused"
      >
        Paused
      </button>
      <button
        class={chip}
        style={chipStyle(!!props.filters.showEmpty)}
        title="Show plans that own no work items yet (hidden from the goal tree by default)"
        onClick={() => set({ showEmpty: !props.filters.showEmpty })}
        data-testid="forge-filter-empty"
      >
        Empty plans
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

const sheetChip = 'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors'
const sheetField = 'h-10 w-full rounded border px-2 text-sm'
const fieldStyle = { 'border-color': 'var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-text)' }

/** The phone layout of the same controls: same filters, same handlers, nothing behind a popover. */
const FilterSheet: Component<
  FilterBarProps & {
    set: (patch: Partial<ForgeFilters>) => void
    active: (key: OptionKey) => string[]
    chipStyle: (on: boolean) => Record<string, string>
  }
> = (props) => {
  const [more, setMore] = createSignal(moreActiveCount(props.filters) > 0)
  const Section: Component<{ title: string; children: JSX.Element }> = (p) => (
    <div class="px-4 py-2">
      <div class="mb-1.5 text-[11px] font-semibold tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
        {p.title}
      </div>
      {p.children}
    </div>
  )
  const Toggle: Component<{ on: boolean; label: string; onClick: () => void; testid: string; disabled?: boolean }> = (
    p
  ) => (
    <button
      class={`${sheetChip} disabled:opacity-40`}
      style={props.chipStyle(p.on)}
      aria-pressed={p.on}
      disabled={p.disabled}
      onClick={() => p.onClick()}
      data-testid={p.testid}
    >
      {p.label}
    </button>
  )
  const MenuSection: Component<{ m: FilterMenu }> = (p) => (
    <Section title={p.m.label}>
      <div class="flex flex-wrap gap-1.5" data-testid={`forge-filter-menu-${p.m.key}`}>
        <Show
          when={props.options[p.m.key].length}
          fallback={
            <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Nothing loaded
            </span>
          }
        >
          <For each={props.options[p.m.key]}>
            {(o) => {
              const on = () => props.active(p.m.key).includes(o.value)
              const tone = p.m.key === 'categories' ? CATEGORY_COLORS[o.value as WorkCategory] : null
              return (
                <button
                  class={sheetChip}
                  style={
                    tone
                      ? {
                          'border-color': on() ? tone.fg : 'var(--c-border)',
                          color: tone.fg,
                          background: on() ? tone.bg : 'var(--c-bg)'
                        }
                      : props.chipStyle(on())
                  }
                  aria-pressed={on()}
                  onClick={() => props.onChange(toggleFilterValue(props.filters, p.m.key, o.value))}
                  data-testid={`forge-filter-option-${p.m.key}`}
                >
                  <span class="max-w-[14rem] truncate">{o.label}</span>
                  <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                    {o.count}
                  </span>
                </button>
              )
            }}
          </For>
        </Show>
      </div>
    </Section>
  )

  return (
    <div class="pb-4" data-testid="forge-filters">
      <div class="px-4 pt-3 pb-1">
        <input
          ref={(el) => props.searchRef?.(el)}
          type="search"
          placeholder="Filter by text…"
          class={sheetField}
          style={fieldStyle}
          value={props.filters.text ?? ''}
          onInput={(e) => props.set({ text: e.currentTarget.value })}
          data-testid="forge-filter-text"
        />
        <Show when={props.searching}>
          <div class="mt-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
            searching history…
          </div>
        </Show>
      </div>
      <For each={PRIMARY_MENUS}>
        {(m) => (
          <>
            <MenuSection m={m} />
            <Show when={m.key === 'kinds'}>
              <MenuSection m={{ key: 'categories', label: 'Category' }} />
            </Show>
          </>
        )}
      </For>
      <Section title="Show">
        <div class="flex flex-wrap gap-1.5">
          <Toggle
            on={!!props.filters.requestedFromMe}
            label="Requested from me"
            disabled={!props.hasIdentity}
            onClick={() => props.set({ requestedFromMe: !props.filters.requestedFromMe })}
            testid="forge-filter-mine"
          />
          <Toggle
            on={!!props.filters.orphans}
            label="Not in a tree"
            onClick={() => props.set({ orphans: !props.filters.orphans })}
            testid="forge-filter-orphans"
          />
          <Toggle
            on={!!props.filters.showPaused}
            label="Paused"
            onClick={() => props.set({ showPaused: !props.filters.showPaused })}
            testid="forge-filter-paused"
          />
          <Toggle
            on={!!props.filters.showEmpty}
            label="Empty plans"
            onClick={() => props.set({ showEmpty: !props.filters.showEmpty })}
            testid="forge-filter-empty"
          />
          <Toggle
            on={!!props.filters.dim}
            label="Dim instead of hide"
            onClick={() => props.set({ dim: !props.filters.dim })}
            testid="forge-filter-dim"
          />
        </div>
      </Section>
      <Section title="Agent">
        <select
          class={sheetField}
          style={fieldStyle}
          value={props.filters.agent ?? ''}
          onChange={(e) => props.set({ agent: (e.currentTarget.value || undefined) as ForgeFilters['agent'] })}
          data-testid="forge-filter-agent"
        >
          <option value="">Any state</option>
          <option value="any">Has agent</option>
          <option value="waiting-ci">Waiting on CI</option>
          <option value="waiting-review">Waiting on review</option>
        </select>
      </Section>
      <Section title="Updated">
        <select
          class={sheetField}
          style={fieldStyle}
          value={String(props.filters.updatedWithinDays ?? '')}
          onChange={(e) =>
            props.set({ updatedWithinDays: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })
          }
          data-testid="forge-filter-updated"
        >
          <option value="">Any time</option>
          <option value="1">Today</option>
          <option value="7">Within 7 days</option>
          <option value="30">Within 30 days</option>
        </select>
      </Section>
      <div class="px-4 py-2">
        <button
          class="flex min-h-10 w-full items-center gap-2 rounded border px-3 text-left text-sm"
          style={props.chipStyle(moreActiveCount(props.filters) > 0)}
          aria-expanded={more()}
          onClick={() => setMore(!more())}
          data-testid="forge-filter-more"
        >
          <span class="flex-1">
            More: zone, author, reviewer, label
            <Show when={moreActiveCount(props.filters)}> ({moreActiveCount(props.filters)})</Show>
          </span>
          <span>{more() ? '▴' : '▾'}</span>
        </button>
      </div>
      <Show when={more()}>
        <For each={MORE_MENUS}>{(m) => <MenuSection m={m} />}</For>
      </Show>
      <Show when={hasActiveFilters(props.filters)}>
        <div class="px-4 pt-2">
          <button
            class="min-h-10 w-full rounded border px-3 text-sm"
            style={props.chipStyle(false)}
            onClick={() => props.onChange(clearFilters(props.filters))}
            data-testid="forge-filter-clear"
          >
            Clear filters
          </button>
        </div>
      </Show>
    </div>
  )
}

export default FilterBar

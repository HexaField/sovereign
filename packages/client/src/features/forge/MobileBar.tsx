// The Forge's one slim top bar on a phone: the Graph / Kanban / Decisions
// switch (icons, with the open-decision count), the membrane select, a
// Filters button with a badge of active filters, and a ⋯ menu holding
// everything else (ForgeView passes its items in).

import { createSignal, For, Show, type Component, type JSX } from 'solid-js'
import type { ForgeMode } from './kanban-model.js'
import type { MembraneMeta } from './membrane.js'
import { useDismiss } from './dismiss.js'

export interface MobileBarProps {
  mode: ForgeMode
  onMode: (m: ForgeMode) => void
  openDecisions: number
  membranes: MembraneMeta[]
  membrane: string | null
  onMembrane: (id: string) => void
  /** null: nothing to filter yet (the panel has not mounted). */
  filterCount: number | null
  onFilters: () => void
  /** The ⋯ menu's body; `close` shuts the menu. */
  menu: (close: () => void) => JSX.Element
}

const fieldStyle = { 'border-color': 'var(--c-border)', color: 'var(--c-text)', background: 'var(--c-bg)' }

const Icon: Component<{ d: string }> = (p) => (
  <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d={p.d} stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)
const ICONS: Record<ForgeMode, string> = {
  // Three linked nodes.
  graph: 'M6 7a2 2 0 1 0 0-.01M18 5a2 2 0 1 0 0-.01M15 18a2 2 0 1 0 0-.01M7.8 7.6l8.4-2M7.4 8.5l6.2 8.2',
  // Three columns.
  kanban: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
  // A question mark in a speech bubble.
  decisions: 'M4 5h16v11H9l-4 4v-4H4zM10 9a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.3M12 14h.01'
}
const FILTER_ICON = 'M4 5h16l-6 7.5V19l-4-2v-4.5z'
const LABELS: Record<ForgeMode, string> = { graph: 'Graph', kanban: 'Kanban', decisions: 'Decisions' }

const MobileBar: Component<MobileBarProps> = (props) => {
  const [menuOpen, setMenuOpen] = createSignal(false)
  let menuBtn: HTMLButtonElement | undefined
  let menuBox: HTMLDivElement | undefined
  useDismiss(
    menuOpen,
    () => [menuBtn, menuBox],
    () => setMenuOpen(false)
  )
  const close = (): void => void setMenuOpen(false)

  return (
    <div
      class="relative flex h-12 shrink-0 items-center gap-1 border-b px-1"
      style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)' }}
      data-testid="forge-mobile-bar"
    >
      <div class="flex shrink-0" role="tablist" data-testid="forge-mode">
        <For each={['graph', 'kanban', 'decisions'] as const}>
          {(m) => (
            <button
              class="relative flex h-10 min-w-10 items-center justify-center gap-1 rounded px-2"
              style={{
                color: props.mode === m ? 'var(--c-accent)' : 'var(--c-text-muted)',
                background: props.mode === m ? 'var(--c-hover-bg)' : 'transparent'
              }}
              role="tab"
              aria-selected={props.mode === m}
              aria-label={m === 'decisions' ? `Decisions (${props.openDecisions} open)` : LABELS[m]}
              title={LABELS[m]}
              onClick={() => props.onMode(m)}
              data-testid={`forge-mode-${m}`}
            >
              <Icon d={ICONS[m]} />
              <Show when={m === 'decisions' && props.openDecisions > 0}>
                <span class="text-xs font-semibold tabular-nums" data-testid="forge-mode-decisions-count">
                  {props.openDecisions}
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <select
        class="h-10 min-w-0 flex-1 truncate rounded border px-2 text-sm"
        style={fieldStyle}
        value={props.membrane ?? ''}
        onChange={(e) => props.onMembrane(e.currentTarget.value)}
        aria-label="Membrane"
        data-testid="forge-membrane"
      >
        {/* `selected` per option: the select's value can land before its options load. */}
        <For each={props.membranes}>
          {(m) => (
            <option value={m.id} selected={m.id === props.membrane}>
              {m.name}
            </option>
          )}
        </For>
      </select>

      <button
        class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded disabled:opacity-40"
        style={{ color: props.filterCount ? 'var(--c-accent)' : 'var(--c-text)' }}
        disabled={props.filterCount === null}
        onClick={() => props.onFilters()}
        aria-label={`Filters${props.filterCount ? ` (${props.filterCount} active)` : ''}`}
        title="Filters"
        data-testid="forge-mobile-filters"
      >
        <Icon d={FILTER_ICON} />
        <Show when={props.filterCount}>
          <span
            class="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold"
            style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
            data-testid="forge-mobile-filters-badge"
          >
            {props.filterCount}
          </span>
        </Show>
      </button>

      <button
        ref={menuBtn}
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded text-xl leading-none"
        style={{ color: 'var(--c-text)', background: menuOpen() ? 'var(--c-hover-bg)' : 'transparent' }}
        onClick={() => setMenuOpen(!menuOpen())}
        aria-label="More"
        aria-expanded={menuOpen()}
        title="More"
        data-testid="forge-mobile-menu"
      >
        ⋯
      </button>
      <Show when={menuOpen()}>
        <div
          ref={menuBox}
          class="absolute top-full right-1 z-[62] mt-1 max-h-[75dvh] w-[min(20rem,calc(100vw-0.5rem))] overflow-y-auto rounded-lg border py-1 shadow-xl"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          data-testid="forge-mobile-menu-box"
        >
          {props.menu(close)}
        </div>
      </Show>
    </div>
  )
}

/** A ⋯ menu row: 44 px tall, label left, an optional muted hint right. */
export const MenuItem: Component<{
  label: JSX.Element
  hint?: JSX.Element
  onClick: () => void
  disabled?: boolean
  testid?: string
}> = (p) => (
  <button
    class="flex min-h-11 w-full items-center gap-2 px-4 text-left text-sm disabled:opacity-40"
    style={{ color: 'var(--c-text)' }}
    disabled={p.disabled}
    onClick={() => p.onClick()}
    data-testid={p.testid}
  >
    <span class="flex-1">{p.label}</span>
    <Show when={p.hint}>
      <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
        {p.hint}
      </span>
    </Show>
  </button>
)

export default MobileBar

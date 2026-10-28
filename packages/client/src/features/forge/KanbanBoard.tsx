// The Kanban view of one graph panel: the cards kanbanCards sorts, in columns.
// A click selects the node, which opens the panel's NodeCard.

import { For, Show, type Component } from 'solid-js'
import type { AgentOverlay } from '@sovereign/core'
import { ReachBadge } from '../graphcoder/ReachBadge.js'
import { categoryBadge } from './card-model.js'
import { KANBAN_COLUMNS, type KanbanCard, type KanbanColumn } from './kanban-model.js'
import { CI_COLORS, REVIEW_COLORS, reviewSummary, ringFor } from './style.js'

export interface KanbanBoardProps {
  columns: Map<KanbanColumn, KanbanCard[]>
  overlays: () => Map<string, AgentOverlay>
  selectedId: () => string | null
  onSelect: (id: string) => void
}

const REVIEW_LABELS = {
  approved: 'approved',
  changes_requested: 'changes requested',
  requested: 'review requested',
  commented: 'commented',
  dismissed: 'dismissed'
} as const

const Card: Component<{ card: KanbanCard; overlay?: AgentOverlay; selected: boolean; onSelect: () => void }> = (
  props
) => {
  const n = () => props.card.node
  const ring = () => ringFor(props.overlay)
  const review = () => reviewSummary(n())
  const ci = () => (n().ci ? CI_COLORS[n().ci!] : null)
  const category = () => categoryBadge(n())
  return (
    <button
      class="w-full rounded border p-2 text-left text-xs hover:bg-[var(--c-hover-bg)]"
      style={{
        'border-color': props.selected ? 'var(--c-accent)' : 'var(--c-border)',
        background: 'var(--c-bg-raised, var(--c-bg))',
        color: 'var(--c-text)',
        'box-shadow': ring() ? `inset 3px 0 0 ${ring()!.color}` : undefined
      }}
      onClick={() => props.onSelect()}
      title={ring() ? `Agent: ${ring()!.kind}` : undefined}
      data-testid="forge-kanban-card"
      data-node={n().id}
    >
      <div class="flex items-start gap-1.5">
        <Show when={ci()}>
          <span class="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: ci()! }} title={`CI ${n().ci}`} />
        </Show>
        <span class="min-w-0 flex-1">
          <span style={{ color: 'var(--c-text-muted)' }}>#{n().number}</span> {n().title}
        </span>
        <Show when={category()}>
          {(c) => (
            <span
              class="shrink-0 rounded px-1 text-[10px] leading-4"
              style={{ color: c().fg, background: c().bg }}
              title={c().title}
              data-testid="forge-category-badge"
            >
              {c().label}
            </span>
          )}
        </Show>
      </div>
      <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5" style={{ color: 'var(--c-text-muted)' }}>
        <span>{n().repo}</span>
        <Show when={n().author}>
          <span>@{n().author}</span>
        </Show>
        <Show when={n().state === 'draft'}>
          <span>draft</span>
        </Show>
        <Show when={review()}>{(r) => <span style={{ color: REVIEW_COLORS[r()] }}>{REVIEW_LABELS[r()]}</span>}</Show>
        <Show when={n().branch?.conflict}>
          <span style={{ color: 'var(--c-error, #ef4444)' }}>conflict</span>
        </Show>
        <Show when={props.card.stack > 1}>
          <span data-testid="forge-kanban-stack">stack of {props.card.stack}</span>
        </Show>
        <Show when={props.card.closes.length}>
          <span>closes {props.card.closes.join(', ')}</span>
        </Show>
        <Show when={props.card.epic}>
          <span style={{ color: '#a855f7' }}>{props.card.epic}</span>
        </Show>
        <ReachBadge structure={n().structure} />
      </div>
    </button>
  )
}

const KanbanBoard: Component<KanbanBoardProps> = (props) => (
  <div class="flex h-full min-h-0 gap-2 overflow-x-auto p-2" data-testid="forge-kanban">
    <For each={KANBAN_COLUMNS}>
      {(col) => {
        const cards = () => props.columns.get(col.id) ?? []
        return (
          <div
            class="flex min-h-0 w-64 shrink-0 flex-col rounded border"
            style={{ 'border-color': 'var(--c-border)' }}
            data-testid="forge-kanban-column"
            data-column={col.id}
          >
            <div class="flex items-center gap-2 px-2 py-1 text-xs font-semibold" style={{ color: 'var(--c-text)' }}>
              {col.title}
              <span class="font-normal" style={{ color: 'var(--c-text-muted)' }}>
                {cards().length}
              </span>
            </div>
            <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
              <For each={cards()}>
                {(c) => (
                  <Card
                    card={c}
                    overlay={props.overlays().get(c.node.id)}
                    selected={props.selectedId() === c.node.id}
                    onSelect={() => props.onSelect(c.node.id)}
                  />
                )}
              </For>
            </div>
          </div>
        )
      }}
    </For>
  </div>
)

export default KanbanBoard

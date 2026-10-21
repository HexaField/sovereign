// A goal-tree node's card: what a click on its canvas card opens, beside the
// node card a work item opens. Status, progress, place in the tree, sub-nodes
// and items; "Focus the graph" keeps the old click (focus the canvas on its subtree).

import { createMemo, createSignal, For, Show, type Component } from 'solid-js'
import type { EpicStatus, WorkNode, WorkStream } from '@sovereign/core'
import { EpicStatusSelect } from './EpicStatusSelect.js'
import type { ForgeApi } from './api.js'
import { shortRef } from './card-model.js'
import { epicSource } from './epics-model.js'
import { EPIC_STATUS_COLORS, STATE_COLORS } from './style.js'
import { placeOptions, progressLabel, streamCard } from './tree-model.js'

export interface StreamCardProps {
  streamId: string
  streams: WorkStream[]
  nodes: WorkNode[]
  membrane: string
  api: Pick<ForgeApi, 'setStreamStatus' | 'setStreamParent'>
  /** Open another node's card (a sub-node's stream id) or an item's (its node id). */
  onOpen: (id: string, kind: 'stream' | 'item') => void
  /** Focus the canvas on this node's subtree (or, while it is the sole focus, show the whole graph again). */
  onFocusGraph: (streamId: string) => void
  /** It is the canvas's sole focus now. */
  focused: boolean
  /** A plan's stream whose plan node is loaded: open the plan's node card (links, assign, notes). */
  onPlanDetails?: () => void
  onClose: () => void
  onChanged: () => void
}

const sectionTitle = 'mb-1 mt-3 text-[10px] font-semibold tracking-wider uppercase'
const muted = { color: 'var(--c-text-muted)' }
const btn = 'rounded border px-2 py-0.5 text-xs transition-colors hover:opacity-80 disabled:opacity-40'
const btnStyle = { 'border-color': 'var(--c-border)', color: 'var(--c-text)', background: 'var(--c-bg)' }

const StreamCard: Component<StreamCardProps> = (props) => {
  const card = createMemo(() => streamCard(props.streams, props.streamId, props.nodes))
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      props.onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const setStatus = (status: EpicStatus) => run(() => props.api.setStreamStatus(props.membrane, props.streamId, status))
  const setParent = (parentId: string) =>
    run(() => props.api.setStreamParent(props.membrane, props.streamId, parentId || null))

  return (
    <Show when={card()}>
      {(c) => {
        const s = () => c().stream
        const p = () => s().progress
        const pct = () => (p()?.total ? Math.round((p()!.done / p()!.total) * 100) : 0)
        return (
          <div
            data-testid="forge-stream-card"
            class="flex max-h-full w-[360px] flex-col overflow-hidden rounded-lg border shadow-xl"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div class="flex items-start gap-2 border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
              <span
                class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: EPIC_STATUS_COLORS[s().status].fg }}
              />
              <div class="min-w-0 flex-1">
                <div class="truncate text-[11px]" style={muted} title={c().path.join(' › ')}>
                  {s().parentId ? 'Node' : 'Goal'}
                  <Show when={c().path.length > 1}> · {c().path.slice(0, -1).join(' › ')}</Show>
                </div>
                <div class="text-sm leading-snug font-semibold" data-testid="forge-stream-card-title">
                  {s().name}
                </div>
              </div>
              <button
                class="shrink-0 px-1 text-lg leading-none"
                style={muted}
                onClick={props.onClose}
                title="Close (Esc)"
              >
                ×
              </button>
            </div>

            <div class="overflow-y-auto px-3 pb-3 text-xs">
              <div class="mt-2 flex items-center gap-2">
                <EpicStatusSelect status={s().status} disabled={busy()} onChange={setStatus} />
                <span class="relative h-1.5 w-20 overflow-hidden rounded" style={{ background: 'var(--c-border)' }}>
                  <span
                    class="absolute inset-y-0 left-0 rounded"
                    style={{ width: `${pct()}%`, background: '#22c55e' }}
                  />
                </span>
                <span class="tabular-nums" style={muted} data-testid="forge-stream-card-progress">
                  {progressLabel(p()) || 'no items yet'}
                </span>
                <Show when={p()?.blocked}>
                  <span class="tabular-nums" style={{ color: 'var(--c-warning, #f59e0b)' }}>
                    ⛔{p()!.blocked} blocked
                  </span>
                </Show>
              </div>
              <Show when={epicSource(s())}>
                <div class="mt-1 break-all" style={muted}>
                  {epicSource(s())}
                </div>
              </Show>

              <label class="mt-2 flex items-center gap-1" title="Move to… its one parent in the goal tree">
                <span style={muted}>In node:</span>
                <select
                  class="min-w-0 flex-1 rounded border px-1 py-0.5 text-xs"
                  style={btnStyle}
                  value={s().parentId ?? ''}
                  disabled={busy()}
                  onChange={(e) => setParent(e.currentTarget.value)}
                  data-testid="forge-stream-card-parent"
                >
                  <option value="">Top level (a goal)</option>
                  <For each={placeOptions(props.streams, s().id)}>{(o) => <option value={o.id}>{o.label}</option>}</For>
                </select>
              </label>

              <button
                class={`${btn} mt-2`}
                style={btnStyle}
                onClick={() => props.onFocusGraph(s().id)}
                title="Show only this node's subtree on the canvas, Kanban and lanes"
                data-testid="forge-stream-card-focus"
              >
                {props.focused ? 'Show the whole graph' : 'Focus the graph on this branch'}
              </button>
              <Show when={props.onPlanDetails}>
                {(open) => (
                  <button
                    class={`${btn} mt-2 ml-1`}
                    style={btnStyle}
                    onClick={() => open()()}
                    title="The plan's node card: the items it names, assign to a thread, rethink notes"
                    data-testid="forge-stream-card-plan"
                  >
                    Plan details…
                  </button>
                )}
              </Show>

              <Show when={c().children.length}>
                <div class={sectionTitle} style={muted}>
                  Sub-nodes ({c().children.length})
                </div>
                <For each={c().children}>
                  {(child) => (
                    <button
                      class="flex w-full items-center gap-1.5 truncate text-left hover:underline"
                      onClick={() => props.onOpen(child.id, 'stream')}
                      data-testid="forge-stream-card-child"
                    >
                      <span
                        class="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: EPIC_STATUS_COLORS[child.status].fg }}
                      />
                      <span class="min-w-0 flex-1 truncate" style={{ color: 'var(--c-accent)' }}>
                        {child.name}
                      </span>
                      <span class="shrink-0 tabular-nums" style={muted}>
                        {progressLabel(child.progress)}
                      </span>
                    </button>
                  )}
                </For>
              </Show>

              <div class={sectionTitle} style={muted}>
                Items ({c().leaves.length})
              </div>
              <Show when={c().leaves.length} fallback={<div style={muted}>None loaded in this window.</div>}>
                <For each={c().leaves}>
                  {(n) => (
                    <button
                      class="flex w-full items-center gap-1.5 truncate text-left hover:underline"
                      onClick={() => props.onOpen(n.id, 'item')}
                      data-testid="forge-stream-card-item"
                    >
                      <span class="h-2 w-2 shrink-0 rounded-full" style={{ background: STATE_COLORS[n.state] }} />
                      <span class="min-w-0 flex-1 truncate" style={{ color: 'var(--c-accent)' }}>
                        {shortRef(n)} {n.number !== undefined ? n.title : ''}
                      </span>
                      <Show when={n.paused}>
                        <span class="shrink-0" style={{ color: EPIC_STATUS_COLORS.paused.fg }}>
                          paused
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>

              <Show when={error()}>
                <div class="mt-2" style={{ color: 'var(--c-error, #ef4444)' }} data-testid="forge-stream-card-error">
                  {error()}
                </div>
              </Show>
            </div>
          </div>
        )
      }}
    </Show>
  )
}

export default StreamCard

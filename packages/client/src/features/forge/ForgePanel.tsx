// One graph panel: its own window of the work graph, filters, canvas,
// tree panel and node card.

import { batch, createEffect, createMemo, createSignal, on, onCleanup, Show, type Component } from 'solid-js'
import type { AgentOverlay, ForgeFilters, ForgeView } from '@sovereign/core'
import ForgeCanvas, { type CanvasHandle } from './ForgeCanvas.js'
import FilterBar from './FilterBar.js'
import NodeCard, { type ThreadChoice } from './NodeCard.js'
import TreePanel from './TreePanel.js'
import type { ForgeApi } from './api.js'
import { keyDirection, walkEdge } from './edge-walk.js'
import {
  clearEpics,
  epicFocus,
  laneFold,
  laneStreams,
  panelShown,
  panelVisibility,
  wantsArchived
} from './epics-model.js'
import KanbanBoard from './KanbanBoard.js'
import { kanbanCards, type ForgeMode } from './kanban-model.js'
import { applyFilters, filterOptions, stableOptions, type FilterOptions } from './filters.js'
import { viewFilters } from './graphs.js'
import { computeLayout, xToTime } from './layout.js'
import { binDaysFor, COLLAPSE_SCALE } from './lod.js'
import { buildScene } from './scene.js'
import { visibleWorld, type Viewport } from './viewport.js'
import {
  NODE_CAP,
  applySearch,
  applyWindow,
  emptyWindow,
  initialRequest,
  nextRequest,
  trimToCap,
  unpinAll,
  widenRequest,
  type WindowRequest,
  type WindowState
} from './window-model.js'

export interface ForgePanelProps {
  membrane: string
  view: ForgeView
  api: ForgeApi
  overlays: () => Map<string, AgentOverlay>
  /** Bumps on 'forge.updated' for this membrane. */
  refresh: () => number
  threads: () => ThreadChoice[]
  onViewChange: (patch: Partial<Omit<ForgeView, 'id' | 'membrane'>>) => void
  onOpenThread: (id: string) => void
  /** Fill the remaining height instead of the view's own. */
  fill: boolean
  /** The work graph canvas, or the Kanban of its immediate items. */
  mode: ForgeMode
}

const SEARCH_MIN = 3

const ForgePanel: Component<ForgePanelProps> = (props) => {
  const [win, setWin] = createSignal<WindowState>(emptyWindow(props.membrane, Date.now()))
  const [layoutNow, setLayoutNow] = createSignal(Date.now())
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [selected, setSelected] = createSignal<string | null>(null)
  const [searching, setSearching] = createSignal(false)
  const [lod, setLod] = createSignal<{ key: number; scale: number }>({ key: 0, scale: 1 })
  let canvas: CanvasHandle | undefined
  let root!: HTMLDivElement
  let searchInput: HTMLInputElement | undefined
  let lastFocusTime = Date.now()
  const inflight = new Set<string>()

  const load = async (req: WindowRequest): Promise<void> => {
    const key = `${req.side}:${req.since}:${req.until}`
    if (inflight.has(key)) return
    inflight.add(key)
    setLoading(true)
    try {
      const graph = await props.api.graph(props.membrane, req, props.view.id, { archived: wantsArchived(filters()) })
      batch(() => {
        if (req.side === 'initial') setLayoutNow(Date.now())
        setWin((s) => trimToCap(applyWindow(s, graph, req), NODE_CAP, lastFocusTime))
        setError(null)
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inflight.delete(key)
      setLoading(inflight.size > 0)
    }
  }

  // Initial load, and a refetch of the live window on every forge.updated and
  // when the Archived epic chip turns on or off.
  createEffect(on([() => props.refresh(), () => wantsArchived(filters())], () => void load(initialRequest(Date.now()))))

  // ── Derived graph state ──────────────────────────────────────────
  const nodes = createMemo(() => [...win().nodes.values()])
  const nodesById = createMemo(() => win().nodes)
  const filters = createMemo(() => viewFilters(props.view))
  const layout = createMemo(() =>
    computeLayout({
      nodes: nodes(),
      edges: win().edges,
      workstreams: laneStreams(filters(), win().workstreams),
      laneFold: laneFold(filters(), win().workstreams),
      now: layoutNow(),
      since: win().since,
      related: filters().epicRelated === true
    })
  )
  const filtered = createMemo(() =>
    applyFilters(nodes(), filters(), { me: win().identity, overlays: props.overlays(), now: Date.now() })
  )
  const focus = createMemo(() => epicFocus(filters(), win().workstreams, nodes(), layout().edges))
  const visibility = createMemo(() => panelVisibility(filtered(), focus(), filters().dim))
  const kanban = createMemo(() =>
    props.mode === 'kanban'
      ? kanbanCards({
          nodesById: nodesById(),
          edges: win().edges,
          shown: panelShown(visibility()),
          overlays: props.overlays(),
          streams: win().workstreams
        })
      : null
  )
  const scene = createMemo(() => {
    if (!nodes().length) return null
    const v = visibility()
    return buildScene(layout(), nodesById(), v.visible, v.dimmed, lod().scale)
  })
  // Option order holds across loads and picks (stableOptions).
  let lastOptions: FilterOptions | undefined
  const options = createMemo(() => (lastOptions = stableOptions(lastOptions, filterOptions(nodes()), filters())))
  const highlight = createMemo(() => {
    const id = selected()
    return id ? new Set([id]) : undefined
  })

  // ── Viewport → progressive disclosure ────────────────────────────
  let viewTimer: ReturnType<typeof setTimeout> | undefined
  const onViewport = (vp: Viewport, width: number, height: number): void => {
    const key = vp.scale < COLLAPSE_SCALE ? binDaysFor(vp.scale) : 0
    if (key !== lod().key) setLod({ key, scale: vp.scale })
    const w = visibleWorld(vp, width, height)
    const now = layoutNow()
    lastFocusTime = xToTime(Math.min(w.x + w.w / 2, 0), now)
    clearTimeout(viewTimer)
    viewTimer = setTimeout(() => {
      if (w.x >= 0) return // The past is off screen.
      const from = xToTime(w.x, now)
      const to = xToTime(Math.min(w.x + w.w, 0), now)
      const req = nextRequest(win(), from, to, Date.now())
      if (req) void load(req)
    }, 250)
  }
  onCleanup(() => clearTimeout(viewTimer))

  // ── History search: pin matches from the full history. ───────────
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchSeq = 0
  createEffect(
    on(
      () => filters().text?.trim() ?? '',
      (q, prev) => {
        clearTimeout(searchTimer)
        if (q.length < SEARCH_MIN) {
          if (prev && prev.length >= SEARCH_MIN) setWin((s) => unpinAll(s))
          setSearching(false)
          return
        }
        const seq = ++searchSeq
        searchTimer = setTimeout(async () => {
          setSearching(true)
          try {
            const res = await props.api.search(props.membrane, q)
            if (seq === searchSeq) setWin((s) => applySearch(s, res))
          } catch (e) {
            if (seq === searchSeq) setError(e instanceof Error ? e.message : String(e))
          } finally {
            if (seq === searchSeq) setSearching(false)
          }
        }, 400)
      },
      { defer: true }
    )
  )
  onCleanup(() => clearTimeout(searchTimer))

  const setFilters = (f: ForgeFilters): void => props.onViewChange({ filters: f })

  const focusNode = (raw: string): void => {
    // A branch drawn as its change focuses the change. A node hidden by the
    // filters still gets selected, and the view pans to where it would be.
    const id = layout().alias.get(raw) ?? raw
    setSelected(id)
    if (props.mode === 'graph') canvas?.focusNode(id)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return
    if (e.key === '/') {
      e.preventDefault()
      searchInput?.focus()
      return
    }
    if (e.key === 'f' || e.key === 'F') {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      if (props.mode === 'graph') canvas?.fit()
      return
    }
    if (e.key === 'Escape') {
      if (selected()) setSelected(null)
      else if (filters().workstreams?.length || filters().epicStatus?.length) setFilters(clearEpics(props.view.filters))
      else if (filters().text) setFilters({ ...props.view.filters, text: undefined })
      return
    }
    const dir = keyDirection(e.key)
    const cur = selected()
    if (dir && cur) {
      e.preventDefault()
      const next = walkEdge(cur, dir, layout().edges, layout().nodes, (id) => visibility().visible.has(id))
      if (next) focusNode(next)
    }
  }

  const history = (): void => {
    const req = widenRequest(win())
    if (req) void load(req)
  }

  const createStream = async (name: string, parentId?: string): Promise<void> => {
    const s = await props.api.createStream(props.membrane, name, parentId)
    setWin((w) => ({ ...w, workstreams: [...w.workstreams.filter((x) => x.id !== s.id), s] }))
  }

  const sinceLabel = createMemo(() => new Date(win().since).toLocaleDateString())

  return (
    <div
      ref={root}
      tabIndex={0}
      class="flex min-h-0 flex-col border-b outline-none"
      classList={{ 'flex-1': props.fill }}
      style={{ 'border-color': 'var(--c-border)', height: props.fill ? undefined : `${props.view.height ?? 460}px` }}
      onKeyDown={onKeyDown}
      data-testid="forge-panel"
      data-view={props.view.id}
    >
      <div class="flex items-center gap-2 px-2 pt-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
        <span class="font-semibold" style={{ color: 'var(--c-text-heading, var(--c-text))' }}>
          {props.view.title}
        </span>
        <span data-testid="forge-count">
          {visibility().visible.size} / {win().nodes.size} nodes
        </span>
        <span>· history from {sinceLabel()}</span>
        <Show when={win().syncing}>
          <span style={{ color: 'var(--c-warning, #f59e0b)' }}>· first sync running…</span>
        </Show>
        <Show when={win().syncOff}>
          <span data-testid="forge-sync-off">· GitHub sync off (forge.enabled)</span>
        </Show>
        <Show when={win().lastSyncAt}>
          <span>· synced {new Date(win().lastSyncAt!).toLocaleTimeString()}</span>
        </Show>
        <Show when={loading()}>
          <span data-testid="forge-loading">· loading…</span>
        </Show>
        <Show when={error()}>
          <span style={{ color: 'var(--c-error, #ef4444)' }} data-testid="forge-error">
            · {error()}
          </span>
        </Show>
        <span class="flex-1" />
        <TreePanel
          membrane={props.membrane}
          streams={win().workstreams}
          nodes={nodes()}
          filters={props.view.filters}
          onChange={setFilters}
          api={props.api}
          onCreate={createStream}
          onChanged={() => void load(initialRequest(Date.now()))}
          onFocusNode={focusNode}
          onOpenThread={props.onOpenThread}
        />
        <button
          class="rounded border px-2 py-0.5 disabled:opacity-40"
          style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          onClick={history}
          disabled={win().exhausted}
          title="Load three more weeks of history"
          data-testid="forge-history"
        >
          ← History
        </button>
        <Show when={props.mode === 'graph'}>
          <button
            class="rounded border px-2 py-0.5"
            style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            onClick={() => canvas?.fit()}
            title="Fit (F)"
          >
            Fit
          </button>
        </Show>
      </div>
      <FilterBar
        filters={props.view.filters}
        options={options()}
        onChange={setFilters}
        searchRef={(el) => (searchInput = el)}
        searching={searching()}
        hasIdentity={!!win().identity}
      />
      <div class="flex min-h-0 flex-1">
        <div class="relative min-w-0 flex-1" onPointerDown={() => root.focus({ preventScroll: true })}>
          <Show
            when={kanban()}
            fallback={
              <ForgeCanvas
                scene={scene}
                overlays={props.overlays}
                selectedId={selected}
                highlight={highlight}
                onSelect={setSelected}
                onViewport={onViewport}
                ref={(h) => (canvas = h)}
              />
            }
          >
            {(columns) => (
              <KanbanBoard columns={columns()} overlays={props.overlays} selectedId={selected} onSelect={setSelected} />
            )}
          </Show>
          <Show when={!nodes().length && !loading()}>
            <div
              class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm"
              style={{ color: 'var(--c-text-muted)' }}
            >
              {error()
                ? 'Could not load the work graph.'
                : win().syncing
                  ? 'First sync running…'
                  : 'Nothing in this window.'}
            </div>
          </Show>
          {/* Keyed on the id, not the node: a refetch replaces the node object and must not reset the card. */}
          <Show when={selected()} keyed>
            {(id) => (
              <Show when={nodesById().get(id)}>
                {(node) => (
                  <div class="absolute top-2 right-2 bottom-2 z-10 flex flex-col">
                    <NodeCard
                      node={node()}
                      nodesById={nodesById()}
                      edges={win().edges}
                      streams={win().workstreams}
                      overlay={props.overlays().get(id)}
                      membrane={props.membrane}
                      api={props.api}
                      threads={props.threads}
                      onFocus={focusNode}
                      onClose={() => setSelected(null)}
                      onOpenThread={props.onOpenThread}
                      onChanged={() => void load(initialRequest(Date.now()))}
                    />
                  </div>
                )}
              </Show>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}

export default ForgePanel

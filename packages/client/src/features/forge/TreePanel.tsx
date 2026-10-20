// Tree panel: the membrane's goal tree. Goals (streams with no parent) at the
// top, nodes below, each node's leaves (its PRs, issues and tasks) folded until
// opened. Each node shows its progress over its subtree (done/total), its
// blocked count and its status. Pick nodes to focus the canvas, lanes and
// Kanban on their subtrees, by status chip or one by one; place a node by
// dragging it onto another (or onto "top level"), or with "Move to…"; drag a
// leaf onto a node to move it there. Opens from the "Tree (n)" button as a
// dropdown or as a centred window; the header button switches and the choice
// persists. "Refine the tree…" goes to the membrane's forge-rethink thread.
// Logic lives in epics-model.ts and tree-model.ts.

import { createMemo, createSignal, For, Show, type Component, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { EpicStatus, ForgeFilters, WorkNode, WorkStream } from '@sovereign/core'
import { EPIC_STATUSES, leafState } from '@sovereign/core/forge'
import type { ForgeApi } from './api.js'
import { useDismiss } from './dismiss.js'
import {
  clearEpics,
  epicSource,
  LS_EPICS_MODE,
  orderEpics,
  otherEpicsMode,
  parseEpicsMode,
  pickedEpics,
  searchEpics,
  selectedEpics,
  setDim,
  setEpicNeighbours,
  setEpicRelated,
  shownEpics,
  shownStatuses,
  toggleEpic,
  toggleEpicStatus,
  type EpicsMode
} from './epics-model.js'
import { EpicStatusSelect } from './EpicStatusSelect.js'
import { EPIC_STATUS_COLORS, EPIC_STATUS_LABELS } from './style.js'
import { canPlace, placeOptions, progressLabel, streamPath, treeButtonLabel, treeRows } from './tree-model.js'

export interface TreePanelProps {
  membrane: string
  /** The membrane's streams as the graph serves them (archived ones only while the Archived chip is on). */
  streams: WorkStream[]
  /** The loaded nodes: a node's leaves are its members among them. */
  nodes: WorkNode[]
  filters: ForgeFilters
  onChange: (f: ForgeFilters) => void
  api: Pick<ForgeApi, 'setStreamStatus' | 'setStreamParent' | 'addMember' | 'removeMember' | 'refineEpics'>
  onCreate: (name: string, parentId?: string) => Promise<void>
  /** The tree changed server-side (status, placement, membership): reload the window. */
  onChanged: () => void
  /** A leaf was clicked: select it (its node card opens). */
  onFocusNode: (id: string) => void
  onOpenThread: (id: string) => void
}

type RefineState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; threadId: string }
  | { kind: 'failed'; error: string }

type Drag = { kind: 'stream'; id: string } | { kind: 'leaf'; id: string; from: string }

const readMode = (): EpicsMode => {
  try {
    return parseEpicsMode(localStorage.getItem(LS_EPICS_MODE))
  } catch {
    return 'dropdown'
  }
}
const writeMode = (m: EpicsMode): void => {
  try {
    localStorage.setItem(LS_EPICS_MODE, m)
  } catch {
    /* storage full or disabled */
  }
}

const btn = 'rounded border px-2 py-0.5 text-xs transition-colors disabled:opacity-40 hover:bg-[var(--c-hover-bg)]'
const field = { 'border-color': 'var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-text)' }
const muted = { color: 'var(--c-text-muted)' }
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const toggled = (set: Set<string>, id: string): Set<string> => {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

const LEAF_GLYPH: Record<string, string> = { change: '⇄', issue: '◎', task: '☐' }
const LEAF_TONE = { open: 'var(--c-text)', done: '#22c55e', cancelled: 'var(--c-text-muted)' } as const

const TreePanel: Component<TreePanelProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [mode, setMode] = createSignal<EpicsMode>(readMode())
  const [query, setQuery] = createSignal('')
  const [name, setName] = createSignal('')
  const [parent, setParent] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [refineText, setRefineText] = createSignal('')
  const [refine, setRefine] = createSignal<RefineState>({ kind: 'idle' })
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())
  const [openLeaves, setOpenLeaves] = createSignal<Set<string>>(new Set())
  const [drag, setDrag] = createSignal<Drag | null>(null)
  const [dropOn, setDropOn] = createSignal<string | null>(null)
  let toggleEl: HTMLButtonElement | undefined
  let boxEl: HTMLDivElement | undefined
  useDismiss(
    open,
    () => [boxEl, toggleEl],
    () => setOpen(false)
  )

  const listed = createMemo(() => shownEpics(props.filters, props.streams))
  const rows = createMemo(() => orderEpics(listed()))
  const outline = createMemo(() =>
    treeRows(searchEpics(rows(), query()), props.nodes, { collapsed: collapsed(), openLeaves: openLeaves() })
  )
  /** Ticked rows: the nodes picked one by one. */
  const picked = createMemo(() => new Set(pickedEpics(props.filters, props.streams)))
  /** Picked, or every listed node while status chips select. */
  const selected = createMemo(() => new Set(selectedEpics(props.filters, props.streams)))
  const statusChosen = (s: EpicStatus): boolean => props.filters.epicStatus?.includes(s) === true

  const switchMode = (): void => {
    const next = otherEpicsMode(mode())
    setMode(next)
    writeMode(next)
  }

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      props.onChanged()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const create = async (): Promise<void> => {
    const n = name().trim()
    if (!n) return
    setBusy(true)
    setError(null)
    try {
      await props.onCreate(n, parent() || undefined)
      setName('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const setStatus = (s: WorkStream, status: EpicStatus): void => {
    if (status === s.status) return
    void act(async () => {
      await props.api.setStreamStatus(props.membrane, s.id, status)
      // A picked node whose new status is not listed leaves the selection.
      if (picked().has(s.id) && !shownStatuses(props.filters).includes(status))
        props.onChange(toggleEpic(props.filters, s.id))
    })
  }

  const place = (id: string, parentId: string | null): void => {
    if (!canPlace(props.streams, id, parentId)) return
    void act(() => props.api.setStreamParent(props.membrane, id, parentId))
  }

  /** A leaf moves to another node: a PR or issue leaves its old owner on the server; a task leaves it here. */
  const moveLeaf = (node: WorkNode, from: string, to: string): void => {
    if (from === to) return
    void act(async () => {
      await props.api.addMember(to, node.id)
      if (node.kind !== 'change' && node.kind !== 'issue') await props.api.removeMember(from, node.id)
    })
  }

  const sendRefine = async (): Promise<void> => {
    const text = refineText().trim()
    if (!text) return
    setRefine({ kind: 'sending' })
    try {
      const { threadId } = await props.api.refineEpics(props.membrane, text)
      setRefine({ kind: 'sent', threadId })
      setRefineText('')
    } catch (e) {
      setRefine({ kind: 'failed', error: errorMessage(e) })
    }
  }

  // ── Drag and drop ────────────────────────────────────────────────
  const canDropOn = (target: string | null): boolean => {
    const d = drag()
    if (!d) return false
    if (d.kind === 'stream') return canPlace(props.streams, d.id, target)
    return target !== null && target !== d.from
  }
  const dropProps = (target: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!canDropOn(target)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      setDropOn(target ?? '')
    },
    onDragLeave: () => {
      if (dropOn() === (target ?? '')) setDropOn(null)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      const d = drag()
      setDrag(null)
      setDropOn(null)
      if (!d || !canDropOn(target)) return
      if (d.kind === 'stream') place(d.id, target)
      else {
        const node = props.nodes.find((n) => n.id === d.id)
        if (node && target) moveLeaf(node, d.from, target)
      }
    }
  })
  const dragProps = (d: Drag) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      setDrag(d)
      e.dataTransfer?.setData('text/plain', d.id)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    },
    onDragEnd: () => {
      setDrag(null)
      setDropOn(null)
    }
  })

  const moveSelect = (opts: {
    current?: string
    options: Array<{ id: string; label: string }>
    top: boolean
    onPick: (id: string | null) => void
    testid: string
  }): JSX.Element => (
    <select
      class="w-5 shrink-0 cursor-pointer rounded border-0 bg-transparent px-0 text-[11px] opacity-50 group-hover:opacity-100"
      style={muted}
      value=""
      title="Move to…"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.currentTarget.value
        e.currentTarget.value = ''
        if (v) opts.onPick(v === '__top__' ? null : v)
      }}
      data-testid={opts.testid}
    >
      <option value="">Move to…</option>
      <Show when={opts.top}>
        <option value="__top__">Top level (a goal)</option>
      </Show>
      <For each={opts.options.filter((o) => o.id !== opts.current)}>
        {(o) => <option value={o.id}>{o.label}</option>}
      </For>
    </select>
  )

  const progressBar = (s: WorkStream): JSX.Element => {
    const p = s.progress
    const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0
    return (
      <span
        class="flex shrink-0 items-center gap-1"
        title={
          p && p.total
            ? `${p.done} of ${p.total} leaves done over this node's subtree (cancelled ones left out)${p.blocked ? ` · ${p.blocked} blocked behind another open PR` : ''}`
            : 'No leaves yet'
        }
        data-testid="forge-tree-progress"
      >
        <span class="relative h-1.5 w-12 overflow-hidden rounded" style={{ background: 'var(--c-border)' }}>
          <span class="absolute inset-y-0 left-0 rounded" style={{ width: `${pct}%`, background: '#22c55e' }} />
        </span>
        <span class="w-9 text-right tabular-nums" style={muted}>
          {progressLabel(p)}
        </span>
        <Show when={p?.blocked}>
          <span class="tabular-nums" style={{ color: 'var(--c-warning, #f59e0b)' }} data-testid="forge-tree-blocked">
            ⛔{p!.blocked}
          </span>
        </Show>
      </span>
    )
  }

  const streamRow = (r: Extract<ReturnType<typeof outline>[number], { kind: 'stream' }>): JSX.Element => {
    const s = r.stream
    return (
      <div
        class="group flex items-center gap-1 py-0.5 pr-2 hover:bg-[var(--c-hover-bg)]"
        style={{
          'padding-left': `${6 + r.depth * 14}px`,
          outline: dropOn() === s.id ? '1px dashed var(--c-accent)' : undefined
        }}
        {...dragProps({ kind: 'stream', id: s.id })}
        {...dropProps(s.id)}
        data-testid="forge-tree-node"
        data-depth={r.depth}
      >
        <button
          class="w-3 shrink-0 text-[10px]"
          style={{ ...muted, visibility: r.hasChildren ? 'visible' : 'hidden' }}
          onClick={() => setCollapsed((c) => toggled(c, s.id))}
          title={collapsed().has(s.id) ? 'Show the nodes below' : 'Hide the nodes below'}
        >
          {collapsed().has(s.id) ? '▸' : '▾'}
        </button>
        <label
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
          title={`${streamPath(props.streams, s.id).join(' › ')}${epicSource(s) ? ` — ${epicSource(s)}` : ' — made by hand'}`}
        >
          <input
            type="checkbox"
            checked={picked().has(s.id)}
            onChange={() => props.onChange(toggleEpic(props.filters, s.id))}
          />
          <span
            class="truncate"
            style={{
              color: selected().has(s.id) ? 'var(--c-accent)' : 'var(--c-text)',
              'font-weight': r.depth === 0 ? 600 : 400
            }}
          >
            {s.name}
          </span>
          <Show when={s.plan}>
            <span class="text-[10px]" style={muted}>
              plan
            </span>
          </Show>
        </label>
        {progressBar(s)}
        <button
          class="w-9 shrink-0 text-right text-[10px] tabular-nums disabled:opacity-30"
          style={{ color: openLeaves().has(s.id) ? 'var(--c-accent)' : 'var(--c-text-muted)' }}
          disabled={!r.leaves}
          onClick={() => setOpenLeaves((o) => toggled(o, s.id))}
          title={`${r.leaves} item${r.leaves === 1 ? '' : 's'} of its own loaded (sub-nodes not counted)${s.relatedCount ? ` · ${s.relatedCount} related` : ''}`}
          data-testid="forge-tree-leaves"
        >
          {r.leaves}
          {openLeaves().has(s.id) ? '▾' : '▸'}
        </button>
        <EpicStatusSelect status={s.status} onChange={(v) => setStatus(s, v)} />
        {moveSelect({
          current: s.parentId,
          options: placeOptions(props.streams, s.id),
          top: !!s.parentId,
          onPick: (to) => place(s.id, to),
          testid: 'forge-tree-move'
        })}
      </div>
    )
  }

  const leafRow = (r: Extract<ReturnType<typeof outline>[number], { kind: 'leaf' }>): JSX.Element => {
    const n = r.node
    const st = leafState(n) ?? 'open'
    return (
      <div
        class="group flex items-center gap-1 py-0.5 pr-2 hover:bg-[var(--c-hover-bg)]"
        style={{ 'padding-left': `${22 + r.depth * 14}px` }}
        {...dragProps({ kind: 'leaf', id: n.id, from: r.streamId })}
        data-testid="forge-tree-leaf"
      >
        <span class="w-3 shrink-0 text-center" style={muted}>
          {LEAF_GLYPH[n.kind] ?? '·'}
        </span>
        <button
          class="min-w-0 flex-1 truncate text-left hover:underline"
          style={{ color: LEAF_TONE[st], 'text-decoration-line': st === 'cancelled' ? 'line-through' : undefined }}
          title={`${n.repo ? `${n.repo}#${n.number} ` : ''}${n.title} — ${n.state}`}
          onClick={() => props.onFocusNode(n.id)}
        >
          {n.number !== undefined ? `#${n.number} ` : ''}
          {n.title}
        </button>
        <span class="shrink-0 text-[10px]" style={{ color: LEAF_TONE[st] }}>
          {st === 'done' ? '✓' : st === 'cancelled' ? '✕' : n.state}
        </span>
        {moveSelect({
          current: r.streamId,
          options: placeOptions(props.streams),
          top: false,
          onPick: (to) => to && moveLeaf(n, r.streamId, to),
          testid: 'forge-tree-leaf-move'
        })}
      </div>
    )
  }

  const toggleRow = (label: string, checked: boolean, onChange: (v: boolean) => void, testid: string): JSX.Element => (
    <label class="flex cursor-pointer items-center gap-1">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        data-testid={testid}
      />
      {label}
    </label>
  )

  const body = (): JSX.Element => (
    <>
      <div class="flex items-center gap-2 border-b px-3 py-1.5" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="flex-1 text-xs font-semibold">Goal tree ({rows().length})</span>
        <button
          class={btn}
          style={field}
          title={mode() === 'dropdown' ? 'Open in a window' : 'Show as a dropdown'}
          onClick={switchMode}
          data-testid="forge-tree-mode"
        >
          {mode() === 'dropdown' ? '⤢ Window' : '⤡ Dropdown'}
        </button>
        <button class={btn} style={field} title="Close (Esc)" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>

      <div class="flex flex-col gap-1 border-b px-3 py-1.5" style={{ 'border-color': 'var(--c-border)' }}>
        <div class="flex items-center gap-1">
          <input
            ref={(el) => queueMicrotask(() => el.focus({ preventScroll: true }))}
            type="search"
            class="min-w-0 flex-1 rounded border px-1.5 py-0.5"
            style={field}
            placeholder="Search goals and nodes"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            data-testid="forge-tree-search"
          />
          <Show when={picked().size || props.filters.epicStatus?.length}>
            <button
              class={btn}
              style={field}
              title="Clear the picked nodes and the status chips"
              onClick={() => props.onChange(clearEpics(props.filters))}
              data-testid="forge-tree-clear"
            >
              Clear ({selected().size})
            </button>
          </Show>
        </div>
        <div class="flex items-center gap-1" role="group" aria-label="Node status">
          <For each={EPIC_STATUSES}>
            {(s) => (
              <button
                class={btn}
                style={{
                  ...field,
                  color: statusChosen(s) ? EPIC_STATUS_COLORS[s].fg : 'var(--c-text-muted)',
                  background: statusChosen(s) ? EPIC_STATUS_COLORS[s].bg : 'var(--c-bg)'
                }}
                aria-pressed={statusChosen(s)}
                title={`Show ${EPIC_STATUS_LABELS[s].toLowerCase()} nodes; with none ticked below, select them all`}
                onClick={() => props.onChange(toggleEpicStatus(props.filters, s))}
                data-testid={`forge-tree-status-${s}`}
              >
                {EPIC_STATUS_LABELS[s]}
              </button>
            )}
          </For>
        </div>
        <div class="flex items-center gap-1" role="group" aria-label="What a node shows">
          <For each={[false, true]}>
            {(on) => (
              <button
                class={btn}
                style={{
                  ...field,
                  color: (props.filters.epicRelated === true) === on ? 'var(--c-accent)' : 'var(--c-text-muted)'
                }}
                aria-pressed={(props.filters.epicRelated === true) === on}
                title={
                  on
                    ? 'Also show what is related to the picked nodes (named by their plans), dashed in their lanes'
                    : 'Show only what the picked nodes own'
                }
                onClick={() => props.onChange(setEpicRelated(props.filters, on))}
                data-testid={on ? 'forge-tree-related' : 'forge-tree-owned'}
              >
                {on ? 'Owned + related' : 'Owned'}
              </button>
            )}
          </For>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5" style={muted}>
          {toggleRow(
            'Include neighbours',
            props.filters.epicNeighbours !== false,
            (v) => props.onChange(setEpicNeighbours(props.filters, v)),
            'forge-tree-neighbours'
          )}
          {toggleRow(
            'Dim instead',
            !!props.filters.dim,
            (v) => props.onChange(setDim(props.filters, v)),
            'forge-tree-dim'
          )}
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto py-1" data-testid="forge-tree-list">
        <Show when={drag()?.kind === 'stream'}>
          <div
            class="mx-3 mb-1 rounded border border-dashed px-2 py-1 text-center"
            style={{
              'border-color': dropOn() === '' ? 'var(--c-accent)' : 'var(--c-border)',
              color: canDropOn(null) ? 'var(--c-text)' : 'var(--c-text-muted)'
            }}
            {...dropProps(null)}
            data-testid="forge-tree-drop-top"
          >
            Drop here: top level (a goal)
          </div>
        </Show>
        <Show
          when={outline().length}
          fallback={
            <div class="px-3 py-2 opacity-60">
              {rows().length
                ? 'No node matches'
                : props.streams.length
                  ? 'No node with these statuses'
                  : 'No goals yet'}
            </div>
          }
        >
          <For each={outline()}>{(r) => (r.kind === 'stream' ? streamRow(r) : leafRow(r))}</For>
        </Show>
      </div>

      <div class="flex flex-col gap-1 border-t px-3 py-1.5" style={{ 'border-color': 'var(--c-border)' }}>
        <div class="flex gap-1">
          <input
            class="min-w-0 flex-1 rounded border px-1.5 py-0.5"
            style={field}
            placeholder={parent() ? 'New node' : 'New goal'}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            data-testid="forge-stream-name"
          />
          <Show when={props.streams.length}>
            <select
              class="w-32 rounded border px-1 py-0.5"
              style={field}
              value={parent()}
              onChange={(e) => setParent(e.currentTarget.value)}
            >
              <option value="">As a goal</option>
              <For each={placeOptions(listed())}>{(o) => <option value={o.id}>Inside {o.label}</option>}</For>
            </select>
          </Show>
          <button
            class={btn}
            style={field}
            disabled={busy() || !name().trim()}
            onClick={() => void create()}
            data-testid="forge-stream-create"
          >
            Create
          </button>
        </div>
        <textarea
          class="min-h-[3.5rem] rounded border px-1.5 py-1"
          style={field}
          placeholder="Refine the tree… e.g. “put the auth plans under a Closed beta goal, archive the empty ones”"
          value={refineText()}
          onInput={(e) => setRefineText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendRefine()
          }}
          data-testid="forge-tree-refine"
        />
        <div class="flex items-center gap-2">
          <button
            class={btn}
            style={field}
            disabled={refine().kind === 'sending' || !refineText().trim()}
            onClick={() => void sendRefine()}
            title="Send to this membrane's forge-rethink thread (Ctrl/⌘+Enter)"
            data-testid="forge-tree-refine-send"
          >
            {refine().kind === 'sending' ? 'Sending…' : 'Send'}
          </button>
          <Show when={refine().kind === 'sent' ? (refine() as { threadId: string }).threadId : null}>
            {(t) => (
              <span data-testid="forge-tree-refine-sent">
                Sent —{' '}
                <button class="underline" style={{ color: 'var(--c-accent)' }} onClick={() => props.onOpenThread(t())}>
                  open thread
                </button>
              </span>
            )}
          </Show>
          <Show when={refine().kind === 'failed' ? (refine() as { error: string }).error : null}>
            {(msg) => <span style={{ color: 'var(--c-error, #ef4444)' }}>{msg()}</span>}
          </Show>
        </div>
        <Show when={error()}>
          <div style={{ color: 'var(--c-error, #ef4444)' }}>{error()}</div>
        </Show>
      </div>
    </>
  )

  return (
    <div class="relative">
      <button
        ref={toggleEl}
        class={btn}
        style={{ ...field, color: selected().size ? 'var(--c-accent)' : 'var(--c-text)' }}
        onClick={() => setOpen(!open())}
        title="The goal tree: pick nodes to focus on, place them, see their progress"
        data-testid="forge-tree-toggle"
      >
        ◆ {treeButtonLabel(props.filters, props.streams)}
      </button>
      <Show when={open() && mode() === 'dropdown'}>
        <div
          ref={boxEl}
          class="absolute top-full right-0 z-[62] mt-1 flex max-h-[70vh] w-[30rem] flex-col rounded border text-xs shadow-lg"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          data-testid="forge-tree-dropdown"
        >
          {body()}
        </div>
      </Show>
      <Show when={open() && mode() === 'modal'}>
        <Portal>
          <div
            class="fixed inset-0 z-[70] flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.5)' }}
            data-testid="forge-tree-modal"
          >
            <div
              ref={boxEl}
              class="flex h-[80vh] w-[min(52rem,95vw)] flex-col rounded-lg text-xs shadow-xl"
              style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
            >
              {body()}
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  )
}

export default TreePanel

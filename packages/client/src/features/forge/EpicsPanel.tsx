// Epics panel: pick the epics (work streams) the canvas focuses on, make,
// archive and bring back epics, and send a "refine epics" request to the
// membrane's forge-rethink thread. Opens from the "Epics (n)" button as a
// dropdown or as a centred window; the header button switches between the
// two and the choice persists. Logic lives in epics-model.ts.

import { createEffect, createMemo, createSignal, For, on, Show, type Component, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { ForgeFilters, WorkStream } from '@sovereign/core'
import type { ForgeApi } from './api.js'
import { useDismiss } from './dismiss.js'
import {
  clearEpics,
  epicSource,
  epicsButtonLabel,
  LS_EPICS_MODE,
  orderEpics,
  otherEpicsMode,
  parseEpicsMode,
  searchEpics,
  selectedEpics,
  setDim,
  setEpicNeighbours,
  toggleEpic,
  type EpicsMode
} from './epics-model.js'

export interface EpicsPanelProps {
  membrane: string
  /** The membrane's epics (archived ones excluded), as the graph serves them. */
  streams: WorkStream[]
  filters: ForgeFilters
  onChange: (f: ForgeFilters) => void
  api: Pick<ForgeApi, 'streams' | 'archiveStream' | 'refineEpics'>
  onCreate: (name: string, parentId?: string) => Promise<void>
  /** An epic was archived or brought back: reload the window. */
  onArchiveChanged: () => void
  onOpenThread: (id: string) => void
  /** Bumps on 'forge.updated' for this membrane. */
  refresh: () => number
}

type RefineState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; threadId: string }
  | { kind: 'failed'; error: string }

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
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const EpicsPanel: Component<EpicsPanelProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [mode, setMode] = createSignal<EpicsMode>(readMode())
  const [query, setQuery] = createSignal('')
  const [showArchived, setShowArchived] = createSignal(false)
  const [archived, setArchived] = createSignal<WorkStream[]>([])
  const [name, setName] = createSignal('')
  const [parent, setParent] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [refineText, setRefineText] = createSignal('')
  const [refine, setRefine] = createSignal<RefineState>({ kind: 'idle' })
  let toggleEl: HTMLButtonElement | undefined
  let boxEl: HTMLDivElement | undefined
  useDismiss(
    open,
    () => [boxEl, toggleEl],
    () => setOpen(false)
  )

  const rows = createMemo(() => orderEpics(props.streams))
  const shown = createMemo(() => searchEpics(rows(), query()))
  const selected = createMemo(() => new Set(selectedEpics(props.filters, props.streams)))
  const archivedRows = createMemo(() => orderEpics(archived().filter((s) => s.archived)))

  createEffect(
    on([open, showArchived, () => props.refresh(), () => props.membrane], async ([isOpen, wanted]) => {
      if (!isOpen || !wanted) return
      try {
        setArchived(await props.api.streams(props.membrane, true))
      } catch (e) {
        setError(errorMessage(e))
      }
    })
  )

  const switchMode = (): void => {
    const next = otherEpicsMode(mode())
    setMode(next)
    writeMode(next)
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

  const archive = async (s: WorkStream, archiving: boolean): Promise<void> => {
    setError(null)
    try {
      await props.api.archiveStream(props.membrane, s.id, archiving)
      if (archiving && selected().has(s.id)) props.onChange(toggleEpic(props.filters, s.id))
      if (showArchived()) setArchived(await props.api.streams(props.membrane, true))
      props.onArchiveChanged()
    } catch (e) {
      setError(errorMessage(e))
    }
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
        <span class="flex-1 text-xs font-semibold">Epics ({props.streams.length})</span>
        <button
          class={btn}
          style={field}
          title={mode() === 'dropdown' ? 'Open in a window' : 'Show as a dropdown'}
          onClick={switchMode}
          data-testid="forge-epics-mode"
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
            placeholder="Search epics"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            data-testid="forge-epics-search"
          />
          <Show when={selected().size}>
            <button
              class={btn}
              style={field}
              onClick={() => props.onChange(clearEpics(props.filters))}
              data-testid="forge-epics-clear"
            >
              Clear ({selected().size})
            </button>
          </Show>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5" style={{ color: 'var(--c-text-muted)' }}>
          {toggleRow(
            'Include neighbours',
            props.filters.epicNeighbours !== false,
            (v) => props.onChange(setEpicNeighbours(props.filters, v)),
            'forge-epics-neighbours'
          )}
          {toggleRow(
            'Dim instead',
            !!props.filters.dim,
            (v) => props.onChange(setDim(props.filters, v)),
            'forge-epics-dim'
          )}
          {toggleRow('Show archived', showArchived(), setShowArchived, 'forge-epics-show-archived')}
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto py-1" data-testid="forge-epics-list">
        <Show
          when={shown().length}
          fallback={<div class="px-3 py-2 opacity-60">{props.streams.length ? 'No epic matches' : 'No epics yet'}</div>}
        >
          <For each={shown()}>
            {({ stream: s, depth }) => (
              <div
                class="group flex items-center gap-1 py-0.5 pr-2 hover:bg-[var(--c-hover-bg)]"
                style={{ 'padding-left': `${12 + depth * 14}px` }}
                data-testid="forge-epic"
              >
                <label
                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
                  title={epicSource(s) || 'Made by hand'}
                >
                  <input
                    type="checkbox"
                    checked={selected().has(s.id)}
                    onChange={() => props.onChange(toggleEpic(props.filters, s.id))}
                  />
                  <span class="truncate" style={{ color: selected().has(s.id) ? 'var(--c-accent)' : 'var(--c-text)' }}>
                    {s.name}
                  </span>
                  <Show when={s.plan}>
                    <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                      plan
                    </span>
                  </Show>
                </label>
                <span style={{ color: 'var(--c-text-muted)' }} title="Members">
                  {s.memberCount}
                </span>
                <button
                  class="rounded px-1 text-[10px] opacity-0 group-hover:opacity-100 hover:bg-[var(--c-bg)] focus:opacity-100"
                  style={{ color: 'var(--c-text-muted)' }}
                  title="Archive this epic"
                  onClick={() => void archive(s, true)}
                  data-testid="forge-epic-archive"
                >
                  Archive
                </button>
              </div>
            )}
          </For>
        </Show>
        <Show when={showArchived()}>
          <div
            class="px-3 pt-2 pb-0.5 text-[10px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--c-text-muted)' }}
          >
            Archived ({archivedRows().length})
          </div>
          <For each={archivedRows()}>
            {({ stream: s }) => (
              <div class="flex items-center gap-1 px-3 py-0.5 opacity-70" data-testid="forge-epic-archived">
                <span class="flex-1 truncate">{s.name}</span>
                <span style={{ color: 'var(--c-text-muted)' }}>{s.memberCount}</span>
                <button
                  class="rounded px-1 text-[10px] hover:bg-[var(--c-hover-bg)]"
                  onClick={() => void archive(s, false)}
                  data-testid="forge-epic-unarchive"
                >
                  Unarchive
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="flex flex-col gap-1 border-t px-3 py-1.5" style={{ 'border-color': 'var(--c-border)' }}>
        <div class="flex gap-1">
          <input
            class="min-w-0 flex-1 rounded border px-1.5 py-0.5"
            style={field}
            placeholder="New epic"
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
              <option value="">Top level</option>
              <For each={rows()}>{({ stream: s }) => <option value={s.id}>Inside {s.name}</option>}</For>
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
          placeholder="Refine epics… e.g. “merge the indexer epics, archive the empty ones”"
          value={refineText()}
          onInput={(e) => setRefineText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendRefine()
          }}
          data-testid="forge-epics-refine"
        />
        <div class="flex items-center gap-2">
          <button
            class={btn}
            style={field}
            disabled={refine().kind === 'sending' || !refineText().trim()}
            onClick={() => void sendRefine()}
            title="Send to this membrane's forge-rethink thread (Ctrl/⌘+Enter)"
            data-testid="forge-epics-refine-send"
          >
            {refine().kind === 'sending' ? 'Sending…' : 'Send'}
          </button>
          <Show when={refine().kind === 'sent' ? (refine() as { threadId: string }).threadId : null}>
            {(t) => (
              <span data-testid="forge-epics-refine-sent">
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
        title="Pick, make and refine epics"
        data-testid="forge-epics-toggle"
      >
        ◆ {epicsButtonLabel(props.filters, props.streams)}
      </button>
      <Show when={open() && mode() === 'dropdown'}>
        <div
          ref={boxEl}
          class="absolute top-full right-0 z-[62] mt-1 flex max-h-[70vh] w-[24rem] flex-col rounded border text-xs shadow-lg"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          data-testid="forge-epics-dropdown"
        >
          {body()}
        </div>
      </Show>
      <Show when={open() && mode() === 'modal'}>
        <Portal>
          <div
            class="fixed inset-0 z-[70] flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.5)' }}
            data-testid="forge-epics-modal"
          >
            <div
              ref={boxEl}
              class="flex h-[80vh] w-[min(46rem,95vw)] flex-col rounded-lg text-xs shadow-xl"
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

export default EpicsPanel

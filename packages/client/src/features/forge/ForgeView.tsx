// Forge — the Hex menu's work graph. One membrane at a time; its
// saved graphs stack as panels (or one shows solo). Each panel loads its own
// window; overlays and live updates are shared per membrane.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type Component } from 'solid-js'
import type { AgentOverlay, ForgeView as ForgeViewDef } from '@sovereign/core'
import ForgePanel from './ForgePanel.js'
import RethinkReport from './RethinkReport.js'
import {
  phaseAfterRuns,
  phaseAfterStart,
  phaseLabel,
  runLinkLabel,
  type RethinkPhase,
  type RethinkRuns
} from './rethink-model.js'
import type { ThreadChoice } from './NodeCard.js'
import { createForgeApi } from './api.js'
import {
  addView,
  moveView,
  newViewId,
  removeView,
  seedView,
  shownViews,
  updateView,
  type Arrangement
} from './graphs.js'
import { pickMembrane, type MembraneMeta } from './membrane.js'
import { parseForgeMode, type ForgeMode } from './kanban-model.js'
import { useDismiss } from './dismiss.js'
import { wsStore } from '../../ws/index.js'
import { setActiveView } from '../nav/store.js'
import { switchThread, threadKey, threads as storeThreads } from '../threads/store.js'
import { activeWorkspace } from '../workspace/store.js'

const LS_MEMBRANE = 'sovereign:forge:membrane'
const LS_ARRANGEMENT = 'sovereign:forge:arrangement:'
const LS_MODE = 'sovereign:forge:mode'

const readLs = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const writeLs = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* storage full or disabled */
  }
}

const btn = 'rounded border px-2 py-0.5 text-xs transition-colors disabled:opacity-40 hover:bg-[var(--c-hover-bg)]'
const btnStyle = { 'border-color': 'var(--c-border)', color: 'var(--c-text)', background: 'var(--c-bg)' }

const ForgeView: Component = () => {
  const api = createForgeApi()
  const [membranes, setMembranes] = createSignal<MembraneMeta[]>([])
  const [chosen, setChosen] = createSignal<string | null>(readLs(LS_MEMBRANE))
  const [views, setViews] = createSignal<ForgeViewDef[]>([])
  const [arrangement, setArrangement] = createSignal<Arrangement>({ mode: 'all' })
  const [overlays, setOverlays] = createSignal<Map<string, AgentOverlay>>(new Map())
  const [refresh, setRefresh] = createSignal(0)
  const [graphsOpen, setGraphsOpen] = createSignal(false)
  let graphsEl: HTMLDivElement | undefined
  useDismiss(
    graphsOpen,
    () => graphsEl,
    () => setGraphsOpen(false)
  )
  const [allThreads, setAllThreads] = createSignal<ThreadChoice[]>([])
  const [notice, setNotice] = createSignal<string | null>(null)
  const [newTitle, setNewTitle] = createSignal('')
  const [rethinkPhase, setRethinkPhase] = createSignal<RethinkPhase>({ phase: 'idle' })
  const [rethinkRuns, setRethinkRuns] = createSignal<RethinkRuns | null>(null)
  const [reportId, setReportId] = createSignal<string | null>(null)
  const [mode, setMode] = createSignal<ForgeMode>(parseForgeMode(readLs(LS_MODE)))
  const toggleMode = (): void => {
    const next: ForgeMode = mode() === 'graph' ? 'kanban' : 'graph'
    setMode(next)
    writeLs(LS_MODE, next)
  }

  const threadMembrane = createMemo(() => storeThreads().find((t) => t.id === threadKey())?.membraneId ?? null)
  const membrane = createMemo(() =>
    pickMembrane(membranes(), {
      chosen: chosen(),
      threadMembrane: threadMembrane(),
      workspaceId: activeWorkspace()?.orgId
    })
  )

  onMount(async () => {
    try {
      const res = await fetch('/api/membranes')
      if (res.ok) setMembranes(((await res.json()) as { membranes?: MembraneMeta[] }).membranes ?? [])
    } catch {
      /* offline: the switcher stays empty */
    }
    try {
      const res = await fetch('/api/threads')
      if (res.ok) {
        const data = await res.json()
        setAllThreads(Array.isArray(data) ? data : (data.threads ?? []))
      }
    } catch {
      /* the picker falls back to the store's threads */
    }
  })
  const threadsForPicker = createMemo<ThreadChoice[]>(() => (allThreads().length ? allThreads() : storeThreads()))

  // ── Per-membrane loading: views, overlays, arrangement. ──────────
  const loadOverlay = async (m: string): Promise<void> => {
    try {
      const list = await api.overlay(m)
      if (membrane() === m) setOverlays(new Map(list.map((o) => [o.nodeId, o])))
    } catch {
      /* overlays are decoration; the graph still works */
    }
  }
  createEffect(
    on(membrane, async (m) => {
      setOverlays(new Map())
      setViews([])
      if (!m) return
      const saved = readLs(LS_ARRANGEMENT + m)
      setArrangement(saved ? (JSON.parse(saved) as Arrangement) : { mode: 'all' })
      void loadOverlay(m)
      try {
        const list = await api.views(m)
        if (membrane() === m) setViews(list.length ? list : [seedView(m)])
      } catch {
        if (membrane() === m) setViews([seedView(m)])
      }
    })
  )

  // ── Live updates. ────────────────────────────────────────────────
  onMount(() => {
    wsStore.subscribe(['forge'])
    const of = (msg: Record<string, unknown>): Record<string, unknown> =>
      (msg?.payload && typeof msg.payload === 'object' ? msg.payload : msg) as Record<string, unknown>
    const offs = [
      wsStore.on('forge.updated', (msg: Record<string, unknown>) => {
        if (of(msg).membrane === membrane()) setRefresh((n) => n + 1)
      }),
      wsStore.on('forge.rethink', (msg: Record<string, unknown>) => {
        if (of(msg).membrane === membrane()) void loadRuns(membrane()!)
      }),
      wsStore.on('forge.overlay', (msg: Record<string, unknown>) => {
        const p = of(msg)
        if (p.membrane !== membrane()) return
        if (Array.isArray(p.overlays)) setOverlays(new Map((p.overlays as AgentOverlay[]).map((o) => [o.nodeId, o])))
        else void loadOverlay(p.membrane as string)
      })
    ]
    // Overlays carry thread status: refresh them when the tab comes back.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && membrane()) void loadOverlay(membrane()!)
    }
    document.addEventListener('visibilitychange', onVisible)
    onCleanup(() => {
      for (const off of offs) off()
      wsStore.unsubscribe(['forge'])
      document.removeEventListener('visibilitychange', onVisible)
    })
  })

  // ── Views: edits save after a short pause. ───────────────────────
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const commitViews = (next: ForgeViewDef[]): void => {
    setViews(next)
    const m = membrane()
    if (!m) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        await api.saveViews(m, next)
      } catch (e) {
        setNotice(`Could not save graphs: ${e instanceof Error ? e.message : String(e)}`)
      }
    }, 600)
  }
  onCleanup(() => clearTimeout(saveTimer))
  const setArr = (a: Arrangement): void => {
    setArrangement(a)
    if (membrane()) writeLs(LS_ARRANGEMENT + membrane(), JSON.stringify(a))
  }
  const shown = createMemo(() => shownViews(views(), arrangement()))
  // Panels key by view id: editing a view's filters must not remount its panel (and drop its window).
  const shownIds = createMemo(() => shown().map((v) => v.id), undefined, {
    equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
  })
  const viewById = (id: string): ForgeViewDef | undefined => views().find((v) => v.id === id)

  const act = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setNotice(`${label}…`)
    try {
      await fn()
      setNotice(`${label}: started`)
    } catch (e) {
      setNotice(`${label} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    setTimeout(() => setNotice(null), 4000)
  }

  // ── Rethink (Loop 2): status line, latest run, report. ──────────────
  const loadRuns = async (m: string): Promise<void> => {
    try {
      const runs = await api.rethinkRuns(m)
      if (membrane() !== m) return
      setRethinkRuns(runs)
      setRethinkPhase(phaseAfterRuns(rethinkPhase(), runs))
    } catch {
      /* no rethink on this server: the controls stay quiet */
    }
  }
  createEffect(
    on(membrane, (m) => {
      setRethinkRuns(null)
      setRethinkPhase({ phase: 'idle' })
      setReportId(null)
      if (m) void loadRuns(m)
    })
  )
  const rethinkNow = async (): Promise<void> => {
    const m = membrane()
    if (!m) return
    setRethinkPhase({ phase: 'starting' })
    try {
      setRethinkPhase(phaseAfterStart(await api.rethink(m)))
    } catch (e) {
      setRethinkPhase({ phase: 'failed', error: e instanceof Error ? e.message : String(e) })
    }
    void loadRuns(m)
  }

  const openThread = (id: string): void => {
    setActiveView('workspace')
    switchThread(id)
  }

  return (
    <div
      class="flex h-full min-h-0 flex-col"
      style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}
      data-testid="forge-view"
    >
      <div class="flex flex-wrap items-center gap-2 border-b px-3 py-1.5" style={{ 'border-color': 'var(--c-border)' }}>
        <select
          class="rounded border px-2 py-0.5 text-xs"
          style={btnStyle}
          value={membrane() ?? ''}
          onChange={(e) => {
            setChosen(e.currentTarget.value)
            writeLs(LS_MEMBRANE, e.currentTarget.value)
          }}
          data-testid="forge-membrane"
        >
          <For each={membranes()}>{(m) => <option value={m.id}>{m.name}</option>}</For>
        </select>

        <div class="relative" ref={graphsEl}>
          <button class={btn} style={btnStyle} onClick={() => setGraphsOpen(!graphsOpen())} data-testid="forge-graphs">
            Graphs ({views().length}) ▾
          </button>
          <Show when={graphsOpen()}>
            <div
              class="absolute top-full left-0 z-[61] mt-1 w-72 rounded border p-2 text-xs shadow-lg"
              style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
              data-testid="forge-graphs-menu"
            >
              <button
                class="mb-1 w-full rounded px-2 py-1 text-left hover:bg-[var(--c-hover-bg)]"
                style={{ color: arrangement().mode === 'all' ? 'var(--c-accent)' : 'var(--c-text)' }}
                onClick={() => setArr({ mode: 'all' })}
              >
                Show all, stacked
              </button>
              <For each={views()}>
                {(v, i) => (
                  <div class="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--c-hover-bg)]">
                    <button
                      class="min-w-0 flex-1 truncate px-1 text-left"
                      style={{
                        color:
                          arrangement().mode === 'solo' && (arrangement() as { id: string }).id === v.id
                            ? 'var(--c-accent)'
                            : 'var(--c-text)'
                      }}
                      title="Show this graph alone"
                      onClick={() => setArr({ mode: 'solo', id: v.id })}
                      data-testid="forge-graph-solo"
                    >
                      {v.title}
                    </button>
                    <button
                      title="Move up"
                      disabled={i() === 0}
                      onClick={() => commitViews(moveView(views(), v.id, -1))}
                    >
                      ↑
                    </button>
                    <button
                      title="Move down"
                      disabled={i() === views().length - 1}
                      onClick={() => commitViews(moveView(views(), v.id, 1))}
                    >
                      ↓
                    </button>
                    <button
                      title="Remove graph"
                      disabled={views().length <= 1}
                      onClick={() => commitViews(removeView(views(), v.id))}
                      data-testid="forge-graph-remove"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
              <div class="mt-2 flex gap-1">
                <input
                  class="min-w-0 flex-1 rounded border px-1.5 py-0.5"
                  style={btnStyle}
                  placeholder="New graph title"
                  value={newTitle()}
                  onInput={(e) => setNewTitle(e.currentTarget.value)}
                  data-testid="forge-graph-title"
                />
                <button
                  class={btn}
                  style={btnStyle}
                  disabled={!membrane()}
                  onClick={() => {
                    const m = membrane()
                    if (!m) return
                    commitViews(addView(views(), m, newTitle() || `Graph ${views().length + 1}`, newViewId(views())))
                    setNewTitle('')
                  }}
                  data-testid="forge-graph-add"
                >
                  Add
                </button>
              </div>
            </div>
          </Show>
        </div>
        <button
          class={btn}
          style={btnStyle}
          onClick={toggleMode}
          title={mode() === 'graph' ? 'Show the immediate items as a Kanban' : 'Show the work graph'}
          data-testid="forge-mode"
        >
          {mode() === 'graph' ? 'Kanban' : 'Graph'}
        </button>

        <span class="flex-1" />
        <Show when={notice()}>
          <span class="text-xs" style={{ color: 'var(--c-text-muted)' }} data-testid="forge-notice">
            {notice()}
          </span>
        </Show>
        <button
          class={btn}
          style={btnStyle}
          disabled={!membrane()}
          onClick={() => act('Sync', () => api.sync(membrane()!))}
          data-testid="forge-sync"
        >
          Sync now
        </button>
        <Show when={phaseLabel(rethinkPhase())}>
          <span class="text-xs" style={{ color: 'var(--c-text-muted)' }} data-testid="forge-rethink-status">
            {phaseLabel(rethinkPhase())}
          </span>
        </Show>
        <Show when={rethinkRuns()?.runs[0]}>
          {(r) => (
            <button
              class="text-xs hover:underline"
              style={{ color: 'var(--c-accent)' }}
              onClick={() => setReportId(r().id)}
              title="Open the run report"
              data-testid="forge-rethink-last"
            >
              {runLinkLabel(r())}
            </button>
          )}
        </Show>
        <button
          class={btn}
          style={btnStyle}
          disabled={!membrane() || rethinkPhase().phase === 'starting' || rethinkPhase().phase === 'running'}
          onClick={() => void rethinkNow()}
          data-testid="forge-rethink"
        >
          Rethink now
        </button>
      </div>

      <Show when={reportId() && membrane() ? { id: reportId()!, m: membrane()! } : null}>
        {(r) => (
          <RethinkReport
            membrane={r().m}
            api={api}
            runs={rethinkRuns()?.runs ?? []}
            runId={r().id}
            threadId={rethinkRuns()?.threadId ?? null}
            onOpenThread={(id) => {
              setReportId(null)
              openThread(id)
            }}
            onClose={() => setReportId(null)}
          />
        )}
      </Show>

      <Show
        when={membrane()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-sm" style={{ color: 'var(--c-text-muted)' }}>
            No membrane to show.
          </div>
        }
      >
        {(m) => (
          <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <For each={shownIds()}>
              {(id) => (
                <Show when={viewById(id)}>
                  {(v) => (
                    <ForgePanel
                      membrane={m()}
                      view={v()}
                      api={api}
                      overlays={overlays}
                      refresh={refresh}
                      threads={threadsForPicker}
                      onViewChange={(patch) => commitViews(updateView(views(), id, patch))}
                      onOpenThread={openThread}
                      fill={shownIds().length === 1}
                      mode={mode()}
                    />
                  )}
                </Show>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  )
}

export default ForgeView

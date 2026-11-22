// The open thread's Forge decisions: a header badge with the open count (hidden at
// zero) and a panel with the Decisions list for this thread only, so a decision can
// be answered where it was asked. The list is DecisionsView itself, with its filters
// kept in the panel (never in the Forge view's saved filters).

import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, type Component } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { Decision } from '@sovereign/core'
import { createForgeApi } from './api.js'
import DecisionsView from './DecisionsView.js'
import MobileSheet from './MobileSheet.js'
import { createNarrow, type DecisionControls } from './mobile.js'
import { decisionsOfThread, openCountForThread, routeDecisionWrites } from './thread-decisions-model.js'
import { wsStore } from '../../ws/index.js'
import { setActiveAgentTab, setActiveView } from '../nav/store.js'
import { switchThread, threadKey, threads as storeThreads } from '../threads/store.js'

/** Decisions are stored per membrane, and one can be addressed to a thread of another: read them all. */
async function loadAllDecisions(api: ReturnType<typeof createForgeApi>): Promise<Decision[]> {
  const res = await fetch('/api/membranes')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const membranes = ((await res.json()) as { membranes?: Array<{ id: string }> }).membranes ?? []
  const lists = await Promise.all(membranes.map((m) => api.decisions(m.id)))
  return lists.flat()
}

const ThreadDecisions: Component = () => {
  const api = createForgeApi()
  const narrow = createNarrow()
  const [all, setAll] = createSignal<Decision[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [open, setOpen] = createSignal(false)
  const [controls, setControls] = createSignal<DecisionControls | null>(null)

  const thread = createMemo(() => threadKey())
  const count = createMemo(() => openCountForThread(all(), thread()))
  const mine = createMemo(() => decisionsOfThread(all(), thread()))
  const routed = routeDecisionWrites(api, all)

  let seq = 0
  const load = async (): Promise<void> => {
    const run = ++seq
    setLoading(true)
    try {
      const list = await loadAllDecisions(api)
      if (run !== seq) return
      setAll(list)
      setError(null)
    } catch (e) {
      if (run === seq) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (run === seq) setLoading(false)
    }
  }
  // Decisions emit forge.updated; each one reloads (a late answer to an older load is dropped).
  onMount(() => {
    void load()
    wsStore.subscribe(['forge'])
    onCleanup(wsStore.on('forge.updated', () => void load()))
  })
  // Another thread, another list.
  createEffect(on(thread, () => setOpen(false), { defer: true }))

  const openThread = (id: string): void => {
    setOpen(false)
    if (id === thread()) return
    setActiveView('workspace')
    switchThread(id)
  }
  const selectNode = (): void => {
    setOpen(false)
    setActiveAgentTab('forge')
    setActiveView('agent')
  }

  const list = () => (
    <DecisionsView
      membrane={mine()[0]?.membrane ?? ''}
      api={routed}
      decisions={mine()}
      loading={loading()}
      error={error()}
      reload={load}
      threads={() => storeThreads()}
      onOpenThread={openThread}
      onSelectNode={selectNode}
      narrow={narrow()}
      onMobileControls={(c) => setControls(() => c)}
      local
    />
  )

  return (
    <Show when={count() > 0 || open()}>
      <button
        class="inline-flex h-5 min-w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-none px-1 text-xs leading-none font-medium"
        style={{ background: 'var(--c-accent)', color: '#fff' }}
        onClick={() => setOpen(!open())}
        title="Open decisions"
        aria-label={`Open decisions: ${count()}`}
        data-testid="thread-decisions-badge"
      >
        {count()}
      </button>
      <Show when={open()}>
        <Show
          when={!narrow()}
          fallback={
            <MobileSheet title="Decisions" tall onClose={() => setOpen(false)} testid="thread-decisions-panel">
              <div class="flex h-full min-h-0 flex-col">
                <Show when={controls()}>
                  {(c) => (
                    <div class="flex justify-end px-3 pt-2">
                      <button
                        class="min-h-10 rounded-full border px-3 text-sm"
                        style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
                        onClick={() => c().openFilters()}
                      >
                        Filters{c().filterCount() ? ` (${c().filterCount()})` : ''}
                      </button>
                    </div>
                  )}
                </Show>
                {list()}
              </div>
            </MobileSheet>
          }
        >
          <Portal>
            <div
              class="fixed inset-0 z-[120]"
              onClick={(e) => {
                if (e.target === e.currentTarget) setOpen(false)
              }}
            >
              <div
                class="absolute top-0 right-0 bottom-0 flex w-[min(520px,100vw)] flex-col border-l shadow-xl"
                style={{
                  background: 'var(--c-bg-raised)',
                  'border-color': 'var(--c-border)',
                  color: 'var(--c-text)'
                }}
                data-testid="thread-decisions-panel"
              >
                <div class="flex items-center gap-2 border-b px-4 py-2" style={{ 'border-color': 'var(--c-border)' }}>
                  <span class="flex-1 text-sm font-semibold">Decisions</span>
                  <button
                    class="h-7 w-7 text-lg"
                    style={{ color: 'var(--c-text-muted)' }}
                    onClick={() => setOpen(false)}
                    aria-label="Close"
                    title="Close"
                  >
                    ✕
                  </button>
                </div>
                {list()}
              </div>
            </div>
          </Portal>
        </Show>
      </Show>
    </Show>
  )
}

export default ThreadDecisions

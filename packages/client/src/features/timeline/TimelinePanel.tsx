// Overview → Timeline: what happened inside Sovereign, newest first, live.
// Lines come from GET /api/timeline and the WS channel `timeline`; the
// filter chips live in localStorage. Logic in timeline-model.ts.

import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from 'solid-js'
import type { TimelineEntry, TimelineKind } from '@sovereign/core/timeline'
import { TIMELINE_KINDS } from '@sovereign/core/timeline'
import { wsStore } from '../../ws/index.js'
import { setActiveView } from '../nav/store.js'
import { switchThread } from '../threads/store.js'
import { fetchTimeline } from './api.js'
import {
  FILTERS_KEY,
  KIND_META,
  ORIGIN_GROUPS,
  ORIGIN_LABELS,
  appendOlder,
  entryColor,
  entryTarget,
  formatAbsolute,
  formatRelative,
  groupByDay,
  insertLive,
  matchesFilters,
  parseFilters,
  queryOf,
  toggle,
  type OriginGroup,
  type TimelineFilters
} from './timeline-model.js'

const PAGE = 100

function loadFilters(): TimelineFilters {
  try {
    return parseFilters(localStorage.getItem(FILTERS_KEY))
  } catch {
    return parseFilters(null)
  }
}

function saveFilters(f: TimelineFilters): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(f))
  } catch {
    /* storage unavailable */
  }
}

const Chip: Component<{ on: boolean; label: string; color?: string; onClick: () => void }> = (p) => (
  <button
    type="button"
    class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap transition-colors"
    style={{
      'border-color': p.on ? (p.color ?? 'var(--c-accent)') : 'var(--c-border)',
      background: p.on ? 'var(--c-hover-bg)' : 'transparent',
      color: p.on ? 'var(--c-text)' : 'var(--c-text-muted)'
    }}
    aria-pressed={p.on}
    onClick={() => p.onClick()}
  >
    {p.label}
  </button>
)

export const TimelinePanel: Component = () => {
  const [filters, setFilters] = createSignal<TimelineFilters>(loadFilters())
  const [entries, setEntries] = createSignal<TimelineEntry[]>([])
  const [next, setNext] = createSignal<string | undefined>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [now, setNow] = createSignal(Date.now())
  let scroller: HTMLDivElement | undefined
  let generation = 0

  const groups = createMemo(() => groupByDay(entries(), now()))

  async function load(reset: boolean): Promise<void> {
    const gen = reset ? ++generation : generation
    setLoading(true)
    setError(null)
    try {
      const page = await fetchTimeline({
        ...queryOf(filters()),
        limit: PAGE,
        ...(reset ? {} : { before: next() })
      })
      if (gen !== generation) return // filters changed while this page loaded
      setEntries((cur) => (reset ? page.entries : appendOlder(cur, page.entries)))
      setNext(page.more ? page.next : undefined)
    } catch (e) {
      if (gen === generation) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (gen === generation) setLoading(false)
    }
  }

  function updateFilters(f: TimelineFilters): void {
    setFilters(f)
    saveFilters(f)
    void load(true)
  }

  /** Insert above what the user reads without moving it: shift the scroll by the added height. */
  function keepScroll(mutate: () => void): void {
    const el = scroller
    if (!el || el.scrollTop <= 0) return mutate()
    const before = el.scrollHeight
    mutate()
    el.scrollTop += el.scrollHeight - before
  }

  function open(e: TimelineEntry): void {
    const t = entryTarget(e)
    if (!t) return
    if (t.kind === 'thread') {
      setActiveView('workspace')
      switchThread(t.threadId)
    } else window.open(t.url, '_blank', 'noopener,noreferrer')
  }

  onMount(() => {
    void load(true)
    wsStore.subscribe(['timeline'])
    const off = wsStore.on('timeline.entry', (msg: Record<string, unknown>) => {
      const body = (msg?.payload && typeof msg.payload === 'object' ? msg.payload : msg) as { entry?: TimelineEntry }
      const e = body.entry
      if (!e || typeof e.id !== 'string' || !matchesFilters(e, filters())) return
      keepScroll(() => setEntries((cur) => insertLive(cur, e)))
    })
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    onCleanup(() => {
      off()
      wsStore.unsubscribe(['timeline'])
      clearInterval(tick)
    })
  })

  return (
    <div class="flex h-full min-h-0 flex-col" data-testid="timeline-panel">
      <div class="border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
            Timeline
          </h3>
          <Show when={loading()}>
            <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              loading…
            </span>
          </Show>
        </div>
        {/* One scrollable line on every screen size */}
        <div class="scrollbar-none mt-2 flex gap-1 overflow-x-auto">
          <For each={[...TIMELINE_KINDS]}>
            {(k: TimelineKind) => (
              <Chip
                on={filters().kinds.includes(k)}
                label={`${KIND_META[k].icon} ${KIND_META[k].label}`}
                color={KIND_META[k].color}
                onClick={() => updateFilters({ ...filters(), kinds: toggle(filters().kinds, k) })}
              />
            )}
          </For>
          <span class="mx-1 shrink-0 self-center text-[10px]" style={{ color: 'var(--c-border-strong)' }}>
            |
          </span>
          <For each={[...ORIGIN_GROUPS]}>
            {(o: OriginGroup) => (
              <Chip
                on={filters().origins.includes(o)}
                label={ORIGIN_LABELS[o]}
                onClick={() => updateFilters({ ...filters(), origins: toggle(filters().origins, o) })}
              />
            )}
          </For>
        </div>
      </div>

      <div
        ref={(el) => (scroller = el)}
        class="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        style={{ 'overflow-anchor': 'none' }}
      >
        <Show when={error()}>
          <p class="mb-2 text-xs" style={{ color: 'var(--c-error)' }}>
            {error()}
          </p>
        </Show>
        <Show when={!loading() && entries().length === 0 && !error()}>
          <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            Nothing yet.
          </p>
        </Show>
        <For each={groups()}>
          {(g) => (
            <section class="mb-3">
              <h4
                class="sticky top-0 z-10 py-1 text-[10px] font-semibold tracking-wide uppercase"
                style={{ color: 'var(--c-text-muted)', background: 'var(--c-bg)' }}
              >
                {g.label}
              </h4>
              <For each={g.entries}>
                {(e) => {
                  const target = entryTarget(e)
                  return (
                    <div
                      class="flex items-start gap-2 rounded px-1 py-1 text-xs"
                      classList={{ 'cursor-pointer': !!target }}
                      style={{ color: 'var(--c-text)' }}
                      role={target ? 'button' : undefined}
                      tabIndex={target ? 0 : undefined}
                      title={target?.kind === 'url' ? target.url : undefined}
                      onClick={() => open(e)}
                      onKeyDown={(ev) => {
                        if (target && (ev.key === 'Enter' || ev.key === ' ')) {
                          ev.preventDefault()
                          open(e)
                        }
                      }}
                      onMouseEnter={(ev) => target && (ev.currentTarget.style.background = 'var(--c-hover-bg)')}
                      onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
                    >
                      <span
                        class="w-8 shrink-0 text-right text-[10px] tabular-nums"
                        style={{ color: 'var(--c-text-muted)' }}
                        title={formatAbsolute(e.at)}
                      >
                        {formatRelative(e.at, now())}
                      </span>
                      <span
                        class="w-4 shrink-0 text-center"
                        style={{ color: entryColor(e) }}
                        title={KIND_META[e.kind]?.label}
                      >
                        {KIND_META[e.kind]?.icon ?? '·'}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="break-words">{e.title}</span>
                        <Show when={e.detail}>
                          <span class="ml-1 break-words" style={{ color: 'var(--c-text-muted)' }}>
                            — {e.detail}
                          </span>
                        </Show>
                      </span>
                    </div>
                  )
                }}
              </For>
            </section>
          )}
        </For>
        <Show when={next()}>
          <button
            type="button"
            class="mt-1 w-full rounded border py-1 text-xs"
            style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text-muted)' }}
            disabled={loading()}
            onClick={() => void load(false)}
          >
            Load older
          </button>
        </Show>
      </div>
    </div>
  )
}

export default TimelinePanel

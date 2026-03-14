// §7 Event Stream Tab — Real-time event viewer
import { createSignal, onMount, onCleanup, For, Show, type Component } from 'solid-js'
import { wsStore } from '../../ws/index.js'

export interface EventStreamEntry {
  id: number
  capturedAt: string
  type: string
  source: string
  payload: unknown
  entityId?: string
}

const MAX_BUFFER = 2000

const EVENT_CATEGORIES: Record<string, string> = {
  issue: 'text-blue-400',
  pr: 'text-purple-400',
  review: 'text-purple-400',
  git: 'text-green-400',
  system: 'text-gray-400',
  config: 'text-amber-400',
  notification: 'text-red-400',
  scheduler: 'text-cyan-400',
  webhook: 'text-orange-400',
  log: 'text-gray-500'
}

export function getEventCategoryColor(type: string): string {
  const prefix = type.split('.')[0]
  return EVENT_CATEGORIES[prefix] ?? 'text-gray-400'
}

export function formatEventType(type: string): string {
  return type
}

export function filterEvents(
  entries: EventStreamEntry[],
  filter: { type?: string; source?: string }
): EventStreamEntry[] {
  return entries.filter((e) => {
    if (filter.type && !e.type.toLowerCase().includes(filter.type.toLowerCase())) return false
    if (filter.source && e.source !== filter.source) return false
    return true
  })
}

export function calculateRate(entries: EventStreamEntry[], windowMs = 1000): number {
  const now = Date.now()
  const cutoff = now - windowMs
  return entries.filter((e) => new Date(e.capturedAt).getTime() >= cutoff).length
}

const EventStreamTab: Component = () => {
  const [entries, setEntries] = createSignal<EventStreamEntry[]>([])
  const [typeFilter, setTypeFilter] = createSignal('')
  const [sourceFilter, setSourceFilter] = createSignal('')
  const [paused, setPaused] = createSignal(false)
  const [queue, setQueue] = createSignal<EventStreamEntry[]>([])
  const [spotlightEntityId, setSpotlightEntityId] = createSignal<string | null>(null)
  const [rate, setRate] = createSignal(0)

  let rateInterval: ReturnType<typeof setInterval> | undefined

  const addEntry = (entry: EventStreamEntry) => {
    if (paused()) {
      setQueue((prev) => [...prev, entry])
      return
    }
    setEntries((prev) => {
      const next = [entry, ...prev]
      return next.length > MAX_BUFFER ? next.slice(0, MAX_BUFFER) : next
    })
  }

  onMount(() => {
    wsStore.subscribe(['events'])

    const offHistory = wsStore.on('event.history', (msg: Record<string, unknown>) => {
      const events = (msg.events as EventStreamEntry[]) || []
      setEntries(events.slice(0, MAX_BUFFER))
    })

    const offNew = wsStore.on('event.new', (msg: Record<string, unknown>) => {
      const entry: EventStreamEntry = {
        id: msg.id as number,
        capturedAt: (msg.capturedAt as string) || new Date().toISOString(),
        type: ((msg.event as Record<string, unknown>)?.type as string) || (msg.type as string) || '',
        source: ((msg.event as Record<string, unknown>)?.source as string) || (msg.source as string) || '',
        payload: (msg.event as Record<string, unknown>)?.payload ?? msg.payload,
        entityId: ((msg.event as Record<string, unknown>)?.payload as Record<string, unknown>)?.entityId as
          | string
          | undefined
      }
      addEntry(entry)
    })

    rateInterval = setInterval(() => {
      setRate(calculateRate(entries()))
    }, 1000)

    onCleanup(() => {
      offHistory()
      offNew()
      wsStore.unsubscribe(['events'])
      if (rateInterval) clearInterval(rateInterval)
    })
  })

  const filtered = () => filterEvents(entries(), { type: typeFilter(), source: sourceFilter() })

  const sources = () => {
    const set = new Set<string>()
    for (const e of entries()) set.add(e.source)
    return Array.from(set).sort()
  }

  const resumeAndFlush = () => {
    const queued = queue()
    setQueue([])
    setPaused(false)
    setEntries((prev) => {
      const next = [...queued.reverse(), ...prev]
      return next.length > MAX_BUFFER ? next.slice(0, MAX_BUFFER) : next
    })
  }

  const isSpotlighted = (entry: EventStreamEntry) => {
    if (!spotlightEntityId()) return false
    return entry.entityId === spotlightEntityId()
  }

  return (
    <div class="flex h-full flex-col gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Filter by type…"
          class="rounded border px-2 py-1 text-xs"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          value={typeFilter()}
          onInput={(e) => setTypeFilter(e.currentTarget.value)}
        />
        <select
          class="rounded border px-2 py-1 text-xs"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          value={sourceFilter()}
          onChange={(e) => setSourceFilter(e.currentTarget.value)}
        >
          <option value="">All sources</option>
          <For each={sources()}>{(s) => <option value={s}>{s}</option>}</For>
        </select>

        <span class="text-xs opacity-60">{rate()} events/sec</span>

        <button
          class="rounded border px-2 py-1 text-xs"
          style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          onClick={() => {
            if (paused()) resumeAndFlush()
            else setPaused(true)
          }}
        >
          {paused() ? `Resume (${queue().length})` : 'Pause'}
        </button>

        <Show when={spotlightEntityId()}>
          <button
            class="rounded bg-blue-500/20 px-2 py-1 text-xs text-blue-400"
            onClick={() => setSpotlightEntityId(null)}
          >
            Clear spotlight: {spotlightEntityId()}
          </button>
        </Show>
      </div>

      <div
        class="flex-1 overflow-y-auto rounded border font-mono text-xs"
        style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
      >
        {filtered().length === 0 ? (
          <div class="p-4 text-center opacity-50">No events</div>
        ) : (
          <For each={filtered()}>
            {(entry) => (
              <details
                class={`border-b px-3 py-1.5 ${isSpotlighted(entry) ? 'bg-blue-500/10' : ''}`}
                style={{ 'border-color': 'var(--c-border)' }}
              >
                <summary
                  class="flex cursor-pointer gap-2"
                  onClick={(e) => {
                    if (entry.entityId && e.altKey) {
                      e.preventDefault()
                      setSpotlightEntityId(entry.entityId)
                    }
                  }}
                >
                  <span class="shrink-0 opacity-50">{new Date(entry.capturedAt).toISOString().slice(11, 23)}</span>
                  <span class={`shrink-0 font-medium ${getEventCategoryColor(entry.type)}`}>{entry.type}</span>
                  <span class="shrink-0 opacity-60">{entry.source}</span>
                </summary>
                <pre class="mt-1 overflow-x-auto text-xs whitespace-pre-wrap opacity-70">
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
              </details>
            )}
          </For>
        )}
      </div>
    </div>
  )
}

export default EventStreamTab

// §7 Enhanced Event Stream Tab — Real-time event viewer with queue viz, detail panel, retry
import { createSignal, onMount, onCleanup, For, Show, type Component } from 'solid-js'
import { wsStore } from '../../ws/index.js'

export interface EventStreamEntry {
  id: number
  capturedAt: string
  type: string
  source: string
  payload: unknown
  entityId?: string
  status?: 'pending' | 'processing' | 'completed' | 'failed'
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

export function categorizeEvents(entries: EventStreamEntry[]): {
  pending: number
  processing: number
  completed: number
  failed: number
} {
  let pending = 0,
    processing = 0,
    completed = 0,
    failed = 0
  for (const e of entries) {
    switch (e.status) {
      case 'pending':
        pending++
        break
      case 'processing':
        processing++
        break
      case 'failed':
        failed++
        break
      default:
        completed++
    }
  }
  return { pending, processing, completed, failed }
}

async function retryEvent(id: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/events/${id}/retry`, { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}

const EventStreamTab: Component = () => {
  const [entries, setEntries] = createSignal<EventStreamEntry[]>([])
  const [typeFilter, setTypeFilter] = createSignal('')
  const [sourceFilter, setSourceFilter] = createSignal('')
  const [paused, setPaused] = createSignal(false)
  const [queue, setQueue] = createSignal<EventStreamEntry[]>([])
  const [spotlightEntityId, setSpotlightEntityId] = createSignal<string | null>(null)
  const [rate, setRate] = createSignal(0)
  const [selectedEvent, setSelectedEvent] = createSignal<EventStreamEntry | null>(null)
  const [retrying, setRetrying] = createSignal<Set<number>>(new Set())

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
          | undefined,
        status: ((msg.event as Record<string, unknown>)?.status as EventStreamEntry['status']) || 'completed'
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
  const counts = () => categorizeEvents(entries())

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

  const handleRetry = async (entry: EventStreamEntry) => {
    setRetrying((prev) => {
      const next = new Set(prev)
      next.add(entry.id)
      return next
    })
    await retryEvent(entry.id)
    setRetrying((prev) => {
      const next = new Set(prev)
      next.delete(entry.id)
      return next
    })
  }

  return (
    <div class="flex h-full gap-3">
      {/* Main event list */}
      <div class="flex flex-1 flex-col gap-3">
        {/* Queue visualization */}
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex gap-2">
            <span class="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-400">
              ⏳ {counts().pending} pending
            </span>
            <span class="rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] text-blue-400">
              ⚡ {counts().processing} processing
            </span>
            <span class="rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] text-green-400">
              ✓ {counts().completed} completed
            </span>
            <span class="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] text-red-400">
              ✕ {counts().failed} failed
            </span>
          </div>
        </div>

        {/* Filters */}
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
          <span class="text-xs opacity-60">({filtered().length} shown)</span>

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

        {/* Event list */}
        <div
          class="flex-1 overflow-y-auto rounded border font-mono text-xs"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
        >
          {filtered().length === 0 ? (
            <div class="p-4 text-center opacity-50">No events</div>
          ) : (
            <For each={filtered()}>
              {(entry) => (
                <div
                  class={`flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 transition-colors hover:bg-white/5 ${isSpotlighted(entry) ? 'bg-blue-500/10' : ''} ${selectedEvent()?.id === entry.id ? 'bg-white/10' : ''}`}
                  style={{ 'border-color': 'var(--c-border)' }}
                  onClick={() => setSelectedEvent(entry)}
                >
                  {/* Status indicator */}
                  <span
                    class={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      entry.status === 'failed'
                        ? 'bg-red-500'
                        : entry.status === 'processing'
                          ? "animate-pulse bg-blue-500"
                          : entry.status === 'pending'
                            ? 'bg-amber-500'
                            : 'bg-green-500'
                    }`}
                  />

                  <span class="shrink-0 opacity-50">{new Date(entry.capturedAt).toISOString().slice(11, 23)}</span>
                  <span class={`shrink-0 font-medium ${getEventCategoryColor(entry.type)}`}>{entry.type}</span>
                  <span class="shrink-0 opacity-60">{entry.source}</span>
                  <span class="flex-1" />

                  {/* Retry button for failed events */}
                  <Show when={entry.status === 'failed'}>
                    <button
                      class="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-500/30"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRetry(entry)
                      }}
                      disabled={retrying().has(entry.id)}
                    >
                      {retrying().has(entry.id) ? '…' : '↻ Retry'}
                    </button>
                  </Show>

                  {/* Entity spotlight */}
                  <Show when={entry.entityId}>
                    <button
                      class="text-[10px] opacity-40 hover:opacity-80"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSpotlightEntityId(entry.entityId!)
                      }}
                      title="Spotlight entity"
                    >
                      🔍
                    </button>
                  </Show>
                </div>
              )}
            </For>
          )}
        </div>
      </div>

      {/* Detail panel */}
      <Show when={selectedEvent()}>
        {(event) => (
          <div
            class="w-80 shrink-0 overflow-y-auto rounded border p-3"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
          >
            <div class="mb-3 flex items-center justify-between">
              <span class="text-sm font-semibold">Event Detail</span>
              <button class="text-xs opacity-50 hover:opacity-100" onClick={() => setSelectedEvent(null)}>
                ✕
              </button>
            </div>

            <div class="space-y-2 text-xs">
              <div>
                <span class="opacity-50">ID:</span> <span class="font-mono">{event().id}</span>
              </div>
              <div>
                <span class="opacity-50">Type:</span>{' '}
                <span class={`font-medium ${getEventCategoryColor(event().type)}`}>{event().type}</span>
              </div>
              <div>
                <span class="opacity-50">Source:</span> <span>{event().source}</span>
              </div>
              <div>
                <span class="opacity-50">Time:</span>{' '}
                <span class="font-mono">{new Date(event().capturedAt).toLocaleString()}</span>
              </div>
              <div>
                <span class="opacity-50">Status:</span>{' '}
                <span
                  class={
                    event().status === 'failed'
                      ? 'text-red-400'
                      : event().status === 'processing'
                        ? 'text-blue-400'
                        : event().status === 'pending'
                          ? 'text-amber-400'
                          : 'text-green-400'
                  }
                >
                  {event().status || 'completed'}
                </span>
              </div>
              <Show when={event().entityId}>
                <div>
                  <span class="opacity-50">Entity:</span> <span class="font-mono">{event().entityId}</span>
                </div>
              </Show>

              <div class="mt-3">
                <span class="opacity-50">Payload:</span>
                <pre
                  class="mt-1 max-h-64 overflow-auto rounded border p-2 font-mono text-[10px] whitespace-pre-wrap"
                  style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)' }}
                >
                  {JSON.stringify(event().payload, null, 2)}
                </pre>
              </div>

              <Show when={event().status === 'failed'}>
                <button
                  class="mt-2 w-full rounded bg-red-500/20 py-1.5 text-xs text-red-400 hover:bg-red-500/30"
                  onClick={() => handleRetry(event())}
                  disabled={retrying().has(event().id)}
                >
                  {retrying().has(event().id) ? 'Retrying…' : '↻ Retry Event'}
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

export default EventStreamTab

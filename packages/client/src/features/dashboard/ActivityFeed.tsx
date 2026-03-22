import { createSignal, onMount, onCleanup, For, Show } from 'solid-js'
import { getEventIcon, getEventDescription, formatEventTime, MAX_FEED_EVENTS } from './dashboard-helpers.js'
import type { ActivityEvent, EventType } from './dashboard-helpers.js'

/** Whitelist of event type prefixes/patterns worth showing */
const ALLOWED_EVENT_PREFIXES = [
  'git.',
  'issue.', 'review.',
  'scheduler.job.',
  'meeting.',
  'recording.',
  'worktree.',
]

function isEventAllowed(eventType: string, payload?: any): boolean {
  // Always filter out architecture spam
  if (eventType === 'system.architecture.updated') return false
  // Filter all log.entry events — too noisy for dashboard activity feed
  if (eventType === 'log.entry') return false
  // Filter system.health.updated — too frequent
  if (eventType === 'system.health.updated') return false
  return ALLOWED_EVENT_PREFIXES.some((p) => eventType.startsWith(p))
}

/** Map raw bus event names to human-readable descriptions */
const EVENT_LABEL_MAP: Record<string, string> = {
  'log.entry': 'Log entry',
  'system.health.updated': 'Health check',
  'system.architecture.updated': 'Architecture updated',
  'ws.connected': 'Client connected',
  'ws.disconnected': 'Client disconnected',
  'config.changed': 'Config updated',
}

const EVENT_PREFIX_MAP: [string, string][] = [
  ['notification.', 'Notification'],
  ['scheduler.job.', 'Job executed'],
  ['git.', 'Git activity'],
]

function humanizeEventName(raw: string): string {
  // Strip "pin " prefix (internal detail)
  const cleaned = raw.replace(/^pin\s+/, '')

  // Exact match
  if (EVENT_LABEL_MAP[cleaned]) return EVENT_LABEL_MAP[cleaned]

  // Prefix match
  for (const [prefix, label] of EVENT_PREFIX_MAP) {
    if (cleaned.startsWith(prefix)) return label
  }

  // Default: capitalize and clean up
  return cleaned
    .replace(/\./g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
}

export interface ActivityFeedEntry {
  id: string
  type: EventType
  description: string
  timestamp: number
}

export function createActivityFeedStore() {
  const [entries, setEntries] = createSignal<ActivityFeedEntry[]>([])

  function addEntry(entry: ActivityFeedEntry): void {
    setEntries((prev) => {
      const next = [entry, ...prev]
      return next.slice(0, MAX_FEED_EVENTS)
    })
  }

  function clear(): void {
    setEntries([])
  }

  return { entries, addEntry, clear }
}

export function ActivityFeed() {
  const store = createActivityFeedStore()
  let wsUnsub: (() => void) | undefined
  let containerRef: HTMLDivElement | undefined

  onMount(async () => {
    // Fetch initial events from server
    try {
      const res = await fetch('/api/system/events')
      if (res.ok) {
        const data = await res.json()
        const events: ActivityFeedEntry[] = (data.entries ?? data.events ?? [])
          .filter((e: any) => isEventAllowed(e.event?.type ?? e.type ?? '', e.event?.payload ?? e.payload))
          .slice(0, MAX_FEED_EVENTS)
          .map((e: any) => ({
            id: String(e.id ?? e.capturedAt ?? Date.now()),
            type: (e.event?.type?.split('.')[0] ?? e.type ?? 'system') as EventType,
            description: humanizeEventName(e.event?.type ?? e.type ?? 'Event'),
            timestamp: e.capturedAt ?? e.timestamp ?? Date.now()
          }))
        for (const evt of events.reverse()) {
          store.addEntry(evt)
        }
      }
    } catch { /* no server events endpoint */ }

    // Subscribe to WS for live updates
    try {
      const { wsStore } = await import('../../ws/index.js').catch(() => ({ wsStore: null }))
      if (wsStore) {
        wsUnsub = wsStore.on('system.event', (msg: any) => {
          const eventType = msg.eventType ?? msg.description ?? ''
          if (!isEventAllowed(eventType, msg.payload)) return
          store.addEntry({
            id: String(msg.id ?? Date.now()),
            type: (msg.eventType?.split('.')[0] ?? 'system') as EventType,
            description: humanizeEventName(msg.description ?? msg.eventType ?? 'Event'),
            timestamp: msg.timestamp ?? Date.now()
          })
        })
      }
    } catch { /* no ws store */ }
  })

  onCleanup(() => {
    wsUnsub?.()
  })

  return (
    <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <h3 class="mb-2 text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        Activity
      </h3>
      <Show
        when={store.entries().length > 0}
        fallback={
          <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            No recent activity
          </p>
        }
      >
        <div ref={containerRef} class="max-h-64 overflow-y-auto space-y-1">
          <For each={store.entries()}>
            {(entry) => (
              <div class="flex items-start gap-2 py-1 text-xs" style={{ color: 'var(--c-text-secondary)' }}>
                <span class="shrink-0">{getEventIcon(entry.type)}</span>
                <span class="flex-1 truncate">{entry.description}</span>
                <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                  {formatEventTime(entry.timestamp)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

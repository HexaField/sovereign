// Activity Tab — unified Logs + Events stream (replaces LogsTab + EventStreamTab)

import { createSignal, createMemo, onMount, onCleanup, For, Show, type Component } from 'solid-js'
import { wsStore } from '../../ws/index.js'

// ── Shared types ────────────────────────────────────────────────────────────

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
const ALL_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR']

interface LogEntry {
  timestamp: string
  level: LogLevel
  module: string
  message: string
  entityId?: string
}

interface EventEntry {
  id: number
  capturedAt: string
  type: string
  source: string
  payload: unknown
  entityId?: string
  status?: 'pending' | 'processing' | 'completed' | 'failed'
}

// ── Log helpers ─────────────────────────────────────────────────────────────

function levelBadge(level: LogLevel): string {
  switch (level) {
    case 'DEBUG':
      return 'bg-gray-500/20 text-gray-400'
    case 'INFO':
      return 'bg-blue-500/20 text-blue-400'
    case 'WARN':
      return 'bg-amber-500/20 text-amber-400'
    case 'ERROR':
      return 'bg-red-500/20 text-red-400'
  }
}

function normalizeLevel(level: string): LogLevel {
  const u = level.toUpperCase()
  return u === 'DEBUG' || u === 'INFO' || u === 'WARN' || u === 'ERROR' ? (u as LogLevel) : 'INFO'
}

function fmtTs(ts: string): string {
  try {
    return new Date(ts).toISOString().slice(11, 23)
  } catch {
    return ts
  }
}

// ── Event helpers ────────────────────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
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

function eventColor(type: string): string {
  return EVENT_COLORS[type.split('.')[0]] ?? 'text-gray-400'
}

async function retryEvent(id: number): Promise<void> {
  await fetch(`/api/events/${id}/retry`, { method: 'POST' })
}

// ── Logs panel ───────────────────────────────────────────────────────────────

const LogsPanel: Component = () => {
  const [logs, setLogs] = createSignal<LogEntry[]>([])
  const [enabledLevels, setEnabledLevels] = createSignal<Set<LogLevel>>(new Set(ALL_LEVELS))
  const [moduleFilter, setModuleFilter] = createSignal('')
  const [search, setSearch] = createSignal('')
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [isLive, setIsLive] = createSignal(false)
  const [paused, setPaused] = createSignal(false)
  const [queued, setQueued] = createSignal<LogEntry[]>([])

  let scrollRef: HTMLDivElement | undefined
  let liveTimer: ReturnType<typeof setTimeout> | undefined

  const push = (entries: LogEntry[]) => {
    if (paused()) {
      setQueued((q) => [...q, ...entries])
      return
    }
    setLogs((prev) => {
      const next = [...prev, ...entries]
      return next.length > 5000 ? next.slice(next.length - 5000) : next
    })
    setIsLive(true)
    if (liveTimer) clearTimeout(liveTimer)
    liveTimer = setTimeout(() => setIsLive(false), 2000)
    if (autoScroll() && scrollRef) {
      requestAnimationFrame(() => {
        if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight
      })
    }
  }

  onMount(() => {
    wsStore.subscribe(['logs'])
    const offHist = wsStore.on('log.history', (msg: any) => {
      push(
        (msg.entries || []).map((e: any) => ({
          timestamp: typeof e.timestamp === 'number' ? new Date(e.timestamp).toISOString() : e.timestamp,
          level: normalizeLevel(e.level),
          module: e.module,
          message: e.message,
          entityId: e.entityId
        }))
      )
    })
    const offEntry = wsStore.on('log.entry', (msg: any) => {
      push([
        {
          timestamp: msg.timestamp || new Date().toISOString(),
          level: normalizeLevel(msg.level),
          module: msg.module,
          message: msg.message,
          entityId: msg.entityId
        }
      ])
    })
    onCleanup(() => {
      offHist()
      offEntry()
      wsStore.unsubscribe(['logs'])
      if (liveTimer) clearTimeout(liveTimer)
    })
  })

  const modules = createMemo(() => Array.from(new Set(logs().map((e) => e.module))).sort())
  const filtered = createMemo(() =>
    logs().filter((e) => {
      if (!enabledLevels().has(e.level)) return false
      if (moduleFilter() && e.module !== moduleFilter()) return false
      if (
        search() &&
        !e.message.toLowerCase().includes(search().toLowerCase()) &&
        !e.module.toLowerCase().includes(search().toLowerCase())
      )
        return false
      return true
    })
  )

  const toggleLevel = (l: LogLevel) => {
    const next = new Set(enabledLevels())
    next.has(l) ? next.delete(l) : next.add(l)
    setEnabledLevels(next)
  }

  const flush = () => {
    const q = queued()
    setQueued([])
    setPaused(false)
    if (q.length)
      setLogs((prev) => {
        const next = [...prev, ...q]
        return next.length > 5000 ? next.slice(next.length - 5000) : next
      })
  }

  return (
    <div class="flex h-full flex-col gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2">
          <For each={ALL_LEVELS}>
            {(level) => (
              <label class="flex cursor-pointer items-center gap-1 text-xs">
                <input type="checkbox" checked={enabledLevels().has(level)} onChange={() => toggleLevel(level)} />
                <span class={`rounded px-1.5 py-0.5 text-xs font-medium ${levelBadge(level)}`}>{level}</span>
              </label>
            )}
          </For>
        </div>
        <select
          class="rounded border px-2 py-1 text-xs"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          value={moduleFilter()}
          onChange={(e) => setModuleFilter(e.currentTarget.value)}
        >
          <option value="">All modules</option>
          <For each={modules()}>{(m) => <option value={m}>{m}</option>}</For>
        </select>
        <input
          type="text"
          placeholder="Search logs…"
          class="rounded border px-2 py-1 text-xs"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <button
          class="rounded border px-2 py-1 text-xs"
          style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          onClick={() => setLogs([])}
        >
          Clear
        </button>
        <button
          class="rounded border px-2 py-1 text-xs"
          style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          onClick={() => (paused() ? flush() : setPaused(true))}
        >
          {paused() ? `Resume (${queued().length})` : 'Pause'}
        </button>
        <Show when={isLive()}>
          <span class="text-xs text-green-400">● Live</span>
        </Show>
      </div>
      <div
        ref={scrollRef}
        class="flex-1 overflow-y-auto rounded border font-mono text-xs"
        style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
        onScroll={() => {
          if (!scrollRef) return
          setAutoScroll(scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight < 40)
        }}
      >
        {filtered().length === 0 ? (
          <div class="p-4 text-center opacity-50">No log entries</div>
        ) : (
          <For each={filtered()}>
            {(entry) => (
              <div class="flex gap-2 border-b px-3 py-1.5" style={{ 'border-color': 'var(--c-border)' }}>
                <span class="shrink-0 opacity-50">{fmtTs(entry.timestamp)}</span>
                <span class={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${levelBadge(entry.level)}`}>
                  {entry.level}
                </span>
                <span class="shrink-0 font-medium opacity-70">{entry.module}</span>
                <span class="break-all">{entry.message}</span>
              </div>
            )}
          </For>
        )}
      </div>
    </div>
  )
}

// ── Events panel ─────────────────────────────────────────────────────────────

const EventsPanel: Component = () => {
  const [entries, setEntries] = createSignal<EventEntry[]>([])
  const [typeFilter, setTypeFilter] = createSignal('')
  const [sourceFilter, setSourceFilter] = createSignal('')
  const [paused, setPaused] = createSignal(false)
  const [queue, setQueue] = createSignal<EventEntry[]>([])
  const [rate, setRate] = createSignal(0)
  const [selected, setSelected] = createSignal<EventEntry | null>(null)
  const [retrying, setRetrying] = createSignal<Set<number>>(new Set())

  let rateInterval: ReturnType<typeof setInterval> | undefined

  const push = (entry: EventEntry) => {
    if (paused()) {
      setQueue((q) => [...q, entry])
      return
    }
    setEntries((prev) => {
      const next = [entry, ...prev]
      return next.length > 2000 ? next.slice(0, 2000) : next
    })
  }

  onMount(() => {
    wsStore.subscribe(['events'])
    const offHist = wsStore.on('event.history', (msg: Record<string, unknown>) => {
      setEntries(((msg.events as EventEntry[]) || []).slice(0, 2000))
    })
    const offNew = wsStore.on('event.new', (msg: Record<string, unknown>) => {
      const ev = msg.event as Record<string, unknown> | undefined
      push({
        id: msg.id as number,
        capturedAt: (msg.capturedAt as string) || new Date().toISOString(),
        type: (ev?.type as string) || (msg.type as string) || '',
        source: (ev?.source as string) || (msg.source as string) || '',
        payload: ev?.payload ?? msg.payload,
        entityId: (ev?.payload as Record<string, unknown>)?.entityId as string | undefined,
        status: (ev?.status as EventEntry['status']) || 'completed'
      })
    })
    rateInterval = setInterval(() => {
      const now = Date.now()
      setRate(entries().filter((e) => now - new Date(e.capturedAt).getTime() < 1000).length)
    }, 1000)
    onCleanup(() => {
      offHist()
      offNew()
      wsStore.unsubscribe(['events'])
      if (rateInterval) clearInterval(rateInterval)
    })
  })

  const filtered = () =>
    entries().filter((e) => {
      if (typeFilter() && !e.type.toLowerCase().includes(typeFilter().toLowerCase())) return false
      if (sourceFilter() && e.source !== sourceFilter()) return false
      return true
    })

  const counts = () => {
    let pending = 0,
      processing = 0,
      completed = 0,
      failed = 0
    for (const e of entries()) {
      if (e.status === 'pending') pending++
      else if (e.status === 'processing') processing++
      else if (e.status === 'failed') failed++
      else completed++
    }
    return { pending, processing, completed, failed }
  }

  const sources = () => Array.from(new Set(entries().map((e) => e.source))).sort()

  const flush = () => {
    const q = queue()
    setQueue([])
    setPaused(false)
    setEntries((prev) => {
      const next = [...q.reverse(), ...prev]
      return next.length > 2000 ? next.slice(0, 2000) : next
    })
  }

  const handleRetry = async (entry: EventEntry) => {
    setRetrying((s) => {
      const n = new Set(s)
      n.add(entry.id)
      return n
    })
    await retryEvent(entry.id)
    setRetrying((s) => {
      const n = new Set(s)
      n.delete(entry.id)
      return n
    })
  }

  const c = () => counts()

  return (
    <div class="flex h-full gap-3">
      <div class="flex flex-1 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex gap-2">
            <span class="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-400">
              ⏳ {c().pending} pending
            </span>
            <span class="rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] text-blue-400">
              ⚡ {c().processing} processing
            </span>
            <span class="rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] text-green-400">
              ✓ {c().completed} completed
            </span>
            <span class="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] text-red-400">✕ {c().failed} failed</span>
          </div>
        </div>
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
            onClick={() => (paused() ? flush() : setPaused(true))}
          >
            {paused() ? `Resume (${queue().length})` : 'Pause'}
          </button>
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
                <div
                  class={`flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 transition-colors hover:bg-white/5 ${selected()?.id === entry.id ? 'bg-white/10' : ''}`}
                  style={{ 'border-color': 'var(--c-border)' }}
                  onClick={() => setSelected(entry)}
                >
                  <span
                    class={`h-1.5 w-1.5 shrink-0 rounded-full ${entry.status === 'failed' ? 'bg-red-500' : entry.status === 'processing' ? "animate-pulse bg-blue-500" : entry.status === 'pending' ? 'bg-amber-500' : 'bg-green-500'}`}
                  />
                  <span class="shrink-0 opacity-50">{new Date(entry.capturedAt).toISOString().slice(11, 23)}</span>
                  <span class={`shrink-0 font-medium ${eventColor(entry.type)}`}>{entry.type}</span>
                  <span class="shrink-0 opacity-60">{entry.source}</span>
                  <span class="flex-1" />
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
                </div>
              )}
            </For>
          )}
        </div>
      </div>

      {/* Detail panel */}
      <Show when={selected()}>
        {(ev) => (
          <div
            class="w-80 shrink-0 overflow-y-auto rounded border p-3"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
          >
            <div class="mb-3 flex items-center justify-between">
              <span class="text-sm font-semibold">Event Detail</span>
              <button class="text-xs opacity-50 hover:opacity-100" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>
            <div class="space-y-2 text-xs">
              <div>
                <span class="opacity-50">ID:</span> <span class="font-mono">{ev().id}</span>
              </div>
              <div>
                <span class="opacity-50">Type:</span>{' '}
                <span class={`font-medium ${eventColor(ev().type)}`}>{ev().type}</span>
              </div>
              <div>
                <span class="opacity-50">Source:</span> <span>{ev().source}</span>
              </div>
              <div>
                <span class="opacity-50">Time:</span>{' '}
                <span class="font-mono">{new Date(ev().capturedAt).toLocaleString()}</span>
              </div>
              <div>
                <span class="opacity-50">Status:</span>{' '}
                <span
                  class={
                    ev().status === 'failed'
                      ? 'text-red-400'
                      : ev().status === 'processing'
                        ? 'text-blue-400'
                        : ev().status === 'pending'
                          ? 'text-amber-400'
                          : 'text-green-400'
                  }
                >
                  {ev().status || 'completed'}
                </span>
              </div>
              <Show when={ev().entityId}>
                <div>
                  <span class="opacity-50">Entity:</span> <span class="font-mono">{ev().entityId}</span>
                </div>
              </Show>
              <div class="mt-3">
                <span class="opacity-50">Payload:</span>
                <pre
                  class="mt-1 max-h-64 overflow-auto rounded border p-2 font-mono text-[10px] whitespace-pre-wrap"
                  style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)' }}
                >
                  {JSON.stringify(ev().payload, null, 2)}
                </pre>
              </div>
              <Show when={ev().status === 'failed'}>
                <button
                  class="mt-2 w-full rounded bg-red-500/20 py-1.5 text-xs text-red-400 hover:bg-red-500/30"
                  onClick={() => handleRetry(ev())}
                  disabled={retrying().has(ev().id)}
                >
                  {retrying().has(ev().id) ? 'Retrying…' : '↻ Retry Event'}
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

// ── Activity Tab ──────────────────────────────────────────────────────────────

type Mode = 'logs' | 'events'

const ActivityTab: Component = () => {
  const [mode, setMode] = createSignal<Mode>('logs')

  return (
    <div class="flex h-full flex-col gap-3">
      {/* Mode toggle */}
      <div
        class="flex w-fit gap-1 rounded-lg border p-1"
        style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
      >
        {(['logs', 'events'] as Mode[]).map((m) => (
          <button
            class="rounded px-3 py-1 text-sm font-medium transition-colors"
            style={{
              background: mode() === m ? 'var(--c-accent)' : 'transparent',
              color: mode() === m ? 'white' : 'var(--c-text-muted)'
            }}
            onClick={() => setMode(m)}
          >
            {m === 'logs' ? 'Logs' : 'Events'}
          </button>
        ))}
      </div>

      {/* Panel */}
      <div class="min-h-0 flex-1">
        <Show when={mode() === 'logs'}>
          <LogsPanel />
        </Show>
        <Show when={mode() === 'events'}>
          <EventsPanel />
        </Show>
      </div>
    </div>
  )
}

export default ActivityTab

// §6.3 Logs Tab — Scrollable, filterable log viewer
// Data from `logs` WS channel. Level badges, module filter, text search, auto-scroll, clear.

import { createSignal, createMemo, onMount, onCleanup, For, Show, type Component } from 'solid-js'
import { wsStore } from '../../ws/index.js'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  module: string
  message: string
  entityId?: string
}

const MAX_BUFFER = 5000

export function getLevelBadgeClass(level: LogLevel): string {
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

export function formatLogTimestamp(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toISOString().slice(11, 23) // HH:MM:SS.mmm
  } catch {
    return ts
  }
}

export function filterLogs(logs: LogEntry[], levels: Set<LogLevel>, moduleFilter: string, search: string): LogEntry[] {
  return logs.filter((entry) => {
    if (!levels.has(entry.level)) return false
    if (moduleFilter && entry.module !== moduleFilter) return false
    if (
      search &&
      !entry.message.toLowerCase().includes(search.toLowerCase()) &&
      !entry.module.toLowerCase().includes(search.toLowerCase())
    )
      return false
    return true
  })
}

function normalizeLevel(level: string): LogLevel {
  const u = level.toUpperCase()
  if (u === 'DEBUG' || u === 'INFO' || u === 'WARN' || u === 'ERROR') return u as LogLevel
  return 'INFO'
}

const ALL_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR']

const LogsTab: Component = () => {
  const [logs, setLogs] = createSignal<LogEntry[]>([])
  const [enabledLevels, setEnabledLevels] = createSignal<Set<LogLevel>>(new Set(ALL_LEVELS))
  const [moduleFilter, setModuleFilter] = createSignal('')
  const [search, setSearch] = createSignal('')
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [isLive, setIsLive] = createSignal(false)
  const [paused, setPaused] = createSignal(false)
  const [queuedEntries, setQueuedEntries] = createSignal<LogEntry[]>([])

  let scrollRef: HTMLDivElement | undefined
  let liveTimer: ReturnType<typeof setTimeout> | undefined

  const addEntries = (entries: LogEntry[]) => {
    if (paused()) {
      setQueuedEntries((prev) => [...prev, ...entries])
      return
    }
    setLogs((prev) => {
      const next = [...prev, ...entries]
      return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next
    })
    // Show live indicator
    setIsLive(true)
    if (liveTimer) clearTimeout(liveTimer)
    liveTimer = setTimeout(() => setIsLive(false), 2000)

    // Auto-scroll
    if (autoScroll() && scrollRef) {
      requestAnimationFrame(() => {
        if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight
      })
    }
  }

  const flushQueue = () => {
    const queued = queuedEntries()
    setQueuedEntries([])
    setPaused(false)
    if (queued.length > 0) {
      setLogs((prev) => {
        const next = [...prev, ...queued]
        return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next
      })
    }
  }

  onMount(() => {
    wsStore.subscribe(['logs'])

    const offHistory = wsStore.on('log.history', (msg: any) => {
      const entries = (msg.entries || []).map((e: any) => ({
        timestamp: typeof e.timestamp === 'number' ? new Date(e.timestamp).toISOString() : e.timestamp,
        level: normalizeLevel(e.level),
        module: e.module,
        message: e.message,
        entityId: e.entityId
      }))
      addEntries(entries)
    })

    const offEntry = wsStore.on('log.entry', (msg: any) => {
      const entry: LogEntry = {
        timestamp: msg.timestamp || new Date().toISOString(),
        level: normalizeLevel(msg.level),
        module: msg.module,
        message: msg.message,
        entityId: msg.entityId
      }
      addEntries([entry])
    })

    onCleanup(() => {
      offHistory()
      offEntry()
      wsStore.unsubscribe(['logs'])
      if (liveTimer) clearTimeout(liveTimer)
    })
  })

  const modules = createMemo(() => {
    const set = new Set<string>()
    for (const entry of logs()) set.add(entry.module)
    return Array.from(set).sort()
  })

  const filtered = createMemo(() => filterLogs(logs(), enabledLevels(), moduleFilter(), search()))

  const toggleLevel = (level: LogLevel) => {
    const next = new Set(enabledLevels())
    if (next.has(level)) next.delete(level)
    else next.add(level)
    setEnabledLevels(next)
  }

  const clear = () => setLogs([])

  const handleScroll = () => {
    if (!scrollRef) return
    const atBottom = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight < 40
    setAutoScroll(atBottom)
  }

  return (
    <div class="flex h-full flex-col gap-3">
      {/* Filters bar */}
      <div class="flex flex-wrap items-center gap-3">
        {/* Level checkboxes */}
        <div class="flex items-center gap-2">
          <For each={ALL_LEVELS}>
            {(level) => (
              <label class="flex cursor-pointer items-center gap-1 text-xs">
                <input type="checkbox" checked={enabledLevels().has(level)} onChange={() => toggleLevel(level)} />
                <span class={`rounded px-1.5 py-0.5 text-xs font-medium ${getLevelBadgeClass(level)}`}>{level}</span>
              </label>
            )}
          </For>
        </div>

        {/* Module dropdown */}
        <select
          class="rounded border px-2 py-1 text-xs"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          value={moduleFilter()}
          onChange={(e) => setModuleFilter(e.currentTarget.value)}
        >
          <option value="">All modules</option>
          <For each={modules()}>{(mod) => <option value={mod}>{mod}</option>}</For>
        </select>

        {/* Text search */}
        <input
          type="text"
          placeholder="Search logs…"
          class="rounded border px-2 py-1 text-xs"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />

        {/* Clear button */}
        <button
          class="rounded border px-2 py-1 text-xs hover:opacity-80"
          style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          onClick={clear}
        >
          Clear
        </button>

        {/* Pause/Resume */}
        <button
          class="rounded border px-2 py-1 text-xs hover:opacity-80"
          style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          onClick={() => {
            if (paused()) {
              flushQueue()
            } else {
              setPaused(true)
            }
          }}
        >
          {paused() ? `Resume (${queuedEntries().length})` : 'Pause'}
        </button>

        {/* Live indicator */}
        <Show when={isLive()}>
          <span class="text-xs text-green-400" data-testid="live-indicator">
            ● Live
          </span>
        </Show>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        class="flex-1 overflow-y-auto rounded border font-mono text-xs"
        style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
        onScroll={handleScroll}
      >
        {filtered().length === 0 ? (
          <div class="p-4 text-center opacity-50">No log entries</div>
        ) : (
          <For each={filtered()}>
            {(entry) => (
              <div class="flex gap-2 border-b px-3 py-1.5" style={{ 'border-color': 'var(--c-border)' }}>
                <span class="shrink-0 opacity-50">{formatLogTimestamp(entry.timestamp)}</span>
                <span class={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${getLevelBadgeClass(entry.level)}`}>
                  {entry.level}
                </span>
                <span class="shrink-0 font-medium opacity-70">{entry.module}</span>
                <span class="break-all">{entry.message}</span>
                <Show when={entry.entityId}>
                  <a
                    href={`#entity/${entry.entityId}`}
                    class="shrink-0 text-blue-400 underline"
                    data-testid="entity-link"
                  >
                    {entry.entityId}
                  </a>
                </Show>
              </div>
            )}
          </For>
        )}
      </div>
    </div>
  )
}

export default LogsTab

import { createSignal, createEffect, on, For, Show, onCleanup } from 'solid-js'
import type { Component } from 'solid-js'
import { activeWorkspace } from '../store.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  timestamp: number
  level: LogLevel
  module: string
  message: string
}

export const LOG_LEVEL_ICONS: Record<LogLevel, string> = {
  debug: 'debug',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌'
}

export function filterLogs(entries: LogEntry[], level: LogLevel | null, module: string | null): LogEntry[] {
  return entries.filter((e) => {
    if (level && e.level !== level) return false
    if (module && e.module !== module) return false
    return true
  })
}

const LogsPanel: Component = () => {
  const [levelFilter, setLevelFilter] = createSignal<LogLevel | null>(null)
  const [moduleFilter, setModuleFilter] = createSignal<string | null>(null)
  const [logs, setLogs] = createSignal<LogEntry[]>([])
  const [loading, setLoading] = createSignal(false)
  const [autoScroll, setAutoScroll] = createSignal(true)
  const ws = () => activeWorkspace()

  let scrollContainer: HTMLDivElement | undefined
  let pollInterval: ReturnType<typeof setInterval> | undefined

  async function fetchLogs(orgId: string) {
    setLoading(true)
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/logs?limit=100`)
      if (res.ok) {
        const data = await res.json()
        setLogs(Array.isArray(data) ? data : [])
      } else {
        setLogs([])
      }
    } catch {
      setLogs([])
    } finally {
      setLoading(false)
    }
  }

  function startPolling(orgId: string) {
    stopPolling()
    pollInterval = setInterval(() => {
      fetchLogs(orgId)
    }, 5000)
  }

  function stopPolling() {
    if (pollInterval != null) {
      clearInterval(pollInterval)
      pollInterval = undefined
    }
  }

  createEffect(
    on(
      () => ws()?.orgId,
      (orgId) => {
        stopPolling()
        if (orgId) {
          fetchLogs(orgId)
          startPolling(orgId)
        } else {
          setLogs([])
        }
      }
    )
  )

  onCleanup(() => stopPolling())

  // Auto-scroll when new logs arrive
  createEffect(
    on(
      () => filtered().length,
      () => {
        if (autoScroll() && scrollContainer) {
          // Use queueMicrotask to scroll after DOM update
          queueMicrotask(() => {
            if (scrollContainer) {
              scrollContainer.scrollTop = scrollContainer.scrollHeight
            }
          })
        }
      }
    )
  )

  const filtered = () => filterLogs(logs(), levelFilter(), moduleFilter())

  // Extract unique modules for the filter dropdown
  const modules = () => {
    const set = new Set<string>()
    for (const entry of logs()) {
      if (entry.module) set.add(entry.module)
    }
    return Array.from(set).sort()
  }

  const levelColor = (level: LogLevel): string => {
    switch (level) {
      case 'error':
        return 'var(--c-error)'
      case 'warn':
        return 'var(--c-warning)'
      case 'info':
        return 'var(--c-info)'
      default:
        return 'var(--c-text-muted)'
    }
  }

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  function clearLogs() {
    setLogs([])
  }

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-2 border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Logs
        </span>
        <select
          class="rounded border px-1 py-0.5 text-xs"
          style={{ background: 'var(--c-bg)', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }}
          onChange={(e) => setLevelFilter((e.currentTarget.value as LogLevel) || null)}
        >
          <option value="">All levels</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <select
          class="rounded border px-1 py-0.5 text-xs"
          style={{ background: 'var(--c-bg)', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }}
          onChange={(e) => setModuleFilter(e.currentTarget.value || null)}
        >
          <option value="">All modules</option>
          <For each={modules()}>{(mod) => <option value={mod}>{mod}</option>}</For>
        </select>

        <div class="flex-1" />

        {/* Auto-scroll toggle */}
        <button
          class="rounded px-1.5 py-0.5 text-[10px]"
          style={{
            background: autoScroll() ? 'var(--c-accent)' : 'var(--c-bg-secondary)',
            color: autoScroll() ? 'var(--c-text-on-accent, #fff)' : 'var(--c-text-muted)'
          }}
          onClick={() => setAutoScroll((v) => !v)}
          title={autoScroll() ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
        >
          ↓ Auto
        </button>

        {/* Clear button */}
        <button
          class="rounded px-1.5 py-0.5 text-[10px]"
          style={{ color: 'var(--c-text-muted)' }}
          onClick={clearLogs}
          title="Clear logs"
        >
          Clear
        </button>
      </div>
      <div ref={scrollContainer} class="flex-1 overflow-auto p-2 font-mono text-xs">
        <Show when={loading()}>
          <p style={{ color: 'var(--c-text-muted)' }}>Loading...</p>
        </Show>

        <Show when={!loading() && filtered().length === 0}>
          <div class="flex flex-col items-center gap-2 py-8">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              style={{ color: 'var(--c-text-muted)' }}
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            <p style={{ color: 'var(--c-text-muted)' }}>No logs yet</p>
          </div>
        </Show>

        <Show when={!loading() && filtered().length > 0}>
          <For each={filtered()}>
            {(entry) => (
              <div
                class="flex gap-2 border-b py-1"
                style={{ 'border-color': 'var(--c-border-subtle, var(--c-border))' }}
              >
                <span class="shrink-0 tabular-nums" style={{ color: 'var(--c-text-muted)' }}>
                  {formatTime(entry.timestamp)}
                </span>
                <span
                  class="shrink-0 font-semibold uppercase"
                  style={{ color: levelColor(entry.level), width: '40px' }}
                >
                  {entry.level}
                </span>
                <span class="shrink-0" style={{ color: 'var(--c-accent)' }}>
                  [{entry.module}]
                </span>
                <span style={{ color: 'var(--c-text)' }}>{entry.message}</span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

export default LogsPanel

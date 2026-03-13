import { createSignal } from 'solid-js'
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
  debug: '🔍',
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
  const [_levelFilter, setLevelFilter] = createSignal<LogLevel | null>(null)
  const [_moduleFilter, _setModuleFilter] = createSignal<string | null>(null)
  const ws = () => activeWorkspace()

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
      </div>
      <div class="flex-1 overflow-auto p-2 font-mono text-xs" style={{ color: 'var(--c-text-muted)' }}>
        <p>Listening for logs — {ws()?.orgId ?? 'no workspace'}...</p>
      </div>
    </div>
  )
}

export default LogsPanel

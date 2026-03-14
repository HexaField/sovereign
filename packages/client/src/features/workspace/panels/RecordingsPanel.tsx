import type { Component } from 'solid-js'
import { activeWorkspace } from '../store.js'

export interface RecordingItem {
  id: string
  timestamp: number
  duration: number
  transcriptPreview: string
  threadKey?: string
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${mins}:${rem.toString().padStart(2, '0')}`
}

const RecordingsPanel: Component = () => {
  const ws = () => activeWorkspace()

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Recordings
        </span>
        <button class="rounded px-2 py-0.5 text-xs" style={{ background: 'var(--c-accent)', color: 'var(--c-text)' }}>
          Record
        </button>
      </div>
      <div class="flex-1 overflow-auto p-2">
        <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
          No recordings for {ws()?.orgId ?? 'workspace'}
        </p>
      </div>
    </div>
  )
}

export default RecordingsPanel

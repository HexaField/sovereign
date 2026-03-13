import type { Component } from 'solid-js'
import { activeWorkspace } from '../store.js'

export function getTerminalCwd(orgId: string, projectId: string | null): string {
  if (projectId) return `${orgId}/${projectId}`
  return orgId
}

const TerminalPanel: Component = () => {
  const ws = () => activeWorkspace()

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Terminal
        </span>
        <button class="rounded px-2 py-0.5 text-xs" style={{ background: 'var(--c-accent)', color: 'var(--c-text)' }}>
          + New
        </button>
      </div>
      <div class="flex-1 overflow-hidden p-2">
        <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
          Terminal — {ws()?.activeProjectId ?? ws()?.orgId ?? 'no workspace'}
        </p>
      </div>
    </div>
  )
}

export default TerminalPanel

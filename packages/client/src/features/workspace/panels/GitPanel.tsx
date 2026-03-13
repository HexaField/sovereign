import type { Component } from 'solid-js'
import { Show } from 'solid-js'
import { activeWorkspace } from '../store.js'

export interface GitStatusData {
  branch: string
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

export function buildGitStatusUrl(projectId: string): string {
  return `/api/git/status?project=${encodeURIComponent(projectId)}`
}

const GitPanel: Component = () => {
  const ws = () => activeWorkspace()
  const projectId = () => ws()?.activeProjectId

  return (
    <div class="flex h-full flex-col">
      <div class="border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Git
        </span>
      </div>
      <div class="flex-1 overflow-auto p-2">
        <Show
          when={projectId()}
          fallback={
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              No project selected
            </p>
          }
        >
          <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            Loading git status for {projectId()}...
          </p>
        </Show>
      </div>
    </div>
  )
}

export default GitPanel

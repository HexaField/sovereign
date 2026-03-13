import { Show } from 'solid-js'
import type { Component } from 'solid-js'
import { activeWorkspace } from '../store.js'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  gitStatus?: string // M, A, D, U, ?
}

export function buildTreeUrl(projectId: string): string {
  return `/api/files/tree?project=${encodeURIComponent(projectId)}`
}

export function getFileExtension(filename: string): string {
  const idx = filename.lastIndexOf('.')
  return idx >= 0 ? filename.slice(idx + 1) : ''
}

const FileExplorerPanel: Component = () => {
  const ws = () => activeWorkspace()
  const projectId = () => ws()?.activeProjectId

  return (
    <div class="flex h-full flex-col">
      {/* Header with project selector */}
      <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          {ws()?.activeProjectName ?? 'Files'}
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
            Loading file tree for {projectId()}...
          </p>
        </Show>
      </div>
    </div>
  )
}

export default FileExplorerPanel

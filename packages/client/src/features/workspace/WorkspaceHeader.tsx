import { createSignal, Show } from 'solid-js'
import type { Component } from 'solid-js'
import { activeWorkspace, setActiveWorkspace } from './store.js'

export interface WorkspaceOption {
  orgId: string
  orgName: string
}

// §3.2 — WorkspaceHeader: Breadcrumb, workspace selector, search, connection badge
const WorkspaceHeader: Component<{ workspaces?: WorkspaceOption[] }> = (props) => {
  const [selectorOpen, setSelectorOpen] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal('')

  const ws = () => activeWorkspace()

  return (
    <div
      class="flex items-center gap-3 border-b px-4 py-2"
      style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-raised)' }}
    >
      {/* Breadcrumb: Org > Project */}
      <div class="flex items-center gap-1 text-sm">
        <span style={{ color: 'var(--c-text-heading)' }}>{ws()?.orgName ?? 'No Workspace'}</span>
        <Show when={ws()?.activeProjectName}>
          <span style={{ color: 'var(--c-text-muted)' }}>&gt;</span>
          <span style={{ color: 'var(--c-text)' }}>{ws()!.activeProjectName}</span>
        </Show>
      </div>

      {/* Workspace selector dropdown */}
      <div class="relative">
        <button
          class="rounded px-2 py-1 text-xs transition-colors hover:bg-white/10"
          style={{ color: 'var(--c-text-muted)', border: '1px solid var(--c-border)' }}
          onClick={() => setSelectorOpen(!selectorOpen())}
        >
          ▾
        </button>
        <Show when={selectorOpen()}>
          <div
            class="absolute top-full left-0 z-50 mt-1 min-w-[200px] rounded border shadow-lg"
            style={{ background: 'var(--c-menu-bg, var(--c-bg-raised))', 'border-color': 'var(--c-border)' }}
          >
            {(props.workspaces ?? []).map((w) => (
              <button
                class="block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-white/10"
                style={{ color: ws()?.orgId === w.orgId ? 'var(--c-accent)' : 'var(--c-text)' }}
                onClick={() => {
                  setActiveWorkspace(w.orgId, w.orgName)
                  setSelectorOpen(false)
                }}
              >
                {w.orgName}
              </button>
            ))}
          </div>
        </Show>
      </div>

      {/* Spacer */}
      <div class="flex-1" />

      {/* Search input */}
      <input
        type="text"
        placeholder="Search... (Cmd+P)"
        class="rounded border px-3 py-1 text-sm"
        style={{
          background: 'var(--c-bg)',
          color: 'var(--c-text)',
          'border-color': 'var(--c-border)',
          'max-width': '240px'
        }}
        value={searchQuery()}
        onInput={(e) => setSearchQuery(e.currentTarget.value)}
      />

      {/* Connection badge placeholder */}
      <div class="h-2 w-2 rounded-full" style={{ background: 'var(--c-accent, #22c55e)' }} title="Connected" />
    </div>
  )
}

export default WorkspaceHeader

// Named exports for testing
export { WorkspaceHeader }

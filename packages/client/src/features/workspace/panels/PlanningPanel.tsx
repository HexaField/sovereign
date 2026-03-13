import { Show } from 'solid-js'
import type { Component } from 'solid-js'
import { activeWorkspace } from '../store.js'

export interface PlanningCompletion {
  total: number
  ready: number
  blocked: number
  inProgress: number
}

export function buildPlanningUrl(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/planning/completion`
}

const PlanningPanel: Component = () => {
  const ws = () => activeWorkspace()

  return (
    <div class="flex h-full flex-col">
      <div class="border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Planning
        </span>
      </div>
      <div class="flex-1 overflow-auto p-2">
        <Show
          when={ws()}
          fallback={
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              No workspace
            </p>
          }
        >
          <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            Loading planning for {ws()!.orgId}...
          </p>
        </Show>
      </div>
    </div>
  )
}

export default PlanningPanel

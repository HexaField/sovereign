import { Show } from 'solid-js'
import type { Component } from 'solid-js'
import { activeWorkspace } from '../store.js'

export interface ThreadItem {
  key: string
  label: string
  entityType?: 'branch' | 'issue' | 'pr'
  entityRef?: string
  kind: 'entity-bound' | 'user' | 'agent'
  unreadCount: number
  agentStatus?: string
  hidden?: boolean
}

export function buildThreadsUrl(orgId: string): string {
  return `/api/threads?orgId=${encodeURIComponent(orgId)}`
}

export function groupThreads(threads: ThreadItem[]): {
  entityBound: ThreadItem[]
  user: ThreadItem[]
  agent: ThreadItem[]
  hidden: ThreadItem[]
} {
  const entityBound: ThreadItem[] = []
  const user: ThreadItem[] = []
  const agent: ThreadItem[] = []
  const hidden: ThreadItem[] = []
  for (const t of threads) {
    if (t.hidden) {
      hidden.push(t)
      continue
    }
    if (t.kind === 'entity-bound') entityBound.push(t)
    else if (t.kind === 'user') user.push(t)
    else agent.push(t)
  }
  return { entityBound, user, agent, hidden }
}

const ThreadsPanel: Component = () => {
  const ws = () => activeWorkspace()

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Threads
        </span>
        <button class="rounded px-2 py-0.5 text-xs" style={{ background: 'var(--c-accent)', color: 'var(--c-text)' }}>
          + New
        </button>
      </div>
      <div class="flex-1 overflow-auto p-2">
        <Show
          when={ws()}
          fallback={
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              No workspace selected
            </p>
          }
        >
          <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            Loading threads for {ws()!.orgId}...
          </p>
        </Show>
      </div>
    </div>
  )
}

export default ThreadsPanel

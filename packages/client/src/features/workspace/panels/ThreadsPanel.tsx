import { Show, For, createSignal } from 'solid-js'
import type { Component } from 'solid-js'
import { threads, threadKey, switchThread, createThread } from '../../threads/store.js'
import type { ThreadInfo } from '../../threads/store.js'

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

function statusDot(status: string | undefined) {
  if (status === 'working' || status === 'thinking')
    return <span class="h-2 w-2 shrink-0 animate-pulse rounded-full" style={{ background: '#f59e0b' }} />
  if (status === 'error') return <span class="h-2 w-2 shrink-0 rounded-full" style={{ background: '#ef4444' }} />
  return <span class="h-2 w-2 shrink-0 rounded-full" style={{ background: '#22c55e' }} />
}

const ThreadsPanel: Component = () => {
  const [newLabel, setNewLabel] = createSignal('')
  const [showNew, setShowNew] = createSignal(false)

  const handleCreate = () => {
    const label = newLabel().trim()
    if (!label) return
    createThread(label)
    setNewLabel('')
    setShowNew(false)
  }

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Threads
        </span>
        <button
          class="rounded px-2 py-0.5 text-xs"
          style={{ background: 'var(--c-accent)', color: '#fff' }}
          onClick={() => setShowNew(!showNew())}
        >
          + New
        </button>
      </div>

      {/* New thread form */}
      <Show when={showNew()}>
        <div class="flex gap-1 border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
          <input
            class="flex-1 rounded border px-2 py-1 text-xs outline-none"
            style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            placeholder="Thread name..."
            value={newLabel()}
            onInput={(e) => setNewLabel(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button
            class="rounded px-2 py-1 text-xs"
            style={{ background: 'var(--c-accent)', color: '#fff' }}
            onClick={handleCreate}
          >
            Create
          </button>
        </div>
      </Show>

      <div class="flex-1 overflow-auto p-1">
        <For each={threads()}>
          {(t: ThreadInfo) => (
            <button
              class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs transition-colors"
              style={{
                background: threadKey() === t.key ? 'var(--c-accent)' : 'transparent',
                color: threadKey() === t.key ? '#fff' : 'var(--c-text)'
              }}
              onClick={() => switchThread(t.key)}
            >
              {statusDot(t.agentStatus)}
              <span class="flex-1 truncate">{t.label ?? t.key}</span>
              <Show when={t.unreadCount > 0}>
                <span
                  class="flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
                  style={{ background: 'var(--c-accent)' }}
                >
                  {t.unreadCount}
                </span>
              </Show>
            </button>
          )}
        </For>

        <Show when={threads().length === 0}>
          <p class="px-3 py-4 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
            No additional threads
          </p>
        </Show>
      </div>
    </div>
  )
}

export default ThreadsPanel

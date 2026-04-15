import { createSignal, onMount, For, Show } from 'solid-js'
import { setActiveWorkspace } from '../workspace/store.js'
import { setActiveView } from '../nav/store.js'
import { switchThread } from '../threads/store.js'
import { formatEventTime } from './dashboard-helpers.js'

export default function RecentThreads() {
  const [threads, setThreads] = createSignal<any[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  async function fetchRecent() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/threads?limit=6')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setThreads(data.threads ?? [])
    } catch (err) {
      setError('Failed to load threads')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    fetchRecent()
  })

  const handleClick = (t: any) => {
    setActiveWorkspace(t.orgId ?? '_global', t.orgId ?? undefined)
    setActiveView('workspace')
    switchThread(t.key)
  }

  return (
    <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <h3 class="mb-2 text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        Recent threads
      </h3>

      <Show when={!loading()}>
        <Show
          when={threads().length > 0}
          fallback={
            <div class="text-xs opacity-40" style={{ color: 'var(--c-text-muted)' }}>
              No recent threads
            </div>
          }
        >
          <div class="flex gap-2 overflow-x-auto pb-2">
            <For each={threads()}>
              {(thread) => (
                <button
                  class="min-w-[220px] shrink-0 cursor-pointer rounded-lg border p-3 text-left transition-colors hover:brightness-110"
                  style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)' }}
                  onClick={() => handleClick(thread)}
                >
                  <div class="mb-1 flex w-full items-center gap-2">
                    <span
                      class={`inline-block h-2.5 w-2.5 rounded-full ${thread.agentStatus === 'working' ? 'bg-green-500' : thread.agentStatus === 'thinking' ? 'bg-amber-500' : 'bg-gray-400'}`}
                    />
                    <span class="flex-1 truncate text-sm font-medium" style={{ color: 'var(--c-text)' }}>
                      {thread.label || thread.key}
                    </span>
                    <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                      {formatEventTime(thread.lastActivity ?? Date.now())}
                    </span>
                  </div>

                  <div class="text-[11px] leading-[16px]" style={{ color: 'var(--c-text-muted)' }}>
                    {thread.orgId}
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={loading()}>
        <div class="text-xs opacity-40" style={{ color: 'var(--c-text-muted)' }}>
          Loading…
        </div>
      </Show>

      <Show when={error()}>
        <div class="text-xs text-red-400">{error()}</div>
      </Show>
    </div>
  )
}

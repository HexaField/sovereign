import { createSignal, onMount, onCleanup, For, Show } from 'solid-js'
import { setActiveWorkspace } from '../workspace/store'
import { setActiveView } from '../nav/store'
import { switchThread } from '../threads/store'
import { formatRelativeTime } from '../threads/helpers'

interface ThreadInfo {
  key: string
  orgId?: string
  label?: string
  lastActivity?: number
  unreadCount?: number
  agentStatus?: string
}

function StatusDot(props: { status?: string }) {
  const isActive = (s?: string) => s === 'working' || s === 'thinking' || s === 'busy' || s === 'streaming'
  const isFailed = (s?: string) => s === 'failed' || s === 'error'
  const color = () => (isActive(props.status) ? '#22c55e' : isFailed(props.status) ? '#ef4444' : 'gray')
  return (
    <span
      class="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color(), opacity: isActive(props.status) || isFailed(props.status) ? '1' : '0.5' }}
    />
  )
}

export default function DashboardThreadsView() {
  const [threads, setThreads] = createSignal<ThreadInfo[]>([])
  const [loading, setLoading] = createSignal(true)

  async function fetchThreads() {
    try {
      const res = await fetch('/api/threads')
      if (!res.ok) return
      const data = await res.json()
      const list: ThreadInfo[] = (data.threads ?? []).slice(0, 6)
      setThreads(list)
    } catch (e) {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    fetchThreads()
    const timer = setInterval(fetchThreads, 30_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchThreads()
    }
    document.addEventListener('visibilitychange', onVisibility)
    onCleanup(() => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    })
  })

  const openThread = (t: ThreadInfo) => {
    // switch workspace context if thread has orgId
    if (t.orgId) setActiveWorkspace(t.orgId, t.orgId)
    // switch to workspace view
    setActiveView('workspace')
    switchThread(t.key)
  }

  return (
    <div class="p-3">
      <h3 class="mb-2 text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        Recent Threads
      </h3>

      <Show when={!loading()} fallback={<div class="text-xs opacity-40">Loading recent threads…</div>}>
        <style>{`
          .threads-strip { scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; }
          .thread-card { scroll-snap-align: start; }
        `}</style>

        <div class="threads-strip flex gap-3 overflow-x-auto pb-3">
          <For each={threads()}>
            {(t) => (
              <button
                class="thread-card flex w-[260px] shrink-0 cursor-pointer flex-col rounded-lg border p-2.5 text-left transition-colors hover:brightness-110"
                style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', 'min-height': '80px' }}
                onClick={() => openThread(t)}
                title={t.label ?? t.key}
              >
                <div class="mb-1 flex w-full items-center gap-1.5">
                  <StatusDot status={t.agentStatus} />
                  <span class="flex-1 truncate text-xs font-medium" style={{ color: 'var(--c-text)' }}>
                    {t.label ?? t.key}
                  </span>
                  <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    {t.lastActivity ? formatRelativeTime(t.lastActivity) : ''}
                  </span>
                </div>

                <div class="flex-1 overflow-hidden">
                  <div class="text-[11px]" style={{ color: 'var(--c-text-muted)', opacity: '0.7' }}>
                    {t.unreadCount ? `${t.unreadCount} unread` : ''}
                  </div>
                </div>
              </button>
            )}
          </For>

          <Show when={threads().length === 0}>
            <div class="text-xs opacity-40">No threads found</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

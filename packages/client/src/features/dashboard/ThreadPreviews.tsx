// Thread card previews — shows latest threads per workspace with lazy message loading
import { createSignal, onMount, For, Show } from 'solid-js'
import { setActiveWorkspace } from '../workspace/store'
import { setActiveView } from '../nav/store'
import { switchThread } from '../threads/store'

interface ThreadInfo {
  key: string
  label: string
  orgId: string
  lastActivity: number | null
  agentStatus: string
}

interface PreviewEntry {
  type: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result'
  text: string
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function isActive(status: string): boolean {
  return status === 'working' || status === 'thinking' || status === 'busy' || status === 'streaming'
}

function isFailed(status: string): boolean {
  return status === 'failed' || status === 'error'
}

function StatusDot(props: { status: string }) {
  const color = () => {
    if (isActive(props.status)) return '#22c55e'
    if (isFailed(props.status)) return '#ef4444'
    return 'gray'
  }
  return (
    <span
      class="inline-block h-2 w-2 shrink-0 rounded-full"
      classList={{
        'status-dot-active': isActive(props.status)
      }}
      style={{ background: color(), opacity: isActive(props.status) || isFailed(props.status) ? '1' : '0.4' }}
    />
  )
}

export default function ThreadPreviews(props: { orgId: string; orgName: string }) {
  const [threads, setThreads] = createSignal<ThreadInfo[]>([])
  const [lastMessages, setLastMessages] = createSignal<Map<string, PreviewEntry>>(new Map())
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    // Step 1: Load thread metadata (fast — just titles, timestamps, status)
    try {
      const res = await fetch(`/api/threads?orgId=${encodeURIComponent(props.orgId)}&limit=3`)
      if (!res.ok) return
      const data = await res.json()
      const list: ThreadInfo[] = (data.threads ?? []).slice(0, 3)
      setThreads(list)
      setLoading(false)

      // Step 2: Lazy-load last message for each thread (non-blocking, one at a time)
      for (const t of list) {
        try {
          const pRes = await fetch(`/api/threads/${encodeURIComponent(t.key)}/preview-messages?limit=1`)
          if (pRes.ok) {
            const p = await pRes.json()
            const msgs: PreviewEntry[] = p.messages ?? []
            if (msgs.length > 0) {
              setLastMessages((prev) => {
                const next = new Map(prev)
                next.set(t.key, msgs[msgs.length - 1])
                return next
              })
            }
            // Update agent status from preview if available
            if (p.agentStatus && p.agentStatus !== t.agentStatus) {
              setThreads((prev) => prev.map((th) => (th.key === t.key ? { ...th, agentStatus: p.agentStatus } : th)))
            }
          }
        } catch {
          /* ignore — card still shows with title + time */
        }
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  })

  const handleCreate = async () => {
    try {
      const res = await fetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: props.orgId })
      })
      if (res.ok) {
        const { thread } = await res.json()
        setActiveWorkspace(props.orgId, props.orgName)
        setActiveView('workspace')
        switchThread(thread.key)
      }
    } catch {
      /* ignore */
    }
  }

  const handleClick = (threadKey: string) => {
    setActiveWorkspace(props.orgId, props.orgName)
    setActiveView('workspace')
    switchThread(threadKey)
  }

  return (
    <Show when={!loading()}>
      <style>{`
        @keyframes status-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .status-dot-active {
          animation: status-pulse 1.5s ease-in-out infinite;
        }
      `}</style>
      <div class="mt-2 flex gap-2 overflow-x-auto pb-1 md:grid md:grid-cols-2 md:overflow-x-visible lg:grid-cols-3">
        <For each={threads()}>
          {(thread) => {
            const lastMsg = () => lastMessages().get(thread.key)
            return (
              <button
                class="flex w-[260px] shrink-0 cursor-pointer flex-col rounded-lg border p-2.5 text-left transition-colors hover:brightness-110 md:w-auto md:shrink"
                style={{
                  background: 'var(--c-bg-raised)',
                  'border-color': 'var(--c-border)',
                  'min-height': '80px'
                }}
                onClick={(e: MouseEvent) => {
                  if (e.metaKey || e.ctrlKey) {
                    const url = new URL(window.location.href)
                    url.hash = `thread=${thread.key}`
                    url.searchParams.set('view', 'workspace')
                    window.open(url.toString(), '_blank')
                  } else {
                    handleClick(thread.key)
                  }
                }}
              >
                {/* Header: status dot + name + time */}
                <div class="mb-1 flex w-full items-center gap-1.5">
                  <StatusDot status={thread.agentStatus} />
                  <span class="flex-1 truncate text-xs font-medium" style={{ color: 'var(--c-text)' }}>
                    {thread.label || thread.key}
                  </span>
                  <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    {formatRelativeTime(thread.lastActivity)}
                  </span>
                </div>

                {/* Last message preview */}
                <div class="flex-1 overflow-hidden">
                  <Show
                    when={lastMsg()}
                    fallback={
                      <div class="text-[11px]" style={{ color: 'var(--c-text-muted)', opacity: '0.4' }}>
                        {loading() ? '…' : ''}
                      </div>
                    }
                  >
                    {(msg) => (
                      <div
                        class="truncate text-[11px] leading-[16px]"
                        style={{
                          color: msg().type === 'user' ? 'var(--c-text)' : 'var(--c-text-muted)',
                          opacity: msg().type === 'user' ? '1' : '0.7',
                          'font-style': msg().type === 'thinking' ? 'italic' : 'normal'
                        }}
                      >
                        {msg().text}
                      </div>
                    )}
                  </Show>
                </div>
              </button>
            )
          }}
        </For>

        {/* New thread button */}
        <button
          class="flex cursor-pointer items-center justify-center rounded-lg border transition-colors hover:brightness-125"
          style={{
            background: 'var(--c-bg-raised)',
            'border-color': 'var(--c-border)',
            color: 'var(--c-text-muted)',
            'min-height': '80px'
          }}
          onClick={handleCreate}
          title="New thread"
        >
          <div class="flex flex-col items-center gap-1">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
            <span class="text-[11px]">New thread</span>
          </div>
        </button>
      </div>
    </Show>
  )
}

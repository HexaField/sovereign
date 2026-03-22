// Thread chat previews — horizontal scroll row below each workspace card
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

interface ThreadPreview {
  key: string
  label: string
  lastMessage: string | null
  agentStatus: string
}

export default function ThreadPreviews(props: { orgId: string; orgName: string }) {
  const [previews, setPreviews] = createSignal<ThreadPreview[]>([])
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    try {
      const res = await fetch(`/api/threads?orgId=${encodeURIComponent(props.orgId)}`)
      if (!res.ok) return
      const data = await res.json()
      const threads: ThreadInfo[] = (data.threads ?? []).slice(0, 3)

      const results = await Promise.all(
        threads.map(async (t) => {
          try {
            const pRes = await fetch(`/api/threads/${encodeURIComponent(t.key)}/preview`)
            if (pRes.ok) {
              const p = await pRes.json()
              return { key: t.key, label: t.label || t.key, lastMessage: p.lastMessage, agentStatus: p.agentStatus }
            }
          } catch { /* ignore */ }
          return { key: t.key, label: t.label || t.key, lastMessage: null, agentStatus: t.agentStatus ?? 'idle' }
        })
      )
      setPreviews(results)
    } catch { /* ignore */ } finally {
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
    } catch { /* ignore */ }
  }

  const handleClick = (threadKey: string) => {
    setActiveWorkspace(props.orgId, props.orgName)
    setActiveView('workspace')
    switchThread(threadKey)
  }

  const isActive = (status: string) => status === 'busy' || status === 'streaming' || status === 'thinking'

  return (
    <Show when={!loading() && (previews().length > 0 || true)}>
      <div
        class="mt-1 flex gap-2 overflow-x-auto pb-1"
        style={{ 'scroll-snap-type': 'x mandatory' }}
      >
        {/* New thread button */}
        <button
          class="flex h-16 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border transition-colors hover:brightness-125"
          style={{
            background: 'var(--c-bg-raised)',
            'border-color': 'var(--c-border)',
            color: 'var(--c-text)',
            'scroll-snap-align': 'start'
          }}
          onClick={handleCreate}
          title="New thread"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>

        <For each={previews()}>
          {(p) => (
            <button
              class="flex h-16 shrink-0 cursor-pointer flex-col justify-center rounded-lg border px-2.5 py-1.5 text-left transition-colors hover:brightness-110"
              style={{
                background: 'var(--c-bg-raised)',
                'border-color': 'var(--c-border)',
                'min-width': '200px',
                'max-width': '220px',
                'scroll-snap-align': 'start'
              }}
              onClick={() => handleClick(p.key)}
            >
              <div class="flex w-full items-center gap-1.5">
                <Show when={isActive(p.agentStatus)}>
                  <span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-green-500" />
                </Show>
                <span
                  class="truncate text-xs font-medium"
                  style={{ color: 'var(--c-text-heading)' }}
                >
                  {p.label}
                </span>
              </div>
              <div class="mt-0.5 w-full truncate text-[11px] opacity-60" style={{ color: 'var(--c-text)' }}>
                {isActive(p.agentStatus)
                  ? (
                    <span>
                      {p.lastMessage ? (p.lastMessage.length > 80 ? p.lastMessage.slice(0, 80) : p.lastMessage) : ''}
                      <span class="inline-block animate-pulse">...</span>
                    </span>
                  )
                  : (p.lastMessage
                    ? (p.lastMessage.length > 80 ? p.lastMessage.slice(0, 80) + '...' : p.lastMessage)
                    : 'No messages yet'
                  )
                }
              </div>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

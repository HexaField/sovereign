// Thread card previews — shows last few messages with typed styling and activity indicators
import { createSignal, onMount, For, Show, Switch, Match } from 'solid-js'
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

interface ThreadCard {
  key: string
  label: string
  messages: PreviewEntry[]
  agentStatus: string
  lastActivity: number | null
}

const TOOL_ICONS: Record<string, string> = {
  exec: '⚙',
  read: '📄',
  edit: '✏️',
  write: '📝',
  browser: '🌐',
  web_fetch: '🌐',
  image_generate: '🖼',
  tts: '🔊',
  ollama_web_search: '🔍'
}

function toolIcon(name: string): string {
  // Match by prefix for namespaced tools like ad4m_*
  if (name.startsWith('ad4m_')) return '🔗'
  return TOOL_ICONS[name] || '⚙'
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function MessageLine(props: { entry: PreviewEntry }) {
  return (
    <Switch>
      <Match when={props.entry.type === 'user'}>
        <div class="truncate text-[11px] leading-[16px]" style={{ color: 'var(--c-text)' }}>
          {props.entry.text}
        </div>
      </Match>
      <Match when={props.entry.type === 'assistant'}>
        <div class="truncate text-[11px] leading-[16px]" style={{ color: 'var(--c-text)', opacity: '0.75' }}>
          {props.entry.text}
        </div>
      </Match>
      <Match when={props.entry.type === 'thinking'}>
        <div
          class="truncate text-[11px] leading-[16px] italic"
          style={{ color: 'var(--c-text-muted)', opacity: '0.6' }}
        >
          {props.entry.text}
        </div>
      </Match>
      <Match when={props.entry.type === 'tool_call'}>
        <div class="truncate text-[11px] leading-[16px]" style={{ color: 'var(--c-text-muted)' }}>
          {toolIcon(props.entry.text)} {props.entry.text}
        </div>
      </Match>
      <Match when={props.entry.type === 'tool_result'}>
        <div class="truncate text-[11px] leading-[16px]" style={{ color: 'var(--c-text-muted)', opacity: '0.6' }}>
          ✓ {props.entry.text}
        </div>
      </Match>
    </Switch>
  )
}

export default function ThreadPreviews(props: { orgId: string; orgName: string }) {
  const [cards, setCards] = createSignal<ThreadCard[]>([])
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    try {
      const res = await fetch(`/api/threads?orgId=${encodeURIComponent(props.orgId)}`)
      if (!res.ok) return
      const data = await res.json()
      const threads: ThreadInfo[] = (data.threads ?? []).slice(0, 6)

      const results = await Promise.all(
        threads.map(async (t) => {
          let messages: PreviewEntry[] = []
          let agentStatus = t.agentStatus ?? 'idle'
          try {
            const pRes = await fetch(`/api/threads/${encodeURIComponent(t.key)}/preview-messages?limit=5`)
            if (pRes.ok) {
              const p = await pRes.json()
              messages = p.messages ?? []
              agentStatus = p.agentStatus ?? agentStatus
            }
          } catch {
            /* ignore */
          }
          return { key: t.key, label: t.label || t.key, messages, agentStatus, lastActivity: t.lastActivity }
        })
      )
      setCards(results)
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

  const isActive = (status: string) => status === 'busy' || status === 'streaming' || status === 'thinking'

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
        <For each={cards().slice(0, 3)}>
          {(card) => (
            <button
              class="flex w-[260px] shrink-0 cursor-pointer flex-col rounded-lg border p-2.5 text-left transition-colors hover:brightness-110 md:w-auto md:shrink"
              style={{
                background: 'var(--c-bg-raised)',
                'border-color': 'var(--c-border)',
                'min-height': '120px'
              }}
              onClick={(e: MouseEvent) => {
                if (e.metaKey || e.ctrlKey) {
                  // Cmd/Ctrl+click: open in new tab
                  const url = new URL(window.location.href)
                  url.hash = `thread=${card.key}`
                  url.searchParams.set('view', 'workspace')
                  window.open(url.toString(), '_blank')
                } else {
                  handleClick(card.key)
                }
              }}
            >
              {/* Header: name + status dot + time */}
              <div class="mb-1.5 flex w-full items-center gap-1.5">
                <span
                  class={`inline-block h-2 w-2 shrink-0 rounded-full ${isActive(card.agentStatus) ? "status-dot-active bg-green-500" : ''}`}
                  style={!isActive(card.agentStatus) ? { background: 'var(--c-text-muted)', opacity: '0.4' } : {}}
                />
                <span class="flex-1 truncate text-xs font-medium" style={{ color: 'var(--c-text)' }}>
                  {card.label}
                </span>
                <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                  {formatRelativeTime(card.lastActivity)}
                </span>
              </div>

              {/* Message preview lines */}
              <div class="flex flex-1 flex-col gap-0.5 overflow-hidden">
                <Show
                  when={card.messages.length > 0}
                  fallback={
                    <div class="text-[11px]" style={{ color: 'var(--c-text-muted)', opacity: '0.5' }}>
                      No messages yet
                    </div>
                  }
                >
                  <For each={card.messages}>{(entry) => <MessageLine entry={entry} />}</For>
                </Show>
              </div>
            </button>
          )}
        </For>

        {/* New thread button */}
        <button
          class="flex cursor-pointer items-center justify-center rounded-lg border transition-colors hover:brightness-125"
          style={{
            background: 'var(--c-bg-raised)',
            'border-color': 'var(--c-border)',
            color: 'var(--c-text-muted)',
            'min-height': '120px'
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

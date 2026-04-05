import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js'
import type { ParsedTurn, WorkItem } from '@sovereign/core'
import { SplitIcon } from '../../ui/icons.js'
import { renderMarkdown } from '../../lib/markdown.js'
import { switchThread } from '../threads/store.js'

export interface SubagentInfo {
  sessionKey: string
  label: string
  task: string
  status: 'idle' | 'working' | 'completed' | 'failed' | string
  lastActivity?: number
  lastMessage?: string
}

export interface SubagentCardProps {
  sessionKey: string
  task: string
  onView: (sessionKey: string, label: string) => void
}

export function SubagentCard(props: SubagentCardProps) {
  const [expanded, setExpanded] = createSignal(false)
  const [history, setHistory] = createSignal<ParsedTurn[]>([])
  const [loading, setLoading] = createSignal(false)
  const [status, setStatus] = createSignal<string>('idle')

  let refreshTimer: ReturnType<typeof setInterval> | undefined

  const fetchHistory = async () => {
    try {
      if (!expanded()) return
      setLoading(true)
      const res = await fetch(`/api/threads/${encodeURIComponent(props.sessionKey)}/history`)
      if (res.ok) {
        const data = await res.json()
        const turns: ParsedTurn[] = data.turns ?? data.history ?? []
        setHistory(turns)

        // Derive status from history
        const lastTurn = turns[turns.length - 1]
        const hasActiveTool = turns.some(
          (t) => t.role === 'assistant' && t.workItems?.some((w: WorkItem) => w.type === 'tool_call')
        )
        const isComplete =
          lastTurn?.role === 'assistant' && lastTurn?.content && !lastTurn?.pending && !lastTurn?.streaming
        setStatus(
          lastTurn?.streaming || lastTurn?.pending
            ? 'working'
            : isComplete
              ? 'completed'
              : hasActiveTool
                ? 'working'
                : 'idle'
        )
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    if (expanded()) {
      fetchHistory()
      // Auto-refresh every 5s while not completed
      refreshTimer = setInterval(() => {
        const s = status()
        if (s === 'completed' || s === 'failed') {
          if (refreshTimer) {
            clearInterval(refreshTimer)
            refreshTimer = undefined
          }
          // One final fetch
          fetchHistory()
          return
        }
        fetchHistory()
      }, 5000)
    } else {
      if (refreshTimer) {
        clearInterval(refreshTimer)
        refreshTimer = undefined
      }
    }
  })

  onCleanup(() => {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = undefined
    }
  })

  const statusColor = () => {
    const s = status()
    if (s === 'completed') return '#4ade80'
    if (s === 'failed') return '#ef4444'
    if (s === 'working') return 'var(--c-accent)'
    return 'var(--c-text-muted)'
  }

  const statusLabel = () => {
    const s = status()
    if (s === 'completed') return 'Completed'
    if (s === 'failed') return 'Failed'
    if (s === 'working') return 'Running'
    return 'Idle'
  }

  const taskLabel = () => {
    const t = props.task
    if (!t) return 'Subagent'
    return t.length > 120 ? t.slice(0, 120) + '…' : t
  }

  const lastMessage = () => {
    if (expanded()) return ''
    const turns = history()
    const last = [...turns].reverse().find((t) => t.role === 'assistant' && t.content)
    return last?.content?.slice(0, 120) || ''
  }

  // Status preview fetch removed — only fetch when expanded to avoid N requests on mount

  const openInThread = () => {
    switchThread(props.sessionKey)
  }

  return (
    <div
      class="my-2 max-w-[85%] self-start rounded-xl"
      style={{
        background: 'var(--c-bg-raised)',
        border: '1px solid color-mix(in srgb, var(--c-accent) 30%, var(--c-border))'
      }}
    >
      {/* Header — clickable to expand/collapse */}
      <button
        class="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-2 text-left transition-colors"
        style={{
          'border-bottom': expanded() ? '1px solid var(--c-border)' : 'none',
          color: 'var(--c-text)'
        }}
        onClick={() => setExpanded(!expanded())}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <SplitIcon class="h-4 w-4 shrink-0" />
        <span class="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          {taskLabel()}
        </span>
        <span class="flex shrink-0 items-center gap-1 text-[10px]" style={{ color: statusColor() }}>
          <span
            class="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: statusColor(),
              animation: status() === 'working' ? 'pulse 2s infinite' : 'none'
            }}
          />
          {statusLabel()}
        </span>
        <span
          class="shrink-0 text-[10px] transition-transform"
          style={{
            color: 'var(--c-text-muted)',
            transform: expanded() ? 'rotate(90deg)' : 'rotate(0deg)'
          }}
        >
          ▶
        </span>
      </button>

      {/* Collapsed preview */}
      <Show when={!expanded() && lastMessage()}>
        <div
          class="cursor-pointer px-3 py-1.5 text-[11px] leading-relaxed"
          style={{
            color: 'var(--c-text-muted)',
            display: '-webkit-box',
            '-webkit-box-orient': 'vertical',
            '-webkit-line-clamp': '2',
            overflow: 'hidden'
          }}
          onClick={() => setExpanded(true)}
        >
          {lastMessage()}
        </div>
      </Show>

      {/* Expanded body */}
      <Show when={expanded()}>
        <div style={{ 'max-height': '400px', 'overflow-y': 'auto' }}>
          {/* Toolbar */}
          <div
            class="flex items-center justify-between px-3 py-1.5"
            style={{ 'border-bottom': '1px solid var(--c-border)' }}
          >
            <button
              class="cursor-pointer rounded-md border-none bg-transparent px-2 py-1 text-[11px] font-medium transition-colors"
              style={{ color: 'var(--c-accent)' }}
              onClick={openInThread}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              Open in thread ↗
            </button>
            <Show when={loading()}>
              <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                refreshing…
              </span>
            </Show>
          </div>

          {/* Messages */}
          <div class="flex flex-col gap-1 px-3 py-2">
            <Show when={history().length === 0 && loading()}>
              <div class="py-4 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
                Loading…
              </div>
            </Show>

            <Show when={history().length === 0 && !loading()}>
              <div class="py-4 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
                No messages yet
              </div>
            </Show>

            <For each={history()}>
              {(turn) => (
                <div class="flex flex-col gap-0.5">
                  {/* Tool calls summary */}
                  <Show when={(turn.workItems?.filter((w: WorkItem) => w.type === 'tool_call')?.length ?? 0) > 0}>
                    <div class="flex flex-wrap gap-1 py-0.5">
                      <For each={turn.workItems?.filter((w: WorkItem) => w.type === 'tool_call') ?? []}>
                        {(w) => (
                          <span
                            class="rounded-full px-1.5 py-0.5 text-[10px]"
                            style={{
                              background: 'var(--c-hover-bg)',
                              color: 'var(--c-text-muted)'
                            }}
                          >
                            ⚙ {w.name}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Message content */}
                  <Show when={turn.content?.trim()}>
                    <div
                      class="rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed"
                      style={{
                        background: turn.role === 'user' ? 'var(--c-accent)' : 'transparent',
                        color: turn.role === 'user' ? '#fff' : 'var(--c-text)',
                        'align-self': turn.role === 'user' ? 'flex-end' : 'flex-start',
                        'max-width': '95%'
                      }}
                      innerHTML={turn.role === 'assistant' ? renderMarkdown(turn.content!) : undefined}
                    >
                      {turn.role === 'user' ? turn.content : undefined}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

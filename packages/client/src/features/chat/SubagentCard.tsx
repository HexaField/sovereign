import { createSignal, createEffect, onCleanup, Show } from 'solid-js'
import type { ParsedTurn } from '@sovereign/core'
import { SplitIcon } from '../../ui/icons.js'

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
  const [info, setInfo] = createSignal<SubagentInfo | null>(null)
  const [loading, setLoading] = createSignal(true)

  // Poll for subagent status
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const fetchInfo = async () => {
    try {
      // Fetch history to get last message preview
      const histRes = await fetch(`/api/threads/${encodeURIComponent(props.sessionKey)}/history`)
      if (histRes.ok) {
        const data = await histRes.json()
        const history: ParsedTurn[] = data.history ?? []
        const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant' && t.content)
        const lastMessage = lastAssistant?.content?.slice(0, 120) || ''

        // Determine status from history
        const hasWork = history.some(
          (t) => t.role === 'assistant' && t.workItems?.some((w) => w.type === 'tool_call')
        )
        const lastTurn = history[history.length - 1]
        const isComplete =
          lastTurn?.role === 'assistant' && lastTurn?.content && !lastTurn?.workItems?.length
        const status = isComplete ? 'completed' : hasWork ? 'working' : 'idle'

        setInfo({
          sessionKey: props.sessionKey,
          label: props.task || 'Subagent',
          task: props.task,
          status,
          lastMessage,
          lastActivity: lastTurn?.timestamp
        })
      }
    } catch {
      // ignore fetch errors
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    fetchInfo()
    // Poll every 10s but only while not completed/failed
    pollTimer = setInterval(() => {
      const s = info()?.status
      if (s === 'completed' || s === 'failed') {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        return
      }
      fetchInfo()
    }, 10000)
  })

  onCleanup(() => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  })

  const statusColor = () => {
    const s = info()?.status
    if (s === 'completed') return '#4ade80'
    if (s === 'failed') return '#ef4444'
    if (s === 'working') return 'var(--c-accent)'
    return 'var(--c-text-muted)'
  }

  const statusLabel = () => {
    const s = info()?.status
    if (s === 'completed') return 'Completed'
    if (s === 'failed') return 'Failed'
    if (s === 'working') return 'Running'
    return 'Idle'
  }

  const taskLabel = () => {
    const t = props.task
    if (!t) return 'Subagent'
    // Truncate long task descriptions
    return t.length > 80 ? t.slice(0, 80) + '…' : t
  }

  return (
    <div
      class="my-2 max-w-[85%] self-start overflow-hidden rounded-xl"
      style={{
        background: 'var(--c-bg-raised)',
        border: '1px solid color-mix(in srgb, var(--c-accent) 30%, var(--c-border))'
      }}
    >
      {/* Header */}
      <div
        class="flex items-center gap-2 px-3 py-2"
        style={{ 'border-bottom': '1px solid var(--c-border)' }}
      >
        <SplitIcon class="h-4 w-4 shrink-0" />
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Subagent
        </span>
        <span class="flex items-center gap-1 text-[10px]" style={{ color: statusColor() }}>
          <span
            class="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: statusColor(),
              animation: info()?.status === 'working' ? 'pulse 2s infinite' : 'none'
            }}
          />
          {statusLabel()}
        </span>
      </div>

      {/* Body */}
      <div class="px-3 py-2">
        <div
          class="mb-1.5 text-xs leading-relaxed"
          style={{ color: 'var(--c-text)' }}
        >
          {taskLabel()}
        </div>

        <Show when={info()?.lastMessage}>
          <div
            class="mb-2 text-[11px] leading-relaxed"
            style={{
              color: 'var(--c-text-muted)',
              display: '-webkit-box',
              '-webkit-box-orient': 'vertical',
              '-webkit-line-clamp': '2',
              overflow: 'hidden'
            }}
          >
            {info()!.lastMessage}
          </div>
        </Show>

        <Show when={loading()}>
          <div class="mb-2 text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
            Loading…
          </div>
        </Show>

        <button
          class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
          style={{
            background: 'var(--c-accent)',
            color: 'var(--c-text)',
            opacity: loading() ? '0.5' : '1'
          }}
          onClick={() => props.onView(props.sessionKey, taskLabel())}
          disabled={loading()}
        >
          View →
        </button>
      </div>
    </div>
  )
}

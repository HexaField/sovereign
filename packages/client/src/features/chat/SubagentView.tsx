import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js'
import type { ParsedTurn } from '@sovereign/core'
import type { ChatMessage } from './types.js'
import { ChatView } from './ChatView.js'
import { ChevronDownIcon } from '../../ui/icons.js'

export interface SubagentNavEntry {
  sessionKey: string
  label: string
}

export interface SubagentViewProps {
  /** Stack of subagent sessions being viewed (deepest = current) */
  navStack: SubagentNavEntry[]
  /** Parent thread label */
  parentLabel: string
  /** Called when back button is clicked */
  onBack: () => void
  /** Called when a breadcrumb entry is clicked */
  onNavigateTo: (depth: number) => void
  /** Called when a nested subagent is viewed */
  onViewSubagent: (sessionKey: string, label: string) => void
}

export function SubagentView(props: SubagentViewProps) {
  const [turns, setTurns] = createSignal<ParsedTurn[]>([])
  const [loading, setLoading] = createSignal(true)

  const currentEntry = () => props.navStack[props.navStack.length - 1]

  let pollTimer: ReturnType<typeof setInterval> | null = null

  const fetchHistory = async () => {
    const entry = currentEntry()
    if (!entry) return
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(entry.sessionKey)}/history`)
      if (res.ok) {
        const data = await res.json()
        setTurns(data.history ?? [])
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    // Re-fetch when nav stack changes
    const _entry = currentEntry()
    setLoading(true)
    setTurns([])
    fetchHistory()

    // Poll every 3s for live updates
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(fetchHistory, 3000)
  })

  onCleanup(() => {
    if (pollTimer) clearInterval(pollTimer)
  })

  const messages = (): ChatMessage[] =>
    turns().map((t) => ({
      turn: t,
      pending: false
    }))

  // Build breadcrumb trail
  const breadcrumbs = (): Array<{ label: string; depth: number }> => {
    const crumbs: Array<{ label: string; depth: number }> = [
      { label: props.parentLabel, depth: -1 }
    ]
    for (let i = 0; i < props.navStack.length; i++) {
      const entry = props.navStack[i]
      const label = entry.label.length > 30 ? entry.label.slice(0, 30) + '…' : entry.label
      crumbs.push({ label, depth: i })
    }
    return crumbs
  }

  return (
    <div class="flex h-full flex-col">
      {/* Breadcrumb / back bar */}
      <div
        class="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-1.5"
        style={{
          'border-color': 'var(--c-border)',
          background: 'color-mix(in srgb, var(--c-accent) 5%, var(--c-bg-raised))'
        }}
      >
        <button
          class="shrink-0 rounded px-2 py-1 text-xs transition-colors"
          style={{ color: 'var(--c-accent)' }}
          onClick={props.onBack}
        >
          ←
        </button>
        <For each={breadcrumbs()}>
          {(crumb, i) => (
            <>
              <Show when={i() > 0}>
                <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>›</span>
              </Show>
              <button
                class="shrink-0 truncate rounded px-1.5 py-0.5 text-[11px] transition-colors"
                style={{
                  color: i() === breadcrumbs().length - 1 ? 'var(--c-text)' : 'var(--c-text-muted)',
                  'font-weight': i() === breadcrumbs().length - 1 ? '500' : '400',
                  'max-width': '150px'
                }}
                onClick={() => {
                  if (crumb.depth === -1) {
                    // Navigate all the way back to parent
                    props.onNavigateTo(-1)
                  } else {
                    props.onNavigateTo(crumb.depth)
                  }
                }}
                title={crumb.label}
              >
                {crumb.label}
              </button>
            </>
          )}
        </For>
      </div>

      {/* Loading state */}
      <Show when={loading() && turns().length === 0}>
        <div class="flex flex-1 items-center justify-center">
          <span class="text-sm" style={{ color: 'var(--c-text-muted)' }}>Loading subagent history…</span>
        </div>
      </Show>

      {/* Chat view (read-only, no input area) */}
      <Show when={turns().length > 0 || !loading()}>
        <ChatView
          messages={messages()}
          streamingHtml=""
          agentStatus="idle"
          liveWork={[]}
          liveThinkingText=""
          compacting={false}
          isRetryCountdownActive={false}
          retryCountdownSeconds={0}
          onSend={() => {}}
          onAbort={() => {}}
          threadKey={currentEntry()?.sessionKey ?? ''}
          onViewSubagent={props.onViewSubagent}
        />
      </Show>
    </div>
  )
}

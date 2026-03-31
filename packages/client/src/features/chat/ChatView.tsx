import { createEffect, createMemo, For, Show } from 'solid-js'
import type { WorkItem, AgentStatus } from '@sovereign/core'
import type { ChatMessage } from './types.js'
import { MessageBubble } from './MessageBubble.js'
import { WorkSection } from './WorkSection.js'
import { SubagentCard } from './SubagentCard.js'
import {
  hasOlderMessages,
  loadingOlder,
  loadOlderMessages,
  streamingText,
  streamingHtml,
  liveWork,
  liveThinkingText
} from './store.js'
import { ChatIcon } from '../../ui/icons.js'
import { renderMarkdown } from '../../lib/markdown.js'

export interface ChatViewProps {
  messages: ChatMessage[]
  streamingHtml: string
  agentStatus: AgentStatus
  liveWork: WorkItem[]
  liveThinkingText: string
  compacting: boolean
  isRetryCountdownActive: boolean
  retryCountdownSeconds: number
  onSend: (text: string, attachments?: File[]) => void
  onAbort: () => void
  threadKey: string
  onViewSubagent?: (sessionKey: string, label: string) => void
}

/** Extract subagent spawns from a turn's work items */
function extractSubagentSpawns(workItems: WorkItem[]): Array<{ sessionKey: string; task: string }> {
  const spawns: Array<{ sessionKey: string; task: string }> = []
  for (const w of workItems) {
    if (w.type === 'tool_call' && w.name === 'sessions_spawn') {
      // Parse the task from input
      let task = ''
      try {
        const inp = typeof w.input === 'string' ? JSON.parse(w.input) : w.input
        task = inp?.task || inp?.message || ''
      } catch {
        /* ignore */
      }

      // Find corresponding result by toolCallId
      const result = workItems.find((r) => r.type === 'tool_result' && r.toolCallId === w.toolCallId)
      if (result?.output) {
        try {
          const out = typeof result.output === 'string' ? JSON.parse(result.output) : result.output
          const sessionKey = out?.childSessionKey || out?.sessionKey || out?.key || ''
          if (sessionKey) {
            spawns.push({ sessionKey, task: task.slice(0, 200) })
          }
        } catch {
          // Try regex fallback for non-JSON output
          const match = result.output.match(/(?:childSessionKey|sessionKey)['":\s]+['"]([^'"]+)['"]/)
          if (match) {
            spawns.push({ sessionKey: match[1], task: task.slice(0, 200) })
          }
        }
      }
    }
  }
  return spawns
}

/** Check if two timestamps fall on different days */
export function needsDateSeparator(ts1: number, ts2: number): boolean {
  if (!ts1 || !ts2) return false
  const d1 = new Date(ts1)
  const d2 = new Date(ts2)
  return d1.toDateString() !== d2.toDateString()
}

/** Format a date for the separator label */
export function formatDateSeparator(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

/** Determine if messages list is empty (for welcome state) */
export function isEmptyState(messages: ChatMessage[]): boolean {
  return messages.length === 0
}

/** Scroll threshold in px - if within this distance from bottom, auto-scroll is active */
export const SCROLL_THRESHOLD = 80

/** Check if a scroll container is near the bottom */
export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD
}

export function ChatView(props: ChatViewProps) {
  let scrollRef!: HTMLDivElement

  const scrollToBottom = () => {
    if (scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight
    }
  }

  // Auto-scroll when messages or live state changes
  createEffect(() => {
    props.messages.length
    const last = props.messages[props.messages.length - 1]
    if (last) {
      last.turn.content
      last.turn.workItems?.length
    }
    // Also track live state for scrolling
    liveWork().length
    streamingText()
    requestAnimationFrame(scrollToBottom)
  })

  return (
    <div class="flex min-h-0 flex-1 flex-col" style={{ background: 'var(--c-bg)' }}>
      {/* Message list */}
      <div ref={scrollRef} class="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
        {/* Load older messages */}
        {hasOlderMessages() && (
          <div class="flex items-center justify-center">
            <button
              class="rounded-md border border-white/10 px-3 py-1 text-xs hover:bg-white/5"
              onClick={loadOlderMessages}
              disabled={loadingOlder()}
              style={{ color: 'var(--c-text-muted)' }}
            >
              {loadingOlder() ? 'Loading older messages…' : 'Load older messages'}
            </button>
          </div>
        )}

        {/* Empty state */}
        {isEmptyState(props.messages) && (
          <div class="flex h-full items-center justify-center">
            <div class="text-center" style={{ color: 'var(--c-text-muted)' }}>
              <ChatIcon class="h-8 w-8" />
              <div class="mt-2 text-sm">Start a conversation</div>
            </div>
          </div>
        )}

        {/* Message list with date separators */}
        <For each={props.messages}>
          {(msg, i) => {
            const showSeparator = () =>
              i() === 0 || needsDateSeparator(props.messages[i() - 1]?.turn.timestamp, msg.turn.timestamp)

            return (
              <>
                {/* Date separator */}
                {showSeparator() && (
                  <div class="flex items-center gap-2 py-2">
                    <div class="flex-1 border-t" style={{ 'border-color': 'var(--c-border)' }} />
                    <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      {formatDateSeparator(msg.turn.timestamp)}
                    </span>
                    <div class="flex-1 border-t" style={{ 'border-color': 'var(--c-border)' }} />
                  </div>
                )}

                {/* Work section between user and assistant turns */}
                {(msg.turn.workItems?.length ?? 0) > 0 && <WorkSection work={msg.turn.workItems} />}

                {/* Message bubble — skip for assistant turns with empty content */}
                {(msg.turn.content?.trim() || msg.turn.role !== 'assistant') && (
                  <MessageBubble turn={msg.turn} pending={msg.pending} />
                )}

                {/* Subagent cards for sessions_spawn tool calls */}
                {extractSubagentSpawns(msg.turn.workItems || []).map((spawn) => (
                  <SubagentCard
                    sessionKey={spawn.sessionKey}
                    task={spawn.task}
                    onView={(key, label) => props.onViewSubagent?.(key, label)}
                  />
                ))}
              </>
            )
          }}
        </For>

        {/* ── Live streaming section (independent of history turns) ── */}
        <Show when={liveWork().length > 0}>
          <WorkSection work={liveWork()} />
        </Show>

        {/* Live thinking — always show latest thought below tool calls when agent is active */}
        <Show when={props.agentStatus !== 'idle' && liveWork().length > 0}>
          <div class="flex items-start gap-2 px-2 py-1.5" style={{ color: 'var(--c-text-muted)' }}>
            <span class="thinking-dots mt-0.5 text-xs">⋯</span>
            <span
              class="text-xs leading-relaxed italic"
              style={{ opacity: '0.7', 'max-width': '90%', 'word-break': 'break-word' }}
            >
              {liveThinkingText() || 'Thinking…'}
            </span>
          </div>
        </Show>

        <Show when={streamingHtml()}>
          <div class="flex w-full justify-start">
            <div
              class="msg-assistant streaming-dots max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed break-words"
              style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)', opacity: '0.7' }}
              innerHTML={streamingHtml()}
            />
          </div>
        </Show>
      </div>

      {/* Compaction indicator */}
      {props.compacting && (
        <div class="px-4 py-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
          Compacting context…
        </div>
      )}

      {/* Retry countdown */}
      {props.isRetryCountdownActive && (
        <div class="px-4 py-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
          Retrying in {props.retryCountdownSeconds}s…
          <div
            class="mt-1 h-1 rounded-full"
            style={{
              background: 'var(--c-accent)',
              width: `${(props.retryCountdownSeconds / 60) * 100}%`,
              transition: 'width 1s linear'
            }}
          />
        </div>
      )}
    </div>
  )
}

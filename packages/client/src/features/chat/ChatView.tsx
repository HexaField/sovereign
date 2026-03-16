import { createEffect, createMemo } from 'solid-js'
import type { WorkItem, AgentStatus } from '@sovereign/core'
import type { ChatMessage } from './types.js'
import { MessageBubble } from './MessageBubble.js'
import { WorkSection } from './WorkSection.js'
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
}

/** Check if two timestamps fall on different days */
export function needsDateSeparator(ts1: number, ts2: number): boolean {
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

  // Auto-scroll when messages change or streaming updates
  createEffect(() => {
    // Track reactive dependencies
    props.messages.length
    props.streamingHtml
    // Schedule scroll after DOM update
    requestAnimationFrame(scrollToBottom)
  })

  // When agent is mid-run (last turn has work but no final reply), show the last
  // thinking block from history as a streaming-like bubble so there's visible progress
  // on refresh or for subagent threads that don't get real streaming events.
  const lastThoughtHtml = createMemo(() => {
    if (props.streamingHtml) return null // real streaming takes priority
    const msgs = props.messages
    if (msgs.length === 0) return null
    const last = msgs[msgs.length - 1]
    if (last.turn.role !== 'assistant' || !last.turn.workItems?.length) return null
    // If the turn has content, it's complete
    if (last.turn.content) return null
    // Find last thinking block
    for (let i = last.turn.workItems.length - 1; i >= 0; i--) {
      const w = last.turn.workItems[i]
      if (w.type === 'thinking' && (w.output || w.input)) {
        const text = w.output || w.input || ''
        const tail = text.length > 500 ? '…' + text.substring(text.length - 500) : text
        return renderMarkdown(tail)
      }
    }
    return null
  })

  // Live work: show only recent activity, not full turn history
  const recentLiveWork = createMemo(() => {
    const all = props.liveWork
    if (all.length <= 6) return all
    return all.slice(-6)
  })

  const hiddenStepCount = createMemo(() => {
    return Math.max(0, props.liveWork.length - recentLiveWork().length)
  })

  const liveWorkStepLabel = createMemo(() => {
    const calls = props.liveWork.filter((w) => w.type === 'tool_call').length
    if (calls > 0) return `${calls} tool call${calls !== 1 ? 's' : ''}`
    return 'thinking…'
  })

  return (
    <div class="flex min-h-0 flex-1 flex-col" style={{ background: 'var(--c-bg)' }}>
      {/* Message list */}
      <div ref={scrollRef} class="flex-1 space-y-4 overflow-y-auto p-4">
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
        {props.messages.map((msg, i) => {
          const showSeparator = i === 0 || needsDateSeparator(props.messages[i - 1].turn.timestamp, msg.turn.timestamp)

          return (
            <>
              {/* Date separator */}
              {showSeparator && (
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

              {/* Message bubble */}
              <MessageBubble turn={msg.turn} pending={msg.pending} />
            </>
          )
        })}

        {/* Live work section for in-progress turn — shows only recent activity */}
        {props.liveWork.length > 0 && (
          <div class="my-0.5 max-w-[85%] self-start">
            <div
              class="flex w-fit cursor-pointer items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-xs select-none"
              style={{
                background: 'var(--c-step-bg)',
                border: '1px solid var(--c-border)',
                color: 'var(--c-text-muted)'
              }}
            >
              <span class="flex items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {liveWorkStepLabel()}
              </span>
              <span
                class="shrink-0 rounded-md px-1.5 py-px text-[10px]"
                style={{ background: 'var(--c-step-badge-bg)' }}
              >
                {liveWorkStepLabel()}
              </span>
            </div>
            <div class="mt-1.5 overflow-hidden rounded-[10px]" style={{ border: '1px solid var(--c-border)' }}>
              {hiddenStepCount() > 0 && (
                <div
                  class="py-1 text-center text-xs opacity-50"
                  style={{ 'border-bottom': '1px solid var(--c-border)' }}
                >
                  … {hiddenStepCount()} earlier steps
                </div>
              )}
              {recentLiveWork().map((w) => (
                <div
                  class="px-3 py-1.5 text-xs last:border-b-0"
                  style={{
                    background: 'var(--c-work-body-bg)',
                    'border-bottom': '1px solid var(--c-border)',
                    color: 'var(--c-text-muted)'
                  }}
                >
                  {w.type === 'tool_call' && (
                    <span class="font-mono text-[11px]">
                      <span style={{ color: 'var(--c-text)' }}>{w.name}</span>
                    </span>
                  )}
                  {w.type === 'tool_result' && <span class="font-mono text-[11px]">✓ {w.name}</span>}
                  {w.type === 'thinking' && <span class="italic">{(w.output || w.input || '').slice(0, 60)}…</span>}
                  {w.type === 'system_event' && <span>{(w.output || '').slice(0, 80)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Last thought from history — shown when agent is mid-run but no live stream */}
        {lastThoughtHtml() && !props.streamingHtml && (
          <div
            class="msg-assistant streaming-dots max-w-[85%] self-start rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed break-words"
            style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)', opacity: '0.7' }}
          >
            <div innerHTML={lastThoughtHtml()!} />
          </div>
        )}

        {/* Streaming response — three-dot indicator, not shown for subagent threads */}
        {props.streamingHtml && (
          <>
            {/* Show live work alongside streaming if both active */}
            {props.liveWork.length > 0 && recentLiveWork().length === 0 && <WorkSection work={props.liveWork} />}
            <div
              class="msg-assistant streaming-dots max-w-[85%] self-start rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed break-words"
              style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
            >
              <div innerHTML={props.streamingHtml} />
            </div>
          </>
        )}
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

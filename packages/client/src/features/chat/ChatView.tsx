import { createEffect } from 'solid-js'
import type { WorkItem, AgentStatus } from '@sovereign/core'
import type { ChatMessage } from './types.js'
import { MessageBubble } from './MessageBubble.js'
import { WorkSection } from './WorkSection.js'
import { ChatIcon } from '../../ui/icons.js'

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

        {/* Live work section for in-progress turn */}
        {props.liveWork.length > 0 && <WorkSection work={props.liveWork} />}
      </div>

      {/* Streaming response */}
      {props.streamingHtml && (
        <div class="px-4 py-2">
          <div
            class="msg-assistant rounded-xl px-3 py-2"
            style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
          >
            <div
              class="prose prose-sm text-sm leading-relaxed break-words"
              style={{ color: 'var(--c-text)' }}
              innerHTML={props.streamingHtml}
            />
            <span class="inline-block animate-pulse text-sm" style={{ color: 'var(--c-text-muted)' }}>
              ▍
            </span>
          </div>
        </div>
      )}

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

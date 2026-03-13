import type { ParsedTurn, ForwardedMessage } from '@template/core'
import { MarkdownContent } from './MarkdownContent.js'

export interface MessageBubbleProps {
  turn: ParsedTurn
  pending?: boolean
  forwarded?: ForwardedMessage
  onCopyText?: (text: string) => void
  onCopyMarkdown?: (md: string) => void
  onExportPdf?: (turn: ParsedTurn) => void
  onForward?: (turn: ParsedTurn) => void
  onRetry?: (turn: ParsedTurn) => void
}

/** Format a timestamp for display */
export function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const time = date.toLocaleTimeString('en-US', { hour12: false })
  if (isToday) return `Today at ${time}`
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ` at ${time}`
}

export function MessageBubble(props: MessageBubbleProps) {
  const { turn } = props
  const isUser = turn.role === 'user'
  const isSystem = turn.role === 'system'
  const isAssistant = turn.role === 'assistant'

  return (
    <div
      class={`group relative ${isUser ? "flex justify-end" : "flex justify-start"} ${props.pending ? 'opacity-50' : ''}`}
    >
      <div
        class={`max-w-[80%] rounded-lg px-4 py-2 ${isUser ? 'rounded-br-sm' : 'w-full'}`}
        style={{
          background: isUser ? 'var(--c-user-bubble)' : 'transparent',
          color: isUser ? 'var(--c-user-bubble-text)' : isSystem ? 'var(--c-text-muted)' : 'var(--c-text)',
          'font-size': isSystem ? '0.85rem' : undefined
        }}
      >
        {/* Forwarded header */}
        {props.forwarded && (
          <div
            class="mb-1 border-l-2 pl-2 text-xs"
            style={{ 'border-color': 'var(--c-accent)', color: 'var(--c-text-muted)' }}
          >
            Forwarded from {props.forwarded.sourceThreadLabel}
            {' · '}
            {formatTimestamp(props.forwarded.originalTimestamp)}
          </div>
        )}

        {/* Content: markdown for assistant, plain text for user/system */}
        {isAssistant ? <MarkdownContent html={turn.content} /> : <div>{turn.content}</div>}

        {/* Pending indicator */}
        {props.pending && (
          <span class="ml-2 inline-block animate-pulse text-xs" style={{ color: 'var(--c-text-muted)' }}>
            ⏳
          </span>
        )}

        {/* Timestamp */}
        <div class="mt-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
          {formatTimestamp(turn.timestamp)}
        </div>
      </div>

      {/* Action buttons on hover (desktop) */}
      <div class="absolute top-0 right-0 hidden gap-1 opacity-0 transition-opacity group-hover:flex group-hover:opacity-100">
        <button
          onClick={() => props.onCopyText?.(turn.content)}
          class="rounded p-1"
          style={{ background: 'var(--c-step-bg)' }}
          title="Copy text"
        >
          📋
        </button>
        <button
          onClick={() => props.onCopyMarkdown?.(turn.content)}
          class="rounded p-1"
          style={{ background: 'var(--c-step-bg)' }}
          title="Copy markdown"
        >
          📝
        </button>
        <button
          onClick={() => props.onForward?.(turn)}
          class="rounded p-1"
          style={{ background: 'var(--c-step-bg)' }}
          title="Forward"
        >
          ↗️
        </button>
        {isAssistant && (
          <button
            onClick={() => props.onRetry?.(turn)}
            class="rounded p-1"
            style={{ background: 'var(--c-step-bg)' }}
            title="Retry"
          >
            🔄
          </button>
        )}
      </div>
    </div>
  )
}

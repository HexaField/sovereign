import type { WorkItem, AgentStatus } from '@template/core'
import type { ChatMessage } from './types.js'

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

export function ChatView(props: ChatViewProps) {
  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      {/* Message list */}
      <div class="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Messages rendered here via MessageBubble + WorkSection */}
      </div>

      {/* Streaming indicator */}
      {props.streamingHtml && (
        <div class="px-4 py-2">
          <span class="animate-pulse text-sm" style={{ color: 'var(--c-text-muted)' }}>
            ●●●
          </span>
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
        </div>
      )}
    </div>
  )
}

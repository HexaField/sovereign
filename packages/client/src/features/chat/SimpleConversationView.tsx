// SimpleConversationView — renders the user↔Hex dialogue as a minimal
// chat list. Shows only what was said between them (user messages +
// Hex's spoken replies via reply_voice / reply_text), stripped of all
// internal reasoning and tool calls.
//
// When the agent works on a response, a subtle thinking indicator
// appears at the bottom — same position as a Hex bubble but muted
// and compact, so the user sees activity without a full response card.

import { For, Show, createEffect } from 'solid-js'
import { simpleConversationEntries, type SimpleConversationEntry } from './simple-conversation-store.js'
import { agentStatus, liveThinkingText, liveWork } from './store.js'
import { agentIcon, agentName } from '../../lib/identity.js'

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function modalityIcon(modality: string): string {
  if (modality === 'voice') return '🎤'
  if (modality === 'ad4m') return '🔗'
  return ''
}

function EntryBubble(props: { entry: SimpleConversationEntry }) {
  const isUser = () => props.entry.role === 'user'

  return (
    <div class="flex gap-2 px-4 py-2" style={{ 'flex-direction': isUser() ? 'row-reverse' : 'row' }}>
      {/* Avatar */}
      <div
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs"
        style={{
          background: isUser() ? 'var(--c-accent)' : 'var(--c-bg-raised)',
          color: isUser() ? '#fff' : 'var(--c-text)',
          border: isUser() ? 'none' : '1px solid var(--c-border)'
        }}
      >
        {isUser() ? '⬡' : agentIcon()}
      </div>

      {/* Bubble */}
      <div
        class="max-w-[80%] rounded-xl px-3 py-2"
        style={{
          background: isUser() ? 'var(--c-accent)' : 'var(--c-bg-raised)',
          color: isUser() ? '#fff' : 'var(--c-text)',
          border: isUser() ? 'none' : '1px solid var(--c-border)'
        }}
      >
        <p class="m-0 text-[13px] leading-relaxed whitespace-pre-wrap">{props.entry.text}</p>
        <div class="mt-1 flex items-center gap-1 text-[10px]" style={{ opacity: 0.6 }}>
          <Show when={modalityIcon(props.entry.modality)}>
            <span>{modalityIcon(props.entry.modality)}</span>
          </Show>
          <span>{formatTime(props.entry.timestamp)}</span>
        </div>
      </div>
    </div>
  )
}

/** Derive a short label from the current agent activity. */
function thinkingLabel(): string {
  const items = liveWork()
  // Walk backwards to find the last tool_call or thinking item
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === 'thinking') return item.output || item.input || 'Thinking'
    if (item.type === 'tool_call') {
      const name = item.name || 'tool'
      if (name === 'exec' && item.input) {
        try {
          const inp = typeof item.input === 'string' ? JSON.parse(item.input) : item.input
          const cmd = inp?.command || ''
          if (cmd) return cmd.slice(0, 50)
        } catch {
          /* fall through */
        }
      }
      return name
    }
  }
  return liveThinkingText() || 'Thinking'
}

/** Subtle working indicator on Hex's side of the conversation. */
function ThinkingIndicator() {
  return (
    <div class="flex gap-2 px-4 py-2">
      {/* Avatar — same as Hex bubble but dimmed */}
      <div
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs"
        style={{
          background: 'var(--c-bg-raised)',
          color: 'var(--c-text-muted)',
          border: '1px solid var(--c-border)',
          opacity: '0.6'
        }}
      >
        {agentIcon()}
      </div>

      {/* Activity hint — compact, italic, muted */}
      <div class="flex items-center gap-1.5" style={{ 'max-width': '75%' }}>
        <span
          class="text-xs leading-relaxed italic"
          style={{
            color: 'var(--c-text-muted)',
            opacity: '0.7',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap'
          }}
        >
          {thinkingLabel()}
        </span>
        <span class="thinking-dots text-xs" style={{ color: 'var(--c-text-muted)' }}>
          ⋯
        </span>
      </div>
    </div>
  )
}

export function SimpleConversationView() {
  let scrollRef: HTMLDivElement | undefined

  const isWorking = () => {
    const s = agentStatus()
    return s === 'working' || s === 'thinking'
  }

  // Auto-scroll to bottom on new entries or when thinking starts
  createEffect(() => {
    simpleConversationEntries()
    agentStatus()
    requestAnimationFrame(() => {
      if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight
    })
  })

  return (
    <div ref={scrollRef} class="flex flex-1 flex-col overflow-y-auto" style={{ background: 'var(--c-bg)' }}>
      <Show
        when={simpleConversationEntries().length > 0 || isWorking()}
        fallback={
          <div class="flex flex-1 items-center justify-center">
            <p class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
              No conversation yet — speak or type to {agentName()}.
            </p>
          </div>
        }
      >
        <div class="flex flex-col gap-1 py-3">
          <For each={simpleConversationEntries()}>{(entry) => <EntryBubble entry={entry} />}</For>
          <Show when={isWorking()}>
            <ThinkingIndicator />
          </Show>
        </div>
      </Show>
    </div>
  )
}

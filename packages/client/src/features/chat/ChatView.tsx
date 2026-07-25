import { createEffect, createSignal, For, Show } from 'solid-js'
import type { WorkItem, AgentStatus, AskUserQuestionResult } from '@sovereign/core'
import { parseAskUserQuestionResult, isAskUserQuestionToolName } from '@sovereign/core/ask-user-question'
import type { ChatMessage } from './types.js'
import { MessageBubble } from './MessageBubble.js'
import { WorkSection } from './WorkSection.js'
import { SubagentCard } from './SubagentCard.js'
import { AskUserQuestionCard } from './AskUserQuestionCard.js'
import { pendingQuestions, submitAnswers } from './questions-store.js'
import { CronResultsBanner } from '../crons/CronResultsBanner.js'
import {
  hasOlderMessages,
  loadingOlder,
  loadOlderMessages,
  streamingText,
  streamingHtml,
  liveWork,
  liveThinkingText,
  serverQueue,
  cancelQueuedMessage,
  retryQueuedMessage,
  turns
} from './store.js'
import { ChatIcon } from '../../ui/icons.js'
import { renderMarkdown } from '../../lib/markdown.js'

/** Collapsible card showing the task/prompt a subagent was spawned with */
function TaskPromptCard(props: { content: string; timestamp: number }) {
  const [expanded, setExpanded] = createSignal(false)
  return (
    <div
      class="my-2 w-full rounded-xl"
      style={{
        background: 'var(--c-bg-raised)',
        border: '1px solid color-mix(in srgb, var(--c-accent) 30%, var(--c-border))'
      }}
    >
      <button
        class="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-4 py-2.5 text-left transition-colors"
        style={{ color: 'var(--c-text)' }}
        onClick={() => setExpanded(!expanded())}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <span class="text-xs" style={{ color: 'var(--c-accent)' }}>
          📋
        </span>
        <span class="flex-1 text-xs font-medium" style={{ color: 'var(--c-accent)' }}>
          Task Prompt
        </span>
        <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
          {new Date(props.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        <span
          class="text-[10px] transition-transform"
          style={{ color: 'var(--c-text-muted)', transform: expanded() ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          ▶
        </span>
      </button>
      <Show when={expanded()}>
        <div
          class="msg-assistant border-t px-4 py-3 text-sm leading-relaxed"
          style={{ 'border-color': 'var(--c-border)', 'max-height': '500px', 'overflow-y': 'auto' }}
          innerHTML={renderMarkdown(props.content)}
        />
      </Show>
    </div>
  )
}

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

/**
 * Pending AskUserQuestion entries whose tool_use_id doesn't appear in any
 * visible turn's workItems. Two ways this happens:
 *
 * 1. **Subagent asked the question**: the tool_call is in the subagent's
 *    transcript, not the parent's. The server routes the pending entry to
 *    the parent thread (see `askUserQuestionStore.register` in the
 *    PreToolUse hook), and this fallback renders it here so the user
 *    actually sees the question.
 * 2. **History truncation / cold start**: pending entry primed via REST
 *    before the tool_call arrives via SSE.
 *
 * Once the corresponding tool_call lands in a turn's workItems, that slot
 * takes over and this fallback stops rendering for that toolCallId.
 */
function orphanPendingQuestions(messages: ChatMessage[]): Array<{ toolCallId: string }> {
  const knownToolCallIds = new Set<string>()
  for (const m of messages) {
    for (const w of m.turn.workItems ?? []) {
      if (w.type === 'tool_call' && isAskUserQuestionToolName(w.name) && w.toolCallId) {
        knownToolCallIds.add(w.toolCallId)
      }
    }
  }
  return pendingQuestions()
    .filter((p) => !knownToolCallIds.has(p.toolCallId))
    .map((p) => ({ toolCallId: p.toolCallId }))
}

/**
 * Extract Claude Code `AskUserQuestion` tool calls from a turn's work items.
 * For each call we return whether the paired tool_result already has a parseable
 * Sovereign-formatted answer (historical / just-answered case) — the slot
 * component then decides whether to show the form or the summary.
 */
function extractAskUserQuestions(
  workItems: WorkItem[]
): Array<{ toolCallId: string; answered: AskUserQuestionResult | null }> {
  const out: Array<{ toolCallId: string; answered: AskUserQuestionResult | null }> = []
  for (const w of workItems) {
    if (w.type !== 'tool_call' || !isAskUserQuestionToolName(w.name) || !w.toolCallId) continue
    const result = workItems.find((r) => r.type === 'tool_result' && r.toolCallId === w.toolCallId)
    out.push({ toolCallId: w.toolCallId, answered: parseAskUserQuestionResult(result?.output) })
  }
  return out
}

/**
 * Renders a single question slot. If the tool_result already has a parseable
 * answer payload, show the read-only summary and skip the pending lookup
 * (historical view is stable + doesn't need the live pending list). Otherwise
 * look up the pending entry by toolCallId and render the form.
 */
function AskUserQuestionSlot(props: { toolCallId: string; answered: AskUserQuestionResult | null; threadKey: string }) {
  const [submitting, setSubmitting] = createSignal(false)
  const [submitError, setSubmitError] = createSignal('')
  const pending = () => pendingQuestions().find((p) => p.toolCallId === props.toolCallId)

  return (
    <Show when={!props.answered} fallback={<AskUserQuestionCard mode="answered" result={props.answered!} />}>
      <Show
        when={pending()}
        fallback={
          <div
            class="mt-2 max-w-[90%] self-start rounded-2xl border p-3 text-xs"
            style={{
              background: 'var(--c-bg-raised)',
              'border-color': 'var(--c-border)',
              color: 'var(--c-text-muted)',
              'font-style': 'italic'
            }}
          >
            Waiting for question payload…
          </div>
        }
      >
        {(entry) => (
          <>
            <AskUserQuestionCard
              mode="pending"
              questions={entry().input.questions}
              submitting={submitting()}
              onSubmit={async (answers, annotations) => {
                setSubmitting(true)
                setSubmitError('')
                const res = await submitAnswers(props.threadKey, props.toolCallId, {
                  questions: entry().input.questions,
                  answers,
                  annotations
                })
                setSubmitting(false)
                if (!res.ok) setSubmitError(res.error ?? 'Submit failed')
              }}
            />
            <Show when={submitError()}>
              <div class="ml-2 text-[11px]" style={{ color: '#ef4444' }}>
                {submitError()}
              </div>
            </Show>
          </>
        )}
      </Show>
    </Show>
  )
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

/** Policy: should new content trigger an auto-scroll, given the user's current
 *  follow-bottom state? Extracted as a pure function so the policy is testable
 *  without a DOM. The full rule: scroll iff the user was anchored at (or near)
 *  the bottom *before* the new content arrived. */
export function shouldAutoScrollOnNewContent(followBottom: boolean): boolean {
  return followBottom
}

export function ChatView(props: ChatViewProps) {
  let scrollRef!: HTMLDivElement

  // Whether the user is currently anchored at the bottom of the scroll
  // container. Drives the gate in the auto-scroll effect below. Defaults to
  // true so first-render content always scrolls into view.
  const [followBottom, setFollowBottom] = createSignal(true)

  const scrollToBottom = () => {
    if (scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight
    }
  }

  // Every scroll event (user-initiated OR programmatic) recomputes whether
  // we're anchored at the bottom. A programmatic `scrollToBottom` ends at the
  // bottom, so this stays self-consistently in follow mode. A manual scroll
  // up past the threshold flips followBottom to false and pauses auto-scroll.
  const onScroll = () => {
    if (!scrollRef) return
    setFollowBottom(isNearBottom(scrollRef.scrollTop, scrollRef.scrollHeight, scrollRef.clientHeight))
  }

  // Reset to follow-bottom when the active thread changes — opening a thread
  // should land at the latest message regardless of where the previous thread's
  // scroll was.
  createEffect(() => {
    props.threadKey
    setFollowBottom(true)
  })

  // Auto-scroll when messages or live state changes — but only if the user is
  // currently anchored at the bottom. This preserves the scroll position when
  // the user has scrolled up to read an earlier message.
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
    serverQueue().length
    if (!shouldAutoScrollOnNewContent(followBottom())) return
    // Double-RAF to ensure DOM has rendered (especially for large history loads)
    requestAnimationFrame(() => requestAnimationFrame(scrollToBottom))
  })

  return (
    <div class="flex min-h-0 flex-1 flex-col" style={{ background: 'var(--c-bg)' }}>
      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        class="flex flex-1 flex-col gap-4 overflow-y-auto p-5"
        tabindex="0"
        style={{ outline: 'none' }}
      >
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

        {/* Cron Results Banner */}
        <CronResultsBanner />

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

            // First user message in a subagent thread = the spawn task/prompt
            const isSubagentTask = () => i() === 0 && msg.turn.role === 'user' && props.threadKey.includes(':subagent:')

            const taskContent = () => {
              if (!isSubagentTask()) return ''
              // Strip the [Subagent Context] header to show just the task
              let text = msg.turn.content || ''
              const taskIdx = text.indexOf('\n\n')
              if (taskIdx > 0 && text.startsWith('[')) text = text.slice(taskIdx + 2)
              return text
            }

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

                {/* Work section between user and assistant turns. Filter
                    AskUserQuestion pairs out — they render richly below as
                    interactive cards; showing them raw here would duplicate
                    the whole question payload as a JSON blob. */}
                {(() => {
                  const items = (msg.turn.workItems || []).filter((w) => {
                    if (!isAskUserQuestionToolName(w.name)) return true
                    return false
                  })
                  return items.length > 0 ? <WorkSection work={items} /> : null
                })()}

                {/* Subagent task prompt — show as a special collapsible card */}
                {isSubagentTask() ? (
                  <TaskPromptCard content={taskContent()} timestamp={msg.turn.timestamp} />
                ) : (
                  /* Message bubble — skip for assistant turns with empty content */
                  (msg.turn.content?.trim() || msg.turn.role !== 'assistant') && (
                    <MessageBubble turn={msg.turn} pending={msg.pending} />
                  )
                )}

                {/* Subagent cards for sessions_spawn tool calls */}
                {extractSubagentSpawns(msg.turn.workItems || []).map((spawn) => (
                  <SubagentCard
                    sessionKey={spawn.sessionKey}
                    task={spawn.task}
                    onView={(key, label) => props.onViewSubagent?.(key, label)}
                  />
                ))}

                {/* AskUserQuestion cards — one per tool_call whose name is
                    `AskUserQuestion`. Renders as an interactive form while
                    the server-side hook is still awaiting an answer, and
                    switches to the read-only summary once a tool_result JSON
                    lands in the same workItems list. */}
                {extractAskUserQuestions(msg.turn.workItems || []).map((entry) => (
                  <AskUserQuestionSlot
                    toolCallId={entry.toolCallId}
                    answered={entry.answered}
                    threadKey={props.threadKey}
                  />
                ))}
              </>
            )
          }}
        </For>

        {/* ── Outbound queue (Sovereign-owned) ─────────────────────
            Render any queue items whose text doesn't already appear in
            history or as an optimistic pending turn. The server queue is
            the canonical source of truth for in-flight messages. */}
        <For each={serverQueue()}>
          {(item) => {
            const alreadyVisible = () =>
              turns().some((t) => t.role === 'user' && t.content === item.text && !t.sendFailed)
            return (
              <Show when={!alreadyVisible()}>
                <div class="flex w-full justify-end">
                  <div
                    class="group relative max-w-[85%] rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap"
                    style={{
                      background: 'var(--c-user-bubble)',
                      color: 'var(--c-user-bubble-text)',
                      opacity: item.status === 'failed' ? '0.6' : '0.6',
                      'font-style': 'italic',
                      border: item.status === 'failed' ? '1px solid #ef4444' : 'none'
                    }}
                  >
                    {item.text}
                    <div
                      class="mt-1.5 flex items-center justify-end gap-2 text-[10px]"
                      style={{ color: 'var(--c-user-bubble-text)', opacity: '0.8' }}
                    >
                      <Show when={item.status === 'queued'}>
                        <span>queued</span>
                      </Show>
                      <Show when={item.status === 'sending'}>
                        <span>sending…</span>
                      </Show>
                      <Show when={item.status === 'failed'}>
                        <span style={{ color: '#ef4444' }}>
                          failed{item.error ? `: ${item.error.slice(0, 60)}` : ''}
                        </span>
                        <button
                          class="cursor-pointer rounded px-1.5 py-0.5"
                          style={{ background: 'rgba(255,255,255,0.18)' }}
                          onClick={() => retryQueuedMessage(item.id)}
                          title="Retry"
                        >
                          ↻
                        </button>
                      </Show>
                      <Show when={item.status !== 'sending'}>
                        <button
                          class="cursor-pointer rounded px-1.5 py-0.5"
                          style={{ background: 'rgba(255,255,255,0.18)' }}
                          onClick={() => cancelQueuedMessage(item.id)}
                          title="Cancel"
                        >
                          ✕
                        </button>
                      </Show>
                    </div>
                  </div>
                </div>
              </Show>
            )
          }}
        </For>

        {/* ── Orphan pending AskUserQuestion cards ────────────────────
            Any pending question whose tool_use_id isn't matched by a tool_call
            in the visible turns' workItems. This is the surface for subagent
            questions — the tool_call lives in the subagent's transcript, but
            the store's hook walks the parentSessionKey chain so the pending
            entry lands on the top-level thread the user is viewing. Also
            covers post-restart / history-truncation cases where a pending
            entry has no local anchor. */}
        <For each={orphanPendingQuestions(props.messages)}>
          {(entry) => <AskUserQuestionSlot toolCallId={entry.toolCallId} answered={null} threadKey={props.threadKey} />}
        </For>

        {/* ── Live streaming section (independent of history turns) ── */}
        <Show when={liveWork().length > 0}>
          <WorkSection work={liveWork()} />
        </Show>

        {/* Live activity indicator — shows what the agent is currently doing */}
        <Show when={liveWork().length > 0 || props.agentStatus === 'working' || props.agentStatus === 'thinking'}>
          {(() => {
            const lastItem = () => {
              const items = liveWork()
              // Find the last meaningful item (tool_call or thinking, skip tool_result)
              for (let i = items.length - 1; i >= 0; i--) {
                if (items[i].type === 'tool_call' || items[i].type === 'thinking') return items[i]
              }
              return null
            }
            const label = () => {
              const item = lastItem()
              if (!item) return liveThinkingText() || 'Thinking'
              if (item.type === 'thinking') return item.output || item.input || 'Thinking'
              if (item.type === 'tool_call') {
                const name = item.name || 'tool'
                if (name === 'exec' && item.input) {
                  try {
                    const inp = typeof item.input === 'string' ? JSON.parse(item.input) : item.input
                    const cmd = inp?.command || ''
                    if (cmd) return name + ' — ' + cmd.slice(0, 60)
                  } catch {}
                }
                return name
              }
              return liveThinkingText() || 'Thinking'
            }
            return (
              <div class="flex items-start gap-2 px-2 py-1.5" style={{ color: 'var(--c-text-muted)' }}>
                <span
                  class="text-xs leading-relaxed italic"
                  style={{
                    opacity: '0.7',
                    'max-width': '90%',
                    'word-break': 'break-word',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap'
                  }}
                >
                  {label()}
                </span>
                <span class="thinking-dots mt-0.5 text-xs">⋯</span>
              </div>
            )
          })()}
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

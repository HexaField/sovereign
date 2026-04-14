import { Show, createSignal, createMemo, createEffect, onCleanup, type JSX } from 'solid-js'
import type { ParsedTurn, ForwardedMessage } from '@sovereign/core'
import { renderMarkdown, escapeHtml } from '../../lib/markdown.js'
import { messageToMarkdown, downloadText, exportMessagePdf, turnsToMarkdown, exportThreadPdf } from './export.js'
import { turns, retrySend, cancelFailedMessage } from './store.js'
import { sanitizeContent, isCompactionMessage } from './sanitize.js'
import {
  WriteIcon,
  BotIcon,
  SystemIcon,
  SplitIcon,
  AlertIcon,
  SignalIcon,
  RefreshIcon,
  ClockIcon,
  FileIcon,
  ChatIcon,
  ListIcon,
  ExternalLinkIcon,
  CloseIcon,
  ChevronDownIcon
} from '../../ui/icons.js'

// ── Icons ────────────────────────────────────────────────────────────

const copyIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
const checkIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`

// ── Exported helpers (tests depend on these) ─────────────────────────

export function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const isToday =
    d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  if (isToday) return `Today at ${time}`
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  return `${date} at ${time}`
}

// ── MarkdownContent (internal) ───────────────────────────────────────

function MarkdownContentInternal(props: { text: string }) {
  let ref!: HTMLDivElement
  const html = createMemo(() => renderMarkdown(props.text))
  createEffect(() => {
    ref.innerHTML = html()
    // Inject copy buttons on <pre> code blocks
    ref.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return
      const btn = document.createElement('button')
      btn.className = 'code-copy-btn'
      btn.title = 'Copy code'
      btn.innerHTML = copyIcon
      btn.onclick = async () => {
        const code = pre.querySelector('code')
        const text = (code || pre).textContent || ''
        try {
          await navigator.clipboard.writeText(text)
          btn.innerHTML = checkIcon
          setTimeout(() => (btn.innerHTML = copyIcon), 1500)
        } catch {
          /* empty */
        }
      }
      pre.style.position = 'relative'
      pre.appendChild(btn)
    })
    // Inject copy buttons on inline <code> (not inside <pre>)
    ref.querySelectorAll('code').forEach((code) => {
      if (code.closest('pre')) return
      if (code.querySelector('.inline-code-copy')) return
      const wrapper = document.createElement('span')
      wrapper.className = 'inline-code-wrap'
      code.parentNode?.insertBefore(wrapper, code)
      wrapper.appendChild(code)
      const btn = document.createElement('button')
      btn.className = 'inline-code-copy'
      btn.title = 'Copy'
      btn.innerHTML = copyIcon
      btn.onclick = async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(code.textContent || '')
          btn.innerHTML = checkIcon
          setTimeout(() => (btn.innerHTML = copyIcon), 1500)
        } catch {
          /* empty */
        }
      }
      wrapper.appendChild(btn)
    })
  })
  return <div ref={ref} />
}

// ── Context menu item ────────────────────────────────────────────────

function ContextMenuItem(props: { icon: JSX.Element | string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      class="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors"
      style={{ color: props.danger ? '#ef4444' : 'var(--c-text)' }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--c-hover-bg-strong)')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '')}
      onClick={props.onClick}
    >
      <span>{props.icon}</span>
      {props.label}
    </button>
  )
}

// ── Props ────────────────────────────────────────────────────────────

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

// ── Component ────────────────────────────────────────────────────────

export function MessageBubble(props: MessageBubbleProps) {
  const [menuPos, setMenuPos] = createSignal<{ x: number; y: number } | null>(null)
  const [copied, setCopied] = createSignal(false)
  let longPressTimer: ReturnType<typeof setTimeout> | undefined
  let bubbleRef!: HTMLDivElement
  let wrapperRef!: HTMLDivElement
  let menuRef!: HTMLDivElement

  const role = () => props.turn.role
  const rawContent = () => props.turn.content
  const content = () => sanitizeContent(role(), rawContent())
  const timestamp = () => props.turn.timestamp
  const pending = () => props.pending ?? props.turn.pending
  const sendFailed = () => props.turn.sendFailed === true

  const showMenu = (x: number, y: number) => {
    setMenuPos({ x, y })
    setCopied(false)
    requestAnimationFrame(() => {
      if (!menuRef) return
      const rect = menuRef.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const mx = Math.min(x, vw - rect.width - 8)
      const my = rect.bottom > vh ? y - rect.height : y
      setMenuPos({ x: Math.max(8, mx), y: Math.max(8, my) })
    })
  }

  const hideMenu = () => setMenuPos(null)

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    showMenu(e.clientX, e.clientY)
  }

  const handleTouchStart = (e: TouchEvent) => {
    const target = e.target as HTMLElement
    if (target !== bubbleRef && target !== wrapperRef) {
      if (isTextElement(target)) return
    }
    const touch = e.touches[0]
    longPressTimer = setTimeout(() => {
      showMenu(touch.clientX, touch.clientY)
    }, 500)
  }

  const handleTouchEnd = () => clearTimeout(longPressTimer)
  const handleTouchMove = () => clearTimeout(longPressTimer)

  function isTextElement(el: HTMLElement): boolean {
    if (el === bubbleRef || el === wrapperRef) return false
    const textTags = new Set([
      'p',
      'span',
      'a',
      'em',
      'strong',
      'code',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'pre',
      'blockquote',
      'td',
      'th'
    ])
    if (textTags.has(el.tagName?.toLowerCase())) return true
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true
    }
    return false
  }

  const copyText = async () => {
    try {
      const sel = window.getSelection()
      if (sel && sel.toString().trim() && wrapperRef?.contains(sel.anchorNode)) {
        await navigator.clipboard.writeText(sel.toString())
      } else {
        await navigator.clipboard.writeText(content())
      }
      setCopied(true)
      setTimeout(hideMenu, 800)
    } catch {
      /* empty */
    }
  }

  const handleDocClick = () => {
    if (menuPos()) hideMenu()
  }

  document.addEventListener('click', handleDocClick, true)
  onCleanup(() => document.removeEventListener('click', handleDocClick, true))

  // ── System message rendering ─────────────────────

  if (role() === 'system') {
    // Hide empty system turns (render as thin blue lines otherwise)
    if (!content()?.trim()) return null

    const [expanded, setExpanded] = createSignal(false)
    const isErrorTurn = /^Error:\s/i.test(content())
    const isCron = /^Cron:|^\[CronResult\]|^Scheduled Result|cron job|cron schedule/i.test(content())
    const isEvent = /event|routing|processed\/|GRAPH|NOTIFY|AGENT|VOID/i.test(content())
    const isReconciliation = /reconcil|graph.*task/i.test(content())
    const isSubagent = /subagent task .* completed/i.test(content())
    const isExecFailed = /Exec failed/i.test(content())
    const isMemorySave = /^Write any lasting notes to memory\//i.test(content())
    const isHeartbeat = /^Heartbeat prompt:/i.test(content()) || content() === 'HEARTBEAT_OK'
    const isSubagentContext = content().startsWith('[Subagent Context]') || content().startsWith('[Subagent Task]')
    const isRuntimeContext = /^OpenClaw runtime context \(internal\):/i.test(content())
    const isTaskCompletion = isRuntimeContext && /\[Internal task completion event\]/i.test(content())

    // Hide internal-only messages entirely
    if (isRuntimeContext || isSubagentContext || isMemorySave || isHeartbeat) {
      return null
    }

    // Error turns — render prominently with red styling
    if (isErrorTurn) {
      return (
        <div class="my-2 flex w-full justify-center">
          <div
            class="max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-relaxed break-words select-text"
            style={{
              background: 'color-mix(in srgb, #ef4444 15%, var(--c-bg-raised))',
              color: '#ef4444',
              border: '1px solid color-mix(in srgb, #ef4444 40%, var(--c-border))'
            }}
          >
            <div class="mb-1 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: '#ef4444' }}>
              <AlertIcon class="inline h-4 w-4" />
              <span>Agent Error</span>
              <Show when={timestamp()}>
                <span style={{ opacity: 0.5, 'font-weight': 'normal', 'margin-left': '4px' }}>
                  {new Date(timestamp()!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </Show>
            </div>
            <span>{content().replace(/^Error:\s*/i, '')}</span>
          </div>
        </div>
      )
    }

    const icon = isTaskCompletion ? (
      <BotIcon class="inline h-4 w-4" />
    ) : isRuntimeContext ? (
      <SystemIcon class="inline h-4 w-4" />
    ) : isSubagentContext ? (
      <SplitIcon class="inline h-4 w-4" />
    ) : isSubagent ? (
      <BotIcon class="inline h-4 w-4" />
    ) : isExecFailed ? (
      <AlertIcon class="inline h-4 w-4" />
    ) : isCron ? (
      <ClockIcon class="inline h-4 w-4" />
    ) : isEvent ? (
      <SignalIcon class="inline h-4 w-4" />
    ) : isReconciliation ? (
      <RefreshIcon class="inline h-4 w-4" />
    ) : (
      <ClockIcon class="inline h-4 w-4" />
    )
    const label = isMemorySave
      ? 'Memory Checkpoint'
      : isHeartbeat
        ? 'Heartbeat'
        : isTaskCompletion
          ? (() => {
              const m = content().match(/task:\s*(.+)/im)
              const s = content().match(/status:\s*(.+)/im)
              return m ? `Sub-agent: ${m[1].trim()}${s ? ` — ${s[1].trim()}` : ''}` : 'Sub-agent Result'
            })()
          : isRuntimeContext
            ? 'Runtime Context'
            : isSubagentContext
              ? 'Subagent Task'
              : isSubagent
                ? (() => {
                    const m = content().match(/subagent task "([^"]+)"/)
                    return m ? `Sub-agent: ${m[1]}` : 'Sub-agent Result'
                  })()
                : isExecFailed
                  ? 'Exec Notification'
                  : isCron
                    ? 'Cron Result'
                    : isEvent
                      ? 'Event Routing'
                      : isReconciliation
                        ? 'Graph Reconciliation'
                        : 'Scheduled Result'
    return (
      <div class="my-1 flex w-full justify-center">
        <div
          class="msg-assistant max-w-[90%] cursor-pointer rounded-2xl px-4 py-3 text-sm leading-relaxed break-words select-text"
          style={{
            background: 'var(--c-bg-raised)',
            color: 'var(--c-text)',
            border: '1px solid color-mix(in srgb, var(--c-accent) 30%, var(--c-border))'
          }}
          onClick={() => setExpanded((v) => !v)}
        >
          <div class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--c-accent)' }}>
            <span>{icon}</span>
            <span>{label}</span>
            <Show when={timestamp()}>
              <span style={{ opacity: 0.5, 'font-weight': 'normal', 'margin-left': '4px' }}>
                {new Date(timestamp()!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </Show>
            <span style={{ 'margin-left': 'auto', 'font-size': '10px', opacity: 0.6 }}>
              <ChevronDownIcon class={`inline h-3 w-3 transition-transform ${expanded() ? 'rotate-180' : ''}`} />
            </span>
          </div>
          <div
            style={{
              overflow: 'hidden',
              display: '-webkit-box',
              '-webkit-box-orient': 'vertical',
              ...(expanded() ? {} : { '-webkit-line-clamp': '2' })
            }}
          >
            <MarkdownContentInternal text={content()} />
          </div>
        </div>
      </div>
    )
  }

  // ── Compaction messages ───────────────────────────

  if (isCompactionMessage(rawContent())) {
    return (
      <div class="my-1 flex w-full justify-center">
        <div
          class="rounded-full px-3 py-1 text-xs"
          style={{
            background: 'var(--c-bg-raised)',
            color: 'var(--c-text-muted)',
            border: '1px solid var(--c-border)'
          }}
        >
          {rawContent()}
        </div>
      </div>
    )
  }

  // ── Empty after sanitization ──────────────────────

  if (!content()?.trim()) return null

  // ── User / Assistant rendering ─────────────────────

  return (
    <>
      <div
        ref={wrapperRef}
        class="flex w-full"
        classList={{
          'justify-end': role() === 'user',
          'justify-start': role() === 'assistant'
        }}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
      >
        {/* Forwarded header */}
        <Show when={props.forwarded}>
          {(fwd) => (
            <div
              class="mb-1 border-l-2 pl-2 text-xs"
              style={{ 'border-color': 'var(--c-accent)', color: 'var(--c-text-muted)' }}
            >
              Forwarded from {fwd().sourceThreadLabel}
              {' · '}
              {formatTimestamp(fwd().originalTimestamp)}
            </div>
          )}
        </Show>

        <div
          ref={bubbleRef}
          class="group relative max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed break-words select-text"
          classList={{
            'rounded-br-sm whitespace-pre-wrap': role() === 'user',
            'rounded-bl-sm msg-assistant': role() === 'assistant',
            'streaming-dots': !!props.turn.streaming
          }}
          style={{
            background: role() === 'user' ? 'var(--c-user-bubble)' : 'var(--c-bg-raised)',
            color: role() === 'user' ? 'var(--c-user-bubble-text)' : 'var(--c-text)',
            border: role() === 'assistant' ? '1px solid var(--c-border)' : 'none',
            ...(pending() ? { opacity: '0.5', 'font-style': 'italic' } : {}),
            ...(props.turn.streaming ? { opacity: '0.7' } : {}),
            ...(sendFailed() ? { opacity: '0.6', border: '1px solid #ef4444' } : {})
          }}
        >
          <Show
            when={role() === 'assistant'}
            fallback={<span innerHTML={escapeHtml(content()).replace(/\n/g, '<br>')} />}
          >
            <MarkdownContentInternal text={content()} />
          </Show>
          <button
            class="msg-copy-btn"
            title="Copy message"
            onClick={async (e) => {
              e.stopPropagation()
              try {
                await navigator.clipboard.writeText(content())
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              } catch {
                /* empty */
              }
            }}
          >
            <Show when={!copied()} fallback={<span innerHTML={checkIcon} />}>
              <span innerHTML={copyIcon} />
            </Show>
          </button>
        </div>
        <Show when={sendFailed()}>
          <div
            class="mt-1 flex items-center gap-2"
            style={{ 'justify-content': role() === 'user' ? 'flex-end' : 'flex-start' }}
          >
            <span class="text-xs" style={{ color: '#ef4444' }}>
              Failed to send
            </span>
            <button
              class="cursor-pointer rounded px-2 py-0.5 text-xs font-medium transition-colors"
              style={{ background: 'var(--c-accent)', color: 'var(--c-bg)', border: 'none' }}
              onClick={() => retrySend(props.turn)}
            >
              Retry
            </button>
            <button
              class="cursor-pointer rounded px-2 py-0.5 text-xs transition-colors"
              style={{ background: 'transparent', color: 'var(--c-text-muted)', border: '1px solid var(--c-border)' }}
              onClick={() => cancelFailedMessage(props.turn)}
            >
              Cancel
            </button>
          </div>
        </Show>
        <Show when={pending() && !sendFailed()}>
          <div class="mt-1 text-right text-xs" style={{ color: 'var(--c-text-muted)', opacity: '0.6' }}>
            Queued
          </div>
        </Show>
      </div>
      <Show when={menuPos()}>
        <div
          ref={menuRef}
          class="fixed z-[999] min-w-[160px] overflow-hidden rounded-lg shadow-xl"
          style={{
            left: `${menuPos()!.x}px`,
            top: `${menuPos()!.y}px`,
            background: 'var(--c-menu-bg)',
            border: '1px solid var(--c-border-strong)'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <Show when={timestamp()}>
            <div
              class="px-3 py-2 text-[11px]"
              style={{ color: 'var(--c-text-muted)', 'border-bottom': '1px solid var(--c-border-strong)' }}
            >
              {formatTimestamp(timestamp()!)}
            </div>
          </Show>
          <Show when={pending()}>
            <ContextMenuItem
              icon={<CloseIcon class="h-3.5 w-3.5" />}
              label="Remove from queue"
              onClick={() => {
                // removePendingTurn not wired yet
                hideMenu()
              }}
              danger
            />
            <div style={{ height: '1px', background: 'var(--c-border-strong)' }} />
          </Show>
          <button
            class="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors"
            style={{ color: 'var(--c-text)' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--c-hover-bg-strong)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '')}
            onClick={copyText}
          >
            <Show
              when={!copied()}
              fallback={
                <>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#4ade80"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span style={{ color: '#4ade80' }}>Copied!</span>
                </>
              }
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Copy text
            </Show>
          </button>

          <div style={{ height: '1px', background: 'var(--c-border-strong)' }} />

          <ContextMenuItem
            icon={<WriteIcon class="h-3.5 w-3.5" />}
            label="Export message as Markdown"
            onClick={() => {
              const md = messageToMarkdown(role(), content(), timestamp())
              downloadText(md, `message-${Date.now()}.md`)
              hideMenu()
            }}
          />
          <ContextMenuItem
            icon={<FileIcon class="h-3.5 w-3.5" />}
            label="Export message as PDF"
            onClick={() => {
              exportMessagePdf(role(), content(), timestamp())
              hideMenu()
            }}
          />

          <div style={{ height: '1px', background: 'var(--c-border-strong)' }} />

          <ContextMenuItem
            icon={<ChatIcon class="h-3.5 w-3.5" />}
            label="Export thread as Markdown"
            onClick={() => {
              const md = turnsToMarkdown(turns())
              downloadText(md, `chat-export-${Date.now()}.md`)
              hideMenu()
            }}
          />
          <ContextMenuItem
            icon={<ListIcon class="h-3.5 w-3.5" />}
            label="Export thread as PDF"
            onClick={() => {
              exportThreadPdf(turns())
              hideMenu()
            }}
          />

          <Show when={props.onForward}>
            <div style={{ height: '1px', background: 'var(--c-border-strong)' }} />
            <ContextMenuItem
              icon={<ExternalLinkIcon class="h-3.5 w-3.5" />}
              label="Forward to thread"
              onClick={() => {
                props.onForward?.(props.turn)
                hideMenu()
              }}
            />
          </Show>
        </div>
      </Show>
    </>
  )
}

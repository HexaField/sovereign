import { createSignal, Show } from 'solid-js'
import type { ParsedTurn } from '@sovereign/core'
import { parseSubagentResult, type SubagentResult } from '@sovereign/core/subagent-result'
import { SplitIcon, ChevronDownIcon } from '../../ui/icons.js'
import { renderMarkdown } from '../../lib/markdown.js'

/**
 * The agents_spawn result in a turn, or null. History turns arrive classified
 * (`kind.variant === 'subagent-result'`, body in `content`); the live turn the
 * chat module synthesizes still carries the raw `[Subagent …]` message.
 */
export function subagentResultOf(turn: ParsedTurn): SubagentResult | null {
  const k = turn.kind
  if (k?.variant === 'subagent-result') {
    const p = (k.payload ?? {}) as Record<string, unknown>
    return {
      status: p.status === 'failed' ? 'failed' : 'done',
      label: k.label,
      minutes: Number(p.minutes ?? 0),
      ...(typeof p.error === 'string' ? { error: p.error } : {}),
      body: turn.content ?? '',
      ...(typeof p.sessionKey === 'string' ? { sessionKey: p.sessionKey } : {})
    }
  }
  if (turn.role === 'assistant' || k) return null
  return parseSubagentResult(turn.content ?? '')
}

export function SubagentResultCard(props: {
  result: SubagentResult
  timestamp?: number
  onView?: (sessionKey: string, label: string) => void
}) {
  const [expanded, setExpanded] = createSignal(false)
  const failed = () => props.result.status === 'failed'
  const color = () => (failed() ? '#ef4444' : '#4ade80')
  const preview = () =>
    props.result.body
      .replace(/[#*_`>|-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)

  return (
    <div class="my-2 flex w-full justify-start">
      <div
        class="max-w-[85%] min-w-0 rounded-xl"
        style={{
          background: 'var(--c-bg-raised)',
          border: `1px solid color-mix(in srgb, ${color()} 35%, var(--c-border))`
        }}
        data-testid="subagent-result-card"
      >
        <button
          class="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-2 text-left"
          style={{ color: 'var(--c-text)' }}
          onClick={() => setExpanded((v) => !v)}
        >
          <SplitIcon class="h-4 w-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
            {props.result.label || 'Subagent'}
          </span>
          <span class="flex shrink-0 items-center gap-1 text-[10px]" style={{ color: color() }}>
            <span class="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color() }} />
            {failed() ? 'Failed' : 'Done'} · {props.result.minutes} min
          </span>
          <Show when={props.timestamp}>
            <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              {new Date(props.timestamp!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </Show>
          <ChevronDownIcon
            class={`h-3 w-3 shrink-0 transition-transform ${expanded() ? 'rotate-180' : ''}`}
            style={{ color: 'var(--c-text-muted)' }}
          />
        </button>

        <Show when={props.result.error}>
          <div class="px-3 pb-1.5 text-[11px]" style={{ color: '#ef4444' }}>
            {props.result.error}
          </div>
        </Show>

        <Show when={!expanded() && preview()}>
          <div
            class="cursor-pointer px-3 pb-2 text-[11px] leading-relaxed"
            style={{
              color: 'var(--c-text-muted)',
              display: '-webkit-box',
              '-webkit-box-orient': 'vertical',
              '-webkit-line-clamp': '2',
              overflow: 'hidden'
            }}
            onClick={() => setExpanded(true)}
          >
            {preview()}
          </div>
        </Show>

        <Show when={expanded()}>
          <div class="border-t px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
            <Show when={props.result.body}>
              <div class="msg-assistant text-sm leading-relaxed" innerHTML={renderMarkdown(props.result.body)} />
            </Show>
            <Show when={props.result.sessionKey && props.onView}>
              <button
                class="mt-2 cursor-pointer rounded-md border-none bg-transparent px-2 py-1 text-[11px] font-medium"
                style={{ color: 'var(--c-accent)' }}
                onClick={() => props.onView!(props.result.sessionKey!, props.result.label)}
              >
                Open session ↗
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

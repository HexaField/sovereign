import { createSignal, createMemo, For, Show } from 'solid-js'
import type { AskUserQuestionItem, AskUserQuestionResult } from '@sovereign/core'
import { renderMarkdown } from '../../lib/markdown.js'

// Inline card for Claude Code's `AskUserQuestion` tool. Renders in two modes:
//
// - **Pending**: form with radios (single-select) or checkboxes (multi-select)
//   per question, an "Other" text input, and a single "Submit all answers"
//   button that stays disabled until every question has an answer. Placed
//   directly below the assistant turn whose tool_call opened the questions,
//   so the visual anchor is the request context itself.
// - **Answered** (historical): read-only summary of the same questions with
//   the user's chosen labels or free-text. Parsed from the tool_result JSON
//   that lives in the JSONL — history replay renders identically to the
//   moment right after submission.

const OTHER_SENTINEL = '__OTHER__'
const MULTI_SEPARATOR = ', '

interface PendingProps {
  mode: 'pending'
  questions: AskUserQuestionItem[]
  submitting: boolean
  onSubmit: (answers: Record<string, string>, annotations: Record<string, { custom?: boolean; notes?: string }>) => void
}

interface AnsweredProps {
  mode: 'answered'
  result: AskUserQuestionResult
}

export function AskUserQuestionCard(props: PendingProps | AnsweredProps) {
  if (props.mode === 'answered') return <AnsweredView result={props.result} />
  return <PendingForm {...props} />
}

function PendingForm(props: PendingProps) {
  // Selection state keyed by question text. For single-select: value = option
  // label OR the OTHER sentinel. For multi-select: a Set of labels (+
  // sentinel). Custom text is stored separately per question.
  const [singleChoice, setSingleChoice] = createSignal<Record<string, string>>({})
  const [multiChoice, setMultiChoice] = createSignal<Record<string, Set<string>>>({})
  const [customText, setCustomText] = createSignal<Record<string, string>>({})

  function toggleMulti(q: string, label: string): void {
    setMultiChoice((prev) => {
      const next = { ...prev }
      const set = new Set(next[q] ?? [])
      if (set.has(label)) set.delete(label)
      else set.add(label)
      next[q] = set
      return next
    })
  }

  function setSingle(q: string, label: string): void {
    setSingleChoice((prev) => ({ ...prev, [q]: label }))
  }

  function setCustom(q: string, text: string): void {
    setCustomText((prev) => ({ ...prev, [q]: text }))
  }

  const answerFor = (item: AskUserQuestionItem): string | null => {
    const custom = (customText()[item.question] ?? '').trim()
    if (item.multiSelect) {
      const set = multiChoice()[item.question] ?? new Set()
      const labels = [...set].filter((l) => l !== OTHER_SENTINEL)
      if (set.has(OTHER_SENTINEL)) {
        if (!custom) return null
        labels.push(custom)
      }
      return labels.length > 0 ? labels.join(MULTI_SEPARATOR) : null
    }
    const choice = singleChoice()[item.question]
    if (!choice) return null
    if (choice === OTHER_SENTINEL) return custom ? custom : null
    return choice
  }

  const allAnswered = createMemo(() => props.questions.every((q) => answerFor(q) !== null))

  function handleSubmit(): void {
    const answers: Record<string, string> = {}
    const annotations: Record<string, { custom?: boolean; notes?: string }> = {}
    for (const q of props.questions) {
      const value = answerFor(q)
      if (value === null) return
      answers[q.question] = value
      const singleCustom = !q.multiSelect && singleChoice()[q.question] === OTHER_SENTINEL
      const multiCustom = q.multiSelect && (multiChoice()[q.question]?.has(OTHER_SENTINEL) ?? false)
      const isCustom = singleCustom || multiCustom
      if (isCustom) annotations[q.question] = { custom: true }
    }
    props.onSubmit(answers, annotations)
  }

  return (
    <div
      class="mt-2 max-w-[90%] self-start rounded-2xl border p-4"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': 'color-mix(in srgb, var(--c-accent) 30%, var(--c-border))',
        color: 'var(--c-text)'
      }}
    >
      <div
        class="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase"
        style={{ color: 'var(--c-accent)', 'letter-spacing': '0.05em' }}
      >
        <span>Questions</span>
        <Show when={props.questions.length > 1}>
          <span style={{ opacity: 0.6 }}>· {props.questions.length}</span>
        </Show>
      </div>

      <div class="flex flex-col gap-4">
        <For each={props.questions}>
          {(item, idx) => (
            <QuestionRow
              index={idx()}
              item={item}
              singleValue={singleChoice()[item.question] ?? ''}
              multiValues={multiChoice()[item.question] ?? new Set()}
              customText={customText()[item.question] ?? ''}
              onSingle={(v) => setSingle(item.question, v)}
              onToggleMulti={(v) => toggleMulti(item.question, v)}
              onCustom={(v) => setCustom(item.question, v)}
            />
          )}
        </For>
      </div>

      <div class="mt-4 flex items-center justify-end gap-2">
        <Show when={!allAnswered()}>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            Answer every question to submit.
          </span>
        </Show>
        <button
          class="rounded-md px-4 py-1.5 text-xs font-semibold transition-opacity"
          style={{
            background: 'var(--c-accent)',
            color: 'var(--c-bg)',
            opacity: allAnswered() && !props.submitting ? 1 : 0.5,
            cursor: allAnswered() && !props.submitting ? 'pointer' : 'not-allowed'
          }}
          disabled={!allAnswered() || props.submitting}
          onClick={handleSubmit}
        >
          {props.submitting ? 'Submitting…' : 'Submit all answers'}
        </button>
      </div>
    </div>
  )
}

function QuestionRow(props: {
  index: number
  item: AskUserQuestionItem
  singleValue: string
  multiValues: Set<string>
  customText: string
  onSingle: (v: string) => void
  onToggleMulti: (v: string) => void
  onCustom: (v: string) => void
}) {
  const isSelected = (label: string) =>
    props.item.multiSelect ? props.multiValues.has(label) : props.singleValue === label
  const otherSelected = () =>
    props.item.multiSelect ? props.multiValues.has(OTHER_SENTINEL) : props.singleValue === OTHER_SENTINEL

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span
          class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
          style={{
            background: 'color-mix(in srgb, var(--c-accent) 15%, transparent)',
            color: 'var(--c-accent)',
            'letter-spacing': '0.04em'
          }}
        >
          {props.item.header}
        </span>
        <span class="text-sm font-medium">{props.item.question}</span>
        <Show when={props.item.multiSelect}>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)', 'font-style': 'italic' }}>
            (choose any)
          </span>
        </Show>
      </div>

      <div class="flex flex-col gap-1">
        <For each={props.item.options}>
          {(option) => (
            <OptionRow
              multi={props.item.multiSelect}
              name={`q${props.index}`}
              option={option}
              selected={isSelected(option.label)}
              onSelect={() =>
                props.item.multiSelect ? props.onToggleMulti(option.label) : props.onSingle(option.label)
              }
            />
          )}
        </For>
        <OptionRow
          multi={props.item.multiSelect}
          name={`q${props.index}`}
          option={{ label: 'Other', description: 'Write your own answer.' }}
          selected={otherSelected()}
          onSelect={() =>
            props.item.multiSelect ? props.onToggleMulti(OTHER_SENTINEL) : props.onSingle(OTHER_SENTINEL)
          }
        />
        <Show when={otherSelected()}>
          <input
            type="text"
            class="mt-1 ml-6 rounded border px-2 py-1 text-xs"
            style={{
              background: 'var(--c-bg)',
              'border-color': 'var(--c-border)',
              color: 'var(--c-text)'
            }}
            placeholder="Your answer…"
            value={props.customText}
            onInput={(e) => props.onCustom((e.currentTarget as HTMLInputElement).value)}
          />
        </Show>
      </div>
    </div>
  )
}

function OptionRow(props: {
  multi: boolean
  name: string
  option: { label: string; description: string; preview?: string }
  selected: boolean
  onSelect: () => void
}) {
  const [showPreview, setShowPreview] = createSignal(false)
  const previewHtml = createMemo(() => (props.option.preview ? renderMarkdown(props.option.preview) : ''))
  return (
    <div>
      <label
        class="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 transition-colors"
        classList={{ 'bg-[var(--c-hover-bg)]': props.selected }}
        onMouseDown={(e) => {
          // Prevent the browser stealing focus from a nested input.
          e.preventDefault()
        }}
      >
        <input
          type={props.multi ? 'checkbox' : 'radio'}
          name={props.name}
          checked={props.selected}
          onChange={props.onSelect}
          class="mt-0.5 shrink-0"
        />
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium" style={{ color: 'var(--c-text)' }}>
            {props.option.label}
          </div>
          <Show when={props.option.description}>
            <div class="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
              {props.option.description}
            </div>
          </Show>
        </div>
        <Show when={props.option.preview}>
          <button
            type="button"
            class="ml-2 shrink-0 rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: 'var(--c-hover-bg)', color: 'var(--c-accent)' }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setShowPreview((v) => !v)
            }}
          >
            {showPreview() ? 'hide preview' : 'preview'}
          </button>
        </Show>
      </label>
      <Show when={showPreview() && previewHtml()}>
        <div
          class="mt-1 ml-6 rounded p-2 text-[11px] leading-relaxed"
          style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--c-text-muted)' }}
          innerHTML={previewHtml()}
        />
      </Show>
    </div>
  )
}

function AnsweredView(props: { result: AskUserQuestionResult }) {
  const answeredAt = () => new Date(props.result.answeredAt).toLocaleString()
  return (
    <div
      class="mt-2 max-w-[90%] self-start rounded-2xl border p-4"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': 'var(--c-border)',
        color: 'var(--c-text)'
      }}
    >
      <div
        class="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase"
        style={{ color: 'var(--c-text-muted)', 'letter-spacing': '0.05em' }}
      >
        <span>Answered</span>
        <span style={{ opacity: 0.6 }}>· {answeredAt()}</span>
      </div>
      <div class="flex flex-col gap-3">
        <For each={props.result.questions}>
          {(item) => {
            const answer = props.result.answers[item.question] ?? '—'
            const annotation = props.result.annotations?.[item.question]
            return (
              <div class="flex flex-col gap-1">
                <div class="flex items-center gap-2">
                  <span
                    class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                    style={{
                      background: 'color-mix(in srgb, var(--c-accent) 12%, transparent)',
                      color: 'var(--c-accent)',
                      'letter-spacing': '0.04em'
                    }}
                  >
                    {item.header}
                  </span>
                  <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                    {item.question}
                  </span>
                </div>
                <div class="ml-1 text-sm">
                  <span class="font-medium" style={{ color: 'var(--c-text)' }}>
                    {answer}
                  </span>
                  <Show when={annotation?.custom}>
                    <span class="ml-2 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                      (custom)
                    </span>
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}

// A rethink run report (markdown from GET /api/forge/rethink/runs/:id) in a
// dialog, with the run list beside it to switch between runs.

import { createEffect, createSignal, For, on, Show, type Component } from 'solid-js'
import { renderMarkdown } from '../../lib/markdown.js'
import type { ForgeApi } from './api.js'
import type { RethinkRunSummary } from './rethink-model.js'

export interface RethinkReportProps {
  membrane: string
  api: ForgeApi
  runs: RethinkRunSummary[]
  /** The run shown first. */
  runId: string
  threadId: string | null
  onOpenThread: (id: string) => void
  onClose: () => void
}

const RethinkReport: Component<RethinkReportProps> = (props) => {
  const [id, setId] = createSignal(props.runId)
  const [html, setHtml] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)

  createEffect(
    on(id, async (runId) => {
      setError(null)
      setHtml('')
      try {
        const md = await props.api.rethinkReport(props.membrane, runId)
        if (id() === runId) setHtml(renderMarkdown(md))
      } catch (e) {
        if (id() === runId) setError(e instanceof Error ? e.message : String(e))
      }
    })
  )

  return (
    <div
      class="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose()
      }}
      data-testid="forge-rethink-report"
    >
      <div
        class="flex max-h-[85vh] w-[min(56rem,95vw)] flex-col rounded-lg shadow-xl"
        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
      >
        <div class="flex items-center gap-2 border-b px-4 py-2" style={{ 'border-color': 'var(--c-border)' }}>
          <h2 class="flex-1 text-sm font-semibold">Rethink runs</h2>
          <Show when={props.threadId}>
            {(t) => (
              <button
                class="rounded border px-2 py-0.5 text-xs hover:bg-[var(--c-hover-bg)]"
                style={{ 'border-color': 'var(--c-border)' }}
                onClick={() => props.onOpenThread(t())}
              >
                Open rethink thread
              </button>
            )}
          </Show>
          <button onClick={() => props.onClose()} style={{ color: 'var(--c-text-muted)' }} title="Close">
            ✕
          </button>
        </div>
        <div class="flex min-h-0 flex-1">
          <div class="w-48 shrink-0 overflow-y-auto border-r p-2 text-xs" style={{ 'border-color': 'var(--c-border)' }}>
            <For each={props.runs}>
              {(r) => (
                <button
                  class="mb-0.5 block w-full rounded px-2 py-1 text-left hover:bg-[var(--c-hover-bg)]"
                  style={{ color: r.id === id() ? 'var(--c-accent)' : 'var(--c-text)' }}
                  onClick={() => setId(r.id)}
                  data-testid="forge-rethink-run"
                >
                  {r.id}
                  <div style={{ color: 'var(--c-text-muted)' }}>
                    {r.trigger} · {r.status}
                  </div>
                </button>
              )}
            </For>
          </div>
          <div class="min-w-0 flex-1 overflow-y-auto p-4 text-sm">
            <Show when={error()}>
              <div style={{ color: 'var(--c-error, #ef4444)' }}>{error()}</div>
            </Show>
            <div class="prose-sm leading-relaxed" innerHTML={html()} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default RethinkReport

import { Component, createSignal, createResource, Show, For, createMemo } from 'solid-js'

export interface DiffLine {
  type: 'added' | 'removed' | 'context'
  content: string
  oldLineNum?: number
  newLineNum?: number
}

export interface DiffData {
  path: string
  hunks: { header: string; lines: DiffLine[] }[]
}

export interface DiffViewerTabProps {
  path: string
  projectId: string
  base?: string
  head?: string
  onClose?: () => void
}

async function fetchDiff(params: { path: string; projectId: string; base?: string; head?: string }): Promise<DiffData> {
  const qs = new URLSearchParams({ path: params.path, projectId: params.projectId })
  if (params.base) qs.set('base', params.base)
  if (params.head) qs.set('head', params.head)
  const res = await fetch(`/api/diff?${qs.toString()}`)
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.statusText}`)
  return res.json()
}

const lineColors: Record<DiffLine['type'], { bg: string; color: string; prefix: string }> = {
  added: { bg: 'rgba(34,197,94,0.15)', color: 'var(--c-success, #22c55e)', prefix: '+' },
  removed: { bg: 'rgba(239,68,68,0.15)', color: 'var(--c-error, #ef4444)', prefix: '-' },
  context: { bg: 'transparent', color: 'var(--c-text-primary)', prefix: ' ' }
}

const DiffViewerTab: Component<DiffViewerTabProps> = (props) => {
  const [viewMode, setViewMode] = createSignal<'unified' | 'side-by-side'>('unified')
  const [data] = createResource(
    () => ({ path: props.path, projectId: props.projectId, base: props.base, head: props.head }),
    fetchDiff
  )

  const filename = createMemo(() => props.path.split('/').pop() ?? props.path)

  return (
    <div class="flex h-full flex-col overflow-hidden" style={{ background: 'var(--c-bg-primary)' }}>
      {/* Header */}
      <div
        class="flex shrink-0 items-center justify-between border-b px-3 py-1.5 text-sm"
        style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text-secondary)' }}
      >
        <div class="flex items-center gap-2">
          <span>📊</span>
          <span style={{ color: 'var(--c-text-primary)' }}>{filename()}</span>
          <button
            class="rounded px-2 py-0.5 text-xs"
            style={{ background: 'var(--c-bg-tertiary)', color: 'var(--c-text-muted)' }}
            onClick={() => setViewMode((m) => (m === 'unified' ? 'side-by-side' : 'unified'))}
          >
            {viewMode() === 'unified' ? 'Side-by-side' : 'Unified'}
          </button>
        </div>
        <Show when={props.onClose}>
          <button
            class="text-lg leading-none hover:opacity-80"
            style={{ color: 'var(--c-text-muted)' }}
            onClick={props.onClose}
            aria-label="Close tab"
          >
            ×
          </button>
        </Show>
      </div>

      {/* Diff content */}
      <div class="flex-1 overflow-auto">
        <Show when={data.loading}>
          <div class="p-4 text-sm" style={{ color: 'var(--c-text-muted)' }}>
            Loading…
          </div>
        </Show>
        <Show when={data.error}>
          <div class="p-4 text-sm" style={{ color: 'var(--c-error)' }}>
            Error: {(data.error as Error).message}
          </div>
        </Show>
        <Show when={data()}>
          <pre class="m-0 text-sm" style={{ 'font-family': 'var(--font-mono, monospace)' }}>
            <For each={data()!.hunks}>
              {(hunk) => (
                <>
                  <div class="px-3 py-1" style={{ background: 'var(--c-bg-tertiary)', color: 'var(--c-text-muted)' }}>
                    {hunk.header}
                  </div>
                  <For each={hunk.lines}>
                    {(line) => {
                      const lc = lineColors[line.type]
                      return (
                        <div class="flex px-1" style={{ background: lc.bg }}>
                          <span
                            class="w-10 shrink-0 pr-2 text-right select-none"
                            style={{ color: 'var(--c-text-muted)' }}
                          >
                            {line.oldLineNum ?? ''}
                          </span>
                          <span
                            class="w-10 shrink-0 pr-2 text-right select-none"
                            style={{ color: 'var(--c-text-muted)' }}
                          >
                            {line.newLineNum ?? ''}
                          </span>
                          <span class="w-4 shrink-0 select-none" style={{ color: lc.color }}>
                            {lc.prefix}
                          </span>
                          <span class="whitespace-pre" style={{ color: lc.color }}>
                            {line.content}
                          </span>
                        </div>
                      )
                    }}
                  </For>
                </>
              )}
            </For>
          </pre>
        </Show>
      </div>
    </div>
  )
}

export default DiffViewerTab
export { fetchDiff }

import { Component, createResource, Show, For, createMemo } from 'solid-js'

export interface FileViewerTabProps {
  path: string
  projectId: string
  onClose?: () => void
}

interface FileData {
  content: string
  diffMarkers?: Record<number, 'added' | 'modified' | 'removed'>
}

async function fetchFile(params: { path: string; projectId: string }): Promise<FileData> {
  const res = await fetch(
    `/api/files?path=${encodeURIComponent(params.path)}&project=${encodeURIComponent(params.projectId)}`
  )
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.statusText}`)
  return res.json()
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const icons: Record<string, string> = {
    ts: '🟦',
    tsx: '⚛️',
    js: '🟨',
    jsx: '⚛️',
    json: '📋',
    md: '📝',
    css: '🎨',
    html: '🌐',
    py: '🐍',
    rs: '🦀',
    go: '🔵',
    sh: '📜',
    yaml: '⚙️',
    yml: '⚙️',
    toml: '⚙️',
    svg: '🖼️',
    png: '🖼️',
    jpg: '🖼️'
  }
  return icons[ext] ?? '📄'
}

function getFilename(filepath: string): string {
  return filepath.split('/').pop() ?? filepath
}

const FileViewerTab: Component<FileViewerTabProps> = (props) => {
  const [data] = createResource(() => ({ path: props.path, projectId: props.projectId }), fetchFile)
  const lines = createMemo(() => data()?.content?.split('\n') ?? [])
  const diffMarkers = createMemo(() => data()?.diffMarkers ?? {})
  const filename = createMemo(() => getFilename(props.path))

  const gutterMarker = (lineNum: number): string => {
    const marker = diffMarkers()[lineNum]
    if (marker === 'added') return '+'
    if (marker === 'modified') return '~'
    if (marker === 'removed') return '-'
    return ''
  }

  const gutterColor = (lineNum: number): string => {
    const marker = diffMarkers()[lineNum]
    if (marker === 'added') return 'var(--c-success, #22c55e)'
    if (marker === 'modified') return 'var(--c-warning, #f59e0b)'
    if (marker === 'removed') return 'var(--c-error, #ef4444)'
    return 'transparent'
  }

  return (
    <div class="flex h-full flex-col overflow-hidden" style={{ background: 'var(--c-bg-primary)' }}>
      {/* Tab header */}
      <div
        class="flex shrink-0 items-center justify-between border-b px-3 py-1.5 text-sm"
        style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text-secondary)' }}
      >
        <div class="flex items-center gap-2">
          <span>{getFileIcon(filename())}</span>
          <span style={{ color: 'var(--c-text-primary)' }}>{filename()}</span>
          <span
            class="rounded px-1.5 py-0.5 text-xs"
            style={{ background: 'var(--c-bg-tertiary)', color: 'var(--c-text-muted)' }}
          >
            Read Only
          </span>
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

      {/* File content */}
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
          <pre
            class="m-0 text-sm leading-relaxed"
            style={{ 'font-family': 'var(--font-mono, monospace)', color: 'var(--c-text-primary)' }}
          >
            <table class="w-full border-collapse">
              <tbody>
                <For each={lines()}>
                  {(line, i) => (
                    <tr>
                      <td
                        class="w-4 pr-1 text-right select-none"
                        style={{
                          color: gutterColor(i() + 1),
                          'min-width': '1rem',
                          'font-size': '0.7rem'
                        }}
                      >
                        {gutterMarker(i() + 1)}
                      </td>
                      <td
                        class="w-12 pr-3 text-right select-none"
                        style={{ color: 'var(--c-text-muted)', 'user-select': 'none' }}
                      >
                        {i() + 1}
                      </td>
                      <td class="whitespace-pre">{line}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </pre>
        </Show>
      </div>
    </div>
  )
}

export default FileViewerTab
export { getFileIcon, getFilename, fetchFile }

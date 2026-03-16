/**
 * FileChip — Renders a file path as a clickable chip.
 * Usage: <FileChip path="/some/file.md" />
 */

import type { Component } from 'solid-js'

function fileIcon(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const icons: Record<string, string> = {
    md: '📝',
    ts: '🟦',
    tsx: '🟦',
    js: '🟨',
    jsx: '🟨',
    json: '📋',
    css: '🎨',
    html: '🌐',
    py: '🐍',
    sh: '⚡',
    yaml: '⚙️',
    yml: '⚙️',
    env: '🔒'
  }
  return icons[ext] || '📄'
}

function shortName(path: string): string {
  const parts = path.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}

const FileChip: Component<{ path: string; label?: string }> = (props) => {
  return (
    <button
      class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] leading-tight transition-colors"
      style={{
        background: 'var(--c-bg-secondary, rgba(255,255,255,0.05))',
        border: '1px solid var(--c-border)',
        color: 'var(--c-text)',
        cursor: 'pointer'
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        // Copy path to clipboard
        navigator.clipboard.writeText(props.path).catch(() => {})
      }}
      title={props.path}
    >
      <span class="text-[9px]">{fileIcon(props.path)}</span>
      <span class="max-w-[200px] truncate">{props.label || shortName(props.path)}</span>
    </button>
  )
}

export default FileChip

/**
 * Detect file paths in text and return segments.
 * Matches absolute paths (/...) and workspace-relative paths.
 */
export function parseFilePaths(text: string): Array<{ type: 'text' | 'file'; value: string }> {
  const pathRegex = /(?:\/[\w.-]+(?:\/[\w.-]+)*\.\w{1,10}|(?:\.\/|\.\.\/|[\w-]+\/)[\w.\-/]+\.\w{1,10})/g
  const segments: Array<{ type: 'text' | 'file'; value: string }> = []
  let lastIndex = 0

  for (const match of text.matchAll(pathRegex)) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'file', value: match[0] })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return segments.length > 0 ? segments : [{ type: 'text', value: text }]
}

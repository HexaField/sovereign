import type { WorkItem } from '@template/core'

export interface WorkSectionProps {
  workItems: WorkItem[]
  thinkingText?: string
  isComplete: boolean
  class?: string
}

const TOOL_ICONS: Record<string, string> = {
  read: '📖',
  write: '✏️',
  edit: '✂️',
  exec: '▶',
  process: '⚙',
  browser: '🌐',
  web_fetch: '📡',
  memory_search: '🔍',
  memory_get: '📋'
}

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '🔧'
}

export function summarizeWork(items: WorkItem[]): string {
  const toolCalls = items.filter((i) => i.type === 'tool_call').length
  const thinking = items.filter((i) => i.type === 'thinking').length
  const parts: string[] = []
  if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls > 1 ? 's' : ''}`)
  if (thinking > 0) parts.push(`${thinking} thinking block${thinking > 1 ? 's' : ''}`)
  return parts.join(', ') || 'No work items'
}

export function WorkSection(props: WorkSectionProps) {
  return (
    <div
      class={`mb-2 rounded-lg p-3 ${props.class ?? ''}`}
      style={{
        background: 'var(--c-step-bg)',
        border: '1px solid var(--c-work-border)'
      }}
    >
      <div class="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--c-text-muted)' }}>
        <span class="rounded-full px-2 py-0.5 text-xs" style={{ background: 'var(--c-step-badge-bg)' }}>
          {props.workItems.length}
        </span>
        <span>{summarizeWork(props.workItems)}</span>
      </div>
    </div>
  )
}

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

/** Get the icon for a tool by name. Returns 🔧 for unknown tools. */
export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '🔧'
}

/** Summarize work items into a human-readable string */
export function summarizeWork(items: WorkItem[]): string {
  const toolCalls = items.filter((i) => i.type === 'tool_call').length
  const thinking = items.filter((i) => i.type === 'thinking').length
  const parts: string[] = []
  if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls > 1 ? 's' : ''}`)
  if (thinking > 0) parts.push(`${thinking} thinking block${thinking > 1 ? 's' : ''}`)
  return parts.join(', ') || 'No work items'
}

/** Format a duration in ms to a human-readable string */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

/** Determine if content exceeds the collapsible threshold (3 lines) */
export function shouldCollapse(content: string | undefined, lineThreshold = 3): boolean {
  if (!content) return false
  return content.split('\n').length > lineThreshold
}

/** Get status display for a work item */
export function getWorkItemStatus(item: WorkItem): 'running' | 'done' | 'error' {
  if (item.type === 'tool_result') {
    // Check if output contains error indicators
    if (item.output?.startsWith('Error') || item.output?.startsWith('error')) return 'error'
    return 'done'
  }
  if (item.type === 'tool_call' && !item.output) return 'running'
  return 'done'
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
      {/* Summary header - collapsible */}
      <div class="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--c-text-muted)' }}>
        <span class="rounded-full px-2 py-0.5 text-xs" style={{ background: 'var(--c-step-badge-bg)' }}>
          {props.workItems.length}
        </span>
        <span>{summarizeWork(props.workItems)}</span>
        {!props.isComplete && <span class="animate-spin text-xs">⟳</span>}
      </div>

      {/* Work items list */}
      <div class="mt-2 space-y-1">
        {props.workItems.map((item) => (
          <div class="rounded px-2 py-1 text-xs" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
            {item.type === 'tool_call' && (
              <div class="flex items-center gap-1">
                <span>{getToolIcon(item.name ?? '')}</span>
                <span class="font-medium">{item.name}</span>
                {getWorkItemStatus(item) === 'running' && <span class="animate-spin">⟳</span>}
                {getWorkItemStatus(item) === 'error' && <span style={{ color: 'red' }}>✗</span>}
                {getWorkItemStatus(item) === 'done' && <span style={{ color: 'green' }}>✓</span>}
              </div>
            )}
            {item.type === 'tool_result' && (
              <div class="flex items-center gap-1">
                {item.output?.startsWith('Error') ? (
                  <span style={{ color: 'red' }}>✗</span>
                ) : (
                  <span style={{ color: 'green' }}>✓</span>
                )}
                <span class="truncate">{item.output?.slice(0, 100)}</span>
              </div>
            )}
            {item.type === 'thinking' && <div style={{ color: 'var(--c-text-muted)' }}>Thinking…</div>}
            {item.type === 'system_event' && (
              <div style={{ color: 'var(--c-text-muted)' }}>{item.output ?? item.name ?? 'System event'}</div>
            )}
          </div>
        ))}

        {/* Live thinking text */}
        {props.thinkingText && (
          <div class="rounded px-2 py-1 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
            Thinking…
          </div>
        )}
      </div>
    </div>
  )
}

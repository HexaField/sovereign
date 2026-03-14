import { createSignal, For, Show, createMemo } from 'solid-js'
import type { WorkItem } from '@sovereign/core'
import { renderMarkdown } from '../../lib/markdown.js'

// ── Tool icons & labels ──────────────────────────────────────────────
const TOOL_ICONS: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  exec: 'exec',
  process: 'process',
  browser: 'browser',
  web_search: 'search',
  web_fetch: 'fetch',
  cron: 'cron',
  gateway: 'gateway',
  memory_search: 'memory',
  memory_get: 'memory',
  nodes: 'nodes',
  tts: 'tts',
  sessions_spawn: 'spawn',
  sessions_send: 'send',
  sessions_list: 'list',
  sessions_history: 'history',
  session_status: 'status',
  subagents: 'agents',
  agents_list: 'agents'
}

function toolIcon(name: string): string {
  return TOOL_ICONS[name] || 'tool'
}

// ── Exported helpers (used by tests) ─────────────────────────────────
export function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    read: 'read',
    write: 'write',
    edit: 'edit',
    exec: 'exec',
    process: 'process',
    browser: 'browser',
    web_search: 'search',
    web_fetch: 'fetch',
    memory_search: 'search',
    memory_get: 'list',
    cron: 'cron',
    gateway: 'gateway',
    tts: 'tts',
    sessions_spawn: 'spawn',
    sessions_send: 'send',
    sessions_list: 'list',
    sessions_history: 'history',
    session_status: 'status',
    subagents: 'agents',
    agents_list: 'agents',
    nodes: 'nodes'
  }
  return icons[name] || 'tool'
}

export function summarizeWork(items: WorkItem[]): string {
  if (items.length === 0) return 'No work items'
  const toolCalls = items.filter((w) => w.type === 'tool_call').length
  const thinking = items.filter((w) => w.type === 'thinking').length
  const parts: string[] = []
  if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls !== 1 ? 's' : ''}`)
  if (thinking > 0) parts.push(`${thinking} thinking block${thinking !== 1 ? 's' : ''}`)
  return parts.join(', ') || `${items.length} item${items.length !== 1 ? 's' : ''}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export function shouldCollapse(content: string): boolean {
  return content.split('\n').length > 3
}

export function getWorkItemStatus(item: WorkItem): 'running' | 'done' | 'error' {
  if (item.type === 'tool_call' && !item.output) return 'running'
  if (item.type === 'tool_result') {
    if (item.output && (item.output.includes('Error') || item.output.includes('error'))) return 'error'
    return 'done'
  }
  return 'done'
}

// ── Helper: parse input JSON safely ──────────────────────────────────
function parseInput(input?: string): Record<string, unknown> {
  if (!input) return {}
  try {
    return JSON.parse(input)
  } catch {
    return {}
  }
}

// ── Pair tool calls with their results ──────────────────────────────
interface ToolPair {
  call: WorkItem
  result?: WorkItem
}

function pairTools(work: WorkItem[]): Array<WorkItem | ToolPair> {
  const items: Array<WorkItem | ToolPair> = []
  const pendingCalls = new Map<string, ToolPair>()
  const unmatched: ToolPair[] = []

  for (const w of work) {
    if (w.type === 'tool_call') {
      const pair: ToolPair = { call: w }
      if (w.toolCallId) {
        pendingCalls.set(w.toolCallId, pair)
      } else {
        unmatched.push(pair)
      }
      items.push(pair)
    } else if (w.type === 'tool_result') {
      let matched = false
      if (w.toolCallId && pendingCalls.has(w.toolCallId)) {
        pendingCalls.get(w.toolCallId)!.result = w
        pendingCalls.delete(w.toolCallId)
        matched = true
      }
      if (!matched) {
        const idx = unmatched.findIndex((p) => p.call.name === w.name && !p.result)
        if (idx >= 0) {
          unmatched[idx].result = w
        } else {
          items.push(w)
        }
      }
    } else {
      items.push(w)
    }
  }
  return items
}

// ── Main component ──────────────────────────────────────────────────
export function WorkSection(props: { work: WorkItem[] }) {
  const [open, setOpen] = createSignal(false)

  const paired = createMemo(() => pairTools(props.work))

  const preview = () => {
    for (let i = props.work.length - 1; i >= 0; i--) {
      const w = props.work[i]
      if (w.type === 'tool_call') return { icon: toolIcon(w.name || ''), text: w.name || 'tool' }
      if (w.type === 'tool_result') return { icon: '✓', text: w.name || 'tool' }
      if (w.type === 'system_event') {
        const sk = w.icon || 'generic'
        const icons: Record<string, string> = {
          nudge: 'pin',
          supervisor: 'worker',
          memorySave: 'write',
          heartbeat: 'heart',
          compaction: 'broom',
          subagentContext: 'split',
          runtimeContext: 'gear',
          generic: 'list'
        }
        const labels: Record<string, string> = {
          nudge: 'System Nudge',
          supervisor: 'Supervisor',
          memorySave: 'Memory Checkpoint',
          heartbeat: 'Heartbeat',
          compaction: 'Context Compacted',
          subagentContext: 'Subagent Task',
          runtimeContext: 'Runtime Context',
          generic: 'System'
        }
        return { icon: icons[sk] || 'list', text: labels[sk] || 'System' }
      }
      if (w.type === 'thinking') return { icon: 'thought', text: (w.output || w.input || '').slice(0, 60) }
    }
    return { icon: 'gear', text: '' }
  }

  const stepLabel = () => {
    const toolCount = props.work.filter((w) => w.type === 'tool_call' || w.type === 'tool_result').length
    if (toolCount > 0) {
      const calls = Math.ceil(toolCount / 2)
      return `${calls} tool call${calls !== 1 ? 's' : ''}`
    }
    return `${props.work.length} step${props.work.length !== 1 ? 's' : ''}`
  }

  return (
    <div class="my-0.5 max-w-[85%] self-start">
      <div
        class="flex w-fit cursor-pointer items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-xs transition-all select-none"
        style={{ background: 'var(--c-step-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text-muted)' }}
        onClick={() => setOpen(!open())}
      >
        <span class="shrink-0 text-[9px] transition-transform duration-200" classList={{ 'rotate-90': open() }}>
          ▶
        </span>
        <span class="flex items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {preview().icon} {preview().text || stepLabel()}
        </span>
        <span class="shrink-0 rounded-md px-1.5 py-px text-[10px]" style={{ background: 'var(--c-step-badge-bg)' }}>
          {stepLabel()}
        </span>
      </div>

      <Show when={open()}>
        <div class="mt-1.5 overflow-hidden rounded-[10px]" style={{ border: '1px solid var(--c-border)' }}>
          <For each={paired()}>
            {(item) => {
              if ('call' in item) {
                return <ToolPairRow pair={item as ToolPair} />
              }
              const w = item as WorkItem
              if (w.type === 'thinking') {
                return <ThoughtRow text={w.output || w.input || ''} />
              }
              if (w.type === 'system_event') {
                const sk = w.icon || 'generic'
                const iconMap: Record<string, string> = {
                  nudge: 'pin',
                  supervisor: 'worker',
                  memorySave: 'write',
                  heartbeat: 'heart',
                  compaction: 'broom',
                  subagentContext: 'split',
                  runtimeContext: 'gear',
                  generic: 'list'
                }
                const labelMap: Record<string, string> = {
                  nudge: 'System Nudge',
                  supervisor: 'Supervisor',
                  memorySave: 'Memory Checkpoint',
                  heartbeat: 'Heartbeat',
                  compaction: 'Context Compacted',
                  subagentContext: 'Subagent Task',
                  runtimeContext: 'Runtime Context',
                  generic: 'System'
                }
                const icon = iconMap[sk] || 'list'
                const baseLabel = labelMap[sk] || 'System'
                const detail = sk === 'supervisor' ? `: ${(w.output || '').slice(0, 80)}` : ''
                return (
                  <div
                    class="px-3 py-2 text-xs"
                    style={{
                      background: 'var(--c-work-body-bg)',
                      'border-bottom': '1px solid var(--c-border)',
                      color: 'var(--c-text-muted)'
                    }}
                  >
                    {icon} {baseLabel}
                    {detail}
                  </div>
                )
              }
              // Orphaned toolResult
              return <ToolResultContent name={w.name || 'tool'} content={w.output} />
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ── Expandable thought row ──────────────────────────────────────────
const THOUGHT_TRUNCATE = 120
function ThoughtRow(props: { text: string }) {
  const needsTruncation = () => props.text.length > THOUGHT_TRUNCATE
  const [expanded, setExpanded] = createSignal(false)
  const displayText = () =>
    !needsTruncation() || expanded() ? props.text : props.text.slice(0, THOUGHT_TRUNCATE) + '…'

  return (
    <div
      class="px-3 py-2 text-xs leading-relaxed italic"
      style={{
        background: 'var(--c-work-body-bg)',
        'border-bottom': '1px solid var(--c-border)',
        color: 'var(--c-text-muted)',
        cursor: needsTruncation() ? 'pointer' : 'default'
      }}
      onClick={() => needsTruncation() && setExpanded((v) => !v)}
    >
      <span>thought {displayText()}</span>
      <Show when={needsTruncation()}>
        <span class="ml-1" style={{ opacity: 0.5, 'font-style': 'normal', 'font-size': '10px' }}>
          {expanded() ? '▲' : '▼'}
        </span>
      </Show>
    </div>
  )
}

// ── Paired tool call + result row ───────────────────────────────────
function ToolPairRow(props: { pair: ToolPair }) {
  const [expanded, setExpanded] = createSignal(false)
  const call = () => props.pair.call
  const result = () => props.pair.result
  const name = () => call().name || 'tool'
  const callInput = () => parseInput(call().input)
  const hasDetails = () => !!(call().input && Object.keys(callInput()).length > 0) || !!result()?.output

  return (
    <div style={{ 'border-bottom': '1px solid var(--c-border)' }}>
      <div
        class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs select-none"
        style={{ background: 'var(--c-work-body-bg)', color: 'var(--c-text-muted)' }}
        onClick={() => hasDetails() && setExpanded(!expanded())}
      >
        <span class="text-[11px]">{toolIcon(name())}</span>
        <span class="font-mono text-[11px] font-medium" style={{ color: 'var(--c-text)' }}>
          {name()}
        </span>
        <ToolCallSummary name={name()} input={callInput()} />
        <Show when={result()}>
          <span
            class="ml-auto text-[10px]"
            style={{ color: result()?.output?.includes('error') ? '#ef4444' : '#22c55e' }}
          >
            {result()?.output?.includes('error') || result()?.output?.includes('Error') ? '✗' : '✓'}
          </span>
        </Show>
        <Show when={hasDetails()}>
          <span
            class="ml-1 shrink-0 text-[8px] transition-transform duration-200"
            classList={{ 'rotate-90': expanded() }}
          >
            ▶
          </span>
        </Show>
      </div>

      <Show when={expanded() && hasDetails()}>
        <div class="px-3 pb-2 text-xs" style={{ background: 'var(--c-work-body-bg)' }}>
          <ToolDetailView name={name()} input={callInput()} resultContent={result()?.output} />
        </div>
      </Show>
    </div>
  )
}

// ── Inline summary for each tool type ───────────────────────────────
function ToolCallSummary(props: { name: string; input: Record<string, unknown> }) {
  const summary = createMemo(() => {
    const inp = props.input
    if (!inp || Object.keys(inp).length === 0) return ''
    switch (props.name) {
      case 'read':
        return shortPath(str(inp.path || inp.file_path))
      case 'write':
        return shortPath(str(inp.path || inp.file_path))
      case 'edit':
        return shortPath(str(inp.path || inp.file_path))
      case 'exec':
        return truncate(str(inp.command), 60)
      case 'process':
        return `${str(inp.action)} ${str(inp.sessionId || '')}`.trim()
      case 'browser':
        return `${str(inp.action)}${inp.targetUrl ? ' ' + truncate(str(inp.targetUrl), 40) : ''}`
      case 'web_search':
        return truncate(str(inp.query), 50)
      case 'web_fetch':
        return truncate(str(inp.url), 50)
      case 'memory_search':
        return truncate(str(inp.query), 50)
      case 'memory_get':
        return shortPath(str(inp.path))
      case 'cron': {
        const jobObj = inp.job as Record<string, unknown> | undefined
        const jName = str(inp.name || jobObj?.name || inp.jobId || inp.id)
        return `${str(inp.action)}${jName ? ' ' + truncate(jName, 30) : ''}`
      }
      case 'gateway':
        return str(inp.action)
      case 'sessions_spawn':
        return truncate(str(inp.task), 50)
      case 'sessions_send':
        return truncate(str(inp.message), 40)
      case 'tts':
        return truncate(str(inp.text), 40)
      default:
        return ''
    }
  })

  return (
    <Show when={summary()}>
      <span class="max-w-[300px] truncate font-mono text-[10px]" style={{ color: 'var(--c-text-muted)', opacity: 0.7 }}>
        {summary()}
      </span>
    </Show>
  )
}

// ── Rich detail views per tool type ─────────────────────────────────
function ToolDetailView(props: { name: string; input: Record<string, unknown>; resultContent?: string }) {
  const inp = () => props.input || {}

  return (
    <div class="space-y-2">
      {props.name === 'edit' && <EditDetail input={inp()} />}
      {props.name === 'exec' && <ExecDetail input={inp()} result={props.resultContent} />}
      {props.name === 'read' && <ReadDetail input={inp()} result={props.resultContent} />}
      {props.name === 'write' && <WriteDetail input={inp()} />}
      {props.name === 'browser' && <BrowserDetail input={inp()} result={props.resultContent} />}
      {props.name === 'web_search' && <SearchDetail input={inp()} result={props.resultContent} />}
      {props.name === 'web_fetch' && <FetchDetail input={inp()} result={props.resultContent} />}
      {props.name === 'memory_search' && <MemorySearchDetail input={inp()} result={props.resultContent} />}
      {props.name === 'memory_get' && <MemoryGetDetail input={inp()} result={props.resultContent} />}
      {props.name === 'cron' && <CronDetail input={inp()} result={props.resultContent} />}
      {![
        'edit',
        'exec',
        'read',
        'write',
        'browser',
        'web_search',
        'web_fetch',
        'memory_search',
        'memory_get',
        'cron'
      ].includes(props.name) && <GenericDetail input={inp()} result={props.resultContent} />}
    </div>
  )
}

// ── Edit: unified diff ──────────────────────────────────────────────
function EditDetail(props: { input: Record<string, unknown> }) {
  const filePath = () => str(props.input.path || props.input.file_path)
  const oldText = () => str(props.input.old_string || props.input.oldText)
  const newText = () => str(props.input.new_string || props.input.newText)

  return (
    <div>
      <Show when={filePath()}>
        <div class="mb-1 font-mono text-[10px]" style={{ color: 'var(--c-accent)' }}>
          {shortPath(filePath())}
        </div>
      </Show>
      <div
        class="max-h-[300px] overflow-x-auto overflow-y-auto rounded p-2 font-mono text-[11px] leading-relaxed"
        style={{ background: 'rgba(0,0,0,0.3)' }}
      >
        <For each={buildDiffLines(oldText(), newText())}>
          {(line) => (
            <div
              class="whitespace-pre"
              style={{
                color: line.type === 'remove' ? '#f87171' : line.type === 'add' ? '#4ade80' : 'var(--c-text-muted)',
                background:
                  line.type === 'remove'
                    ? 'rgba(239,68,68,0.1)'
                    : line.type === 'add'
                      ? 'rgba(34,197,94,0.1)'
                      : 'transparent'
              }}
            >
              {line.prefix}
              {line.text}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

// ── Exec: command + output ──────────────────────────────────────────
function ExecDetail(props: { input: Record<string, unknown>; result?: string }) {
  const [showFull, setShowFull] = createSignal(false)
  const command = () => str(props.input.command)
  const resultText = () => props.result || ''
  const isLong = () => resultText().length > 500

  return (
    <div>
      <Show when={command()}>
        <div
          class="mb-1 flex items-start gap-1 rounded p-2 font-mono text-[11px]"
          style={{ background: 'rgba(0,0,0,0.3)', color: '#4ade80' }}
        >
          <span style={{ color: 'var(--c-text-muted)' }}>$</span>
          <span class="break-all whitespace-pre-wrap">{command()}</span>
        </div>
      </Show>
      <Show when={props.input.workdir}>
        <div class="mb-1 font-mono text-[9px]" style={{ color: 'var(--c-text-muted)' }}>
          cwd: {shortPath(str(props.input.workdir))}
        </div>
      </Show>
      <Show when={resultText()}>
        <div
          class="overflow-y-auto rounded p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
          style={{
            background: 'rgba(0,0,0,0.2)',
            color: 'var(--c-text-muted)',
            'max-height': showFull() ? '600px' : '200px'
          }}
        >
          {showFull() ? resultText() : resultText().slice(0, 500)}
          <Show when={isLong() && !showFull()}>
            <span class="text-[10px] italic" style={{ color: 'var(--c-accent)' }}>
              {'\n'}… {resultText().length - 500} more chars
            </span>
          </Show>
        </div>
        <Show when={isLong()}>
          <button
            class="mt-0.5 px-1 text-[10px]"
            style={{ color: 'var(--c-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setShowFull(!showFull())}
          >
            {showFull() ? '▲ collapse' : '▼ show full output'}
          </button>
        </Show>
      </Show>
    </div>
  )
}

// ── Read: file content ──────────────────────────────────────────────
function ReadDetail(props: { input: Record<string, unknown>; result?: string }) {
  const [showFull, setShowFull] = createSignal(false)
  const filePath = () => str(props.input.path || props.input.file_path)
  const resultText = () => props.result || ''
  const isLong = () => resultText().length > 500

  return (
    <div>
      <Show when={filePath()}>
        <div class="mb-1 font-mono text-[10px]" style={{ color: 'var(--c-accent)' }}>
          {shortPath(filePath())}
          <Show when={props.input.offset}>
            <span style={{ color: 'var(--c-text-muted)' }}> L{str(props.input.offset)}</span>
          </Show>
          <Show when={props.input.limit}>
            <span style={{ color: 'var(--c-text-muted)' }}> ({str(props.input.limit)} lines)</span>
          </Show>
        </div>
      </Show>
      <Show when={resultText()}>
        <div
          class="overflow-y-auto rounded p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
          style={{
            background: 'rgba(0,0,0,0.2)',
            color: 'var(--c-text-muted)',
            'max-height': showFull() ? '600px' : '200px'
          }}
        >
          {showFull() ? resultText() : resultText().slice(0, 500)}
          <Show when={isLong() && !showFull()}>
            <span class="text-[10px] italic" style={{ color: 'var(--c-accent)' }}>
              {'\n'}… {resultText().length - 500} more chars
            </span>
          </Show>
        </div>
        <Show when={isLong()}>
          <button
            class="mt-0.5 px-1 text-[10px]"
            style={{ color: 'var(--c-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setShowFull(!showFull())}
          >
            {showFull() ? '▲ collapse' : '▼ show full output'}
          </button>
        </Show>
      </Show>
    </div>
  )
}

// ── Write: file path + content preview ──────────────────────────────
function WriteDetail(props: { input: Record<string, unknown> }) {
  const [showFull, setShowFull] = createSignal(false)
  const filePath = () => str(props.input.path || props.input.file_path)
  const content = () => str(props.input.content)
  const isLong = () => content().length > 500

  return (
    <div>
      <Show when={filePath()}>
        <div class="mb-1 font-mono text-[10px]" style={{ color: 'var(--c-accent)' }}>
          {shortPath(filePath())}
        </div>
      </Show>
      <Show when={content()}>
        <div
          class="overflow-y-auto rounded p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
          style={{ background: 'rgba(0,0,0,0.2)', color: '#4ade80', 'max-height': showFull() ? '600px' : '200px' }}
        >
          {showFull() ? content() : content().slice(0, 500)}
          <Show when={isLong() && !showFull()}>
            <span class="text-[10px] italic" style={{ color: 'var(--c-accent)' }}>
              {'\n'}… {content().length - 500} more chars
            </span>
          </Show>
        </div>
        <Show when={isLong()}>
          <button
            class="mt-0.5 px-1 text-[10px]"
            style={{ color: 'var(--c-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setShowFull(!showFull())}
          >
            {showFull() ? '▲ collapse' : '▼ show full output'}
          </button>
        </Show>
      </Show>
    </div>
  )
}

// ── Browser: action + snapshot/screenshot ────────────────────────────
function BrowserDetail(props: { input: Record<string, unknown>; result?: string }) {
  const action = () => str(props.input.action)
  const resultHtml = createMemo(() => {
    if (!props.result) return ''
    return renderMarkdown(props.result.slice(0, 2000))
  })

  return (
    <div>
      <div class="mb-1 flex items-center gap-2 text-[11px]">
        <span class="font-mono font-medium" style={{ color: 'var(--c-text)' }}>
          {action()}
        </span>
        <Show when={props.input.targetUrl}>
          <span class="truncate font-mono text-[10px]" style={{ color: 'var(--c-accent)' }}>
            {truncate(str(props.input.targetUrl), 60)}
          </span>
        </Show>
        <Show when={props.input.ref}>
          <span class="font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            ref={str(props.input.ref)}
          </span>
        </Show>
      </div>
      <Show when={props.input.request}>
        <div
          class="mb-1 rounded p-1.5 font-mono text-[10px]"
          style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--c-text-muted)' }}
        >
          {JSON.stringify(props.input.request, null, 2)}
        </div>
      </Show>
      <Show when={resultHtml()}>
        <div
          class="prose-sm overflow-y-auto rounded p-2 text-[11px] leading-relaxed"
          style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--c-text-muted)', 'max-height': '300px' }}
          innerHTML={resultHtml()}
        />
      </Show>
    </div>
  )
}

// ── Web search: query + results ─────────────────────────────────────
function SearchDetail(props: { input: Record<string, unknown>; result?: string }) {
  const resultHtml = createMemo(() => {
    if (!props.result) return ''
    return renderMarkdown(props.result.slice(0, 3000))
  })

  return (
    <div>
      <div class="mb-1 flex items-center gap-1 text-[11px]">
        <span style={{ color: 'var(--c-text-muted)' }}>query:</span>
        <span class="font-medium" style={{ color: 'var(--c-text)' }}>
          "{str(props.input.query)}"
        </span>
      </div>
      <Show when={resultHtml()}>
        <div
          class="overflow-y-auto rounded p-2 text-[11px] leading-relaxed"
          style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--c-text-muted)', 'max-height': '300px' }}
          innerHTML={resultHtml()}
        />
      </Show>
    </div>
  )
}

// ── Web fetch: URL + content ────────────────────────────────────────
function FetchDetail(props: { input: Record<string, unknown>; result?: string }) {
  const [showFull, setShowFull] = createSignal(false)
  const resultText = () => props.result || ''
  const isLong = () => resultText().length > 800

  return (
    <div>
      <div class="mb-1 font-mono text-[10px]" style={{ color: 'var(--c-accent)' }}>
        {str(props.input.url)}
      </div>
      <Show when={resultText()}>
        <div
          class="overflow-y-auto rounded p-2 text-[11px] leading-relaxed break-all whitespace-pre-wrap"
          style={{
            background: 'rgba(0,0,0,0.2)',
            color: 'var(--c-text-muted)',
            'max-height': showFull() ? '600px' : '200px'
          }}
        >
          {showFull() ? resultText() : resultText().slice(0, 800)}
          <Show when={isLong() && !showFull()}>
            <span class="text-[10px] italic" style={{ color: 'var(--c-accent)' }}>
              {'\n'}… {resultText().length - 800} more chars
            </span>
          </Show>
        </div>
        <Show when={isLong()}>
          <button
            class="mt-0.5 px-1 text-[10px]"
            style={{ color: 'var(--c-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setShowFull(!showFull())}
          >
            {showFull() ? '▲ collapse' : '▼ show full output'}
          </button>
        </Show>
      </Show>
    </div>
  )
}

// ── Memory search: query + snippets ─────────────────────────────────
function MemorySearchDetail(props: { input: Record<string, unknown>; result?: string }) {
  const resultHtml = createMemo(() => {
    if (!props.result) return ''
    return renderMarkdown(props.result.slice(0, 2000))
  })

  return (
    <div>
      <div class="mb-1 flex items-center gap-1 text-[11px]">
        <span style={{ color: 'var(--c-text-muted)' }}>query:</span>
        <span class="font-medium" style={{ color: 'var(--c-text)' }}>
          "{str(props.input.query)}"
        </span>
      </div>
      <Show when={resultHtml()}>
        <div
          class="overflow-y-auto rounded p-2 text-[11px] leading-relaxed"
          style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--c-text-muted)', 'max-height': '300px' }}
          innerHTML={resultHtml()}
        />
      </Show>
    </div>
  )
}

// ── Memory get: path + content ──────────────────────────────────────
function MemoryGetDetail(props: { input: Record<string, unknown>; result?: string }) {
  const [showFull, setShowFull] = createSignal(false)
  const resultText = () => props.result || ''
  const isLong = () => resultText().length > 500

  return (
    <div>
      <div class="mb-1 font-mono text-[10px]" style={{ color: 'var(--c-accent)' }}>
        {shortPath(str(props.input.path))}
        <Show when={props.input.from}>
          <span style={{ color: 'var(--c-text-muted)' }}> L{str(props.input.from)}</span>
        </Show>
      </div>
      <Show when={resultText()}>
        <div
          class="overflow-y-auto rounded p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
          style={{
            background: 'rgba(0,0,0,0.2)',
            color: 'var(--c-text-muted)',
            'max-height': showFull() ? '600px' : '200px'
          }}
        >
          {showFull() ? resultText() : resultText().slice(0, 500)}
          <Show when={isLong() && !showFull()}>
            <span class="text-[10px] italic" style={{ color: 'var(--c-accent)' }}>
              {'\n'}… {resultText().length - 500} more chars
            </span>
          </Show>
        </div>
        <Show when={isLong()}>
          <button
            class="mt-0.5 px-1 text-[10px]"
            style={{ color: 'var(--c-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setShowFull(!showFull())}
          >
            {showFull() ? '▲ collapse' : '▼ show full output'}
          </button>
        </Show>
      </Show>
    </div>
  )
}

// ── Cron: job management ────────────────────────────────────────────
function CronDetail(props: { input: Record<string, unknown>; result?: string }) {
  const action = () => str(props.input.action)
  const job = () => (props.input.job as Record<string, unknown>) || {}
  const jobName = () => str(props.input.name || job().name || props.input.jobId || props.input.id)
  const schedule = () => {
    const j = job()
    const s = j.schedule as Record<string, unknown> | undefined
    if (!s) return ''
    if (s.kind === 'cron') return `cron: ${str(s.expr)}`
    if (s.kind === 'every') return `every ${Math.round(Number(s.everyMs) / 60000)}m`
    if (s.kind === 'at') return `at ${str(s.at)}`
    return ''
  }
  const payload = () => {
    const j = job()
    const p = j.payload as Record<string, unknown> | undefined
    if (!p) return ''
    if (p.kind === 'systemEvent') return str(p.text)
    if (p.kind === 'agentTurn') return str(p.message)
    return ''
  }
  const resultObj = () => {
    if (!props.result) return null
    try {
      return JSON.parse(props.result)
    } catch {
      return null
    }
  }

  return (
    <div>
      <div class="mb-1 flex items-center gap-2">
        <span
          class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
          style={{
            background:
              action() === 'add'
                ? 'rgba(34,197,94,0.15)'
                : action() === 'remove'
                  ? 'rgba(239,68,68,0.15)'
                  : 'rgba(255,255,255,0.08)',
            color: action() === 'add' ? '#4ade80' : action() === 'remove' ? '#f87171' : 'var(--c-text-muted)'
          }}
        >
          {action()}
        </span>
        <Show when={jobName()}>
          <span class="font-mono text-[11px]" style={{ color: 'var(--c-text)' }}>
            {jobName()}
          </span>
        </Show>
      </div>
      <Show when={schedule()}>
        <div class="mb-1 font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
          [scheduled] {schedule()}
        </div>
      </Show>
      <Show when={payload()}>
        <div
          class="overflow-y-auto rounded p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
          style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--c-text-muted)', 'max-height': '200px' }}
        >
          {payload().length > 300 ? payload().slice(0, 300) + '…' : payload()}
        </div>
      </Show>
      <Show when={resultObj()}>
        <div class="mt-1">
          <Show when={resultObj()?.id || resultObj()?.jobId}>
            <div class="font-mono text-[10px]" style={{ color: 'var(--c-accent)' }}>
              id: {str(resultObj()?.id || resultObj()?.jobId)}
            </div>
          </Show>
          <Show when={resultObj()?.state?.nextRunAtMs}>
            <div class="font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              next: {new Date(resultObj().state.nextRunAtMs).toLocaleString()}
            </div>
          </Show>
        </div>
      </Show>
      <Show when={props.result && !resultObj()}>
        <div
          class="mt-1 rounded p-2 font-mono text-[11px] break-all whitespace-pre-wrap"
          style={{
            background: 'rgba(0,0,0,0.2)',
            color: 'var(--c-text-muted)',
            'max-height': '200px',
            'overflow-y': 'auto'
          }}
        >
          {props.result!.slice(0, 500)}
        </div>
      </Show>
    </div>
  )
}

// ── Generic fallback ────────────────────────────────────────────────
function GenericDetail(props: { input: Record<string, unknown>; result?: string }) {
  const [showFull, setShowFull] = createSignal(false)
  const hasInput = () => Object.keys(props.input).length > 0
  const inputJson = () => JSON.stringify(props.input, null, 2)
  const resultText = () => props.result || ''
  const isLong = () => resultText().length > 500

  return (
    <div>
      <Show when={hasInput()}>
        <div
          class="mb-1 max-h-[150px] overflow-y-auto rounded p-2 font-mono text-[10px] whitespace-pre-wrap"
          style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--c-text-muted)' }}
        >
          {inputJson()}
        </div>
      </Show>
      <Show when={resultText()}>
        <div
          class="overflow-y-auto rounded p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
          style={{
            background: 'rgba(0,0,0,0.2)',
            color: 'var(--c-text-muted)',
            'max-height': showFull() ? '600px' : '200px'
          }}
        >
          {showFull() ? resultText() : resultText().slice(0, 500)}
          <Show when={isLong() && !showFull()}>
            <span class="text-[10px] italic" style={{ color: 'var(--c-accent)' }}>
              {'\n'}… {resultText().length - 500} more chars
            </span>
          </Show>
        </div>
        <Show when={isLong()}>
          <button
            class="mt-0.5 px-1 text-[10px]"
            style={{ color: 'var(--c-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setShowFull(!showFull())}
          >
            {showFull() ? '▲ collapse' : '▼ show full output'}
          </button>
        </Show>
      </Show>
    </div>
  )
}

// ── Orphaned tool result ────────────────────────────────────────────
function ToolResultContent(props: { name: string; content?: string }) {
  return (
    <div
      class="px-3 py-2 text-xs"
      style={{
        background: 'var(--c-work-body-bg)',
        'border-bottom': '1px solid var(--c-border)',
        color: 'var(--c-text-muted)'
      }}
    >
      <span class="font-mono text-[11px]">✓ {props.name}</span>
      <Show when={props.content}>
        <div class="mt-1 max-h-20 overflow-hidden font-mono text-[11px] break-all whitespace-pre-wrap">
          {(props.content?.length || 0) > 300 ? props.content!.slice(0, 300) + '…' : props.content}
        </div>
      </Show>
    </div>
  )
}

// ── Utilities ───────────────────────────────────────────────────────

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  return String(v)
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function shortPath(p: string): string {
  if (!p) return ''
  const home = '/Users/josh'
  if (p.startsWith(home)) p = '~' + p.slice(home.length)
  const parts = p.split('/')
  if (parts.length > 4) return '…/' + parts.slice(-3).join('/')
  return p
}

interface DiffLine {
  type: 'context' | 'remove' | 'add'
  prefix: string
  text: string
}

function buildDiffLines(oldText: string, newText: string): DiffLine[] {
  if (!oldText && !newText) return []
  const lines: DiffLine[] = []
  if (oldText) {
    for (const l of oldText.split('\n')) {
      lines.push({ type: 'remove', prefix: '- ', text: l })
    }
  }
  if (newText) {
    for (const l of newText.split('\n')) {
      lines.push({ type: 'add', prefix: '+ ', text: l })
    }
  }
  return lines
}

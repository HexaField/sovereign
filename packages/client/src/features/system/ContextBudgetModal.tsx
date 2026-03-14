// §P.2 Context Budget Modal — shows full LLM context budget breakdown
// Ported from voice-ui's ContextBudgetModal.tsx, adapted for Sovereign/SolidJS

import { type Component, createSignal, onMount, For, Show, createMemo, type JSX } from 'solid-js'
import { SettingsIcon, FilesIcon, TargetIcon, WrenchIcon, ClipboardIcon, BrainIcon } from '../../ui/icons.js'

interface WorkspaceFile {
  name: string
  path: string
  missing: boolean
  rawChars: number
  injectedChars: number
  truncated: boolean
}

interface ToolEntry {
  name: string
  summaryChars: number
  schemaChars: number
  propertiesCount?: number
}

interface SkillEntry {
  name: string
  blockChars: number
}

interface ContextReport {
  source: string
  generatedAt: number
  provider: string
  model: string
  workspaceDir: string
  bootstrapMaxChars: number
  systemPrompt: {
    chars: number
    projectContextChars: number
    nonProjectContextChars: number
  }
  injectedWorkspaceFiles: WorkspaceFile[]
  skills: { promptChars: number; entries: SkillEntry[] }
  tools: { listChars: number; schemaChars: number; entries: ToolEntry[] }
}

interface ContextBudgetData {
  report: ContextReport
  fileContents: Record<string, string>
  session: { contextTokens: number | null }
  disabledTools: Array<{ name: string; disabled: boolean }>
  disabledSkills: Array<{ name: string; disabled: boolean }>
}

export function formatNum(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

export function formatSize(chars: number): string {
  return `${formatNum(chars)} chars (~${formatNum(estimateTokens(chars))} tok)`
}

export function pct(part: number, total: number): string {
  if (total === 0) return '0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

const BarSegment: Component<{ label: string; chars: number; total: number; color: string }> = (props) => {
  const width = () => Math.max(0.5, (props.chars / props.total) * 100)
  return (
    <div
      class="group relative cursor-default"
      style={{ width: `${width()}%`, 'min-width': width() > 2 ? undefined : '4px' }}
    >
      <div class="h-6 rounded-sm" style={{ 'background-color': props.color }} />
      <div
        class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded px-2 py-1 text-[10px] whitespace-nowrap opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
        style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
      >
        <div class="font-medium">{props.label}</div>
        <div>
          {formatSize(props.chars)} · {pct(props.chars, props.total)}
        </div>
      </div>
    </div>
  )
}

const Section: Component<{
  title: string
  icon: JSX.Element
  chars: number
  total: number
  color: string
  defaultOpen?: boolean
  children: any
}> = (props) => {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  return (
    <div class="overflow-hidden rounded-lg border" style={{ 'border-color': 'var(--c-border)' }}>
      <button
        class="flex w-full cursor-pointer items-center gap-2 px-3 py-2"
        style={{ background: 'transparent', border: 'none', color: 'var(--c-text)' }}
        onClick={() => setOpen(!open())}
      >
        <span class="text-[10px]">{open() ? '▼' : '▶'}</span>
        <span class="flex h-4 w-4 shrink-0 items-center">{props.icon}</span>
        <span class="text-xs font-medium">{props.title}</span>
        <span class="ml-auto text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
          {formatSize(props.chars)}
        </span>
        <div
          class="h-2 w-16 overflow-hidden rounded-full"
          style={{ background: 'var(--c-bg)' }}
          title={pct(props.chars, props.total)}
        >
          <div
            class="h-full rounded-full"
            style={{ width: `${(props.chars / props.total) * 100}%`, 'background-color': props.color }}
          />
        </div>
        <span class="w-10 text-right text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
          {pct(props.chars, props.total)}
        </span>
      </button>
      <Show when={open()}>
        <div class="border-t px-3 pb-3" style={{ 'border-color': 'var(--c-border)' }}>
          {props.children}
        </div>
      </Show>
    </div>
  )
}

const FileViewer: Component<{ name: string; content: string; injectedChars: number; rawChars: number }> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  return (
    <div class="mt-1">
      <button
        class="flex cursor-pointer items-center gap-2 text-[11px]"
        style={{ background: 'transparent', border: 'none', color: 'var(--c-text-muted)' }}
        onClick={() => setExpanded(!expanded())}
      >
        <span class="text-[9px]">{expanded() ? '▼' : '▶'}</span>
        <span class="font-mono" style={{ color: 'var(--c-accent)' }}>
          {props.name}
        </span>
        <span>
          {formatNum(props.injectedChars)} chars
          {props.rawChars !== props.injectedChars && ` (raw: ${formatNum(props.rawChars)})`}
        </span>
      </button>
      <Show when={expanded()}>
        <pre
          class="mt-1 max-h-64 overflow-auto rounded p-2 font-mono text-[9px] leading-relaxed whitespace-pre-wrap"
          style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
        >
          {props.content}
        </pre>
      </Show>
    </div>
  )
}

export const ContextBudgetModal: Component<{ onClose: () => void }> = (props) => {
  const [data, setData] = createSignal<ContextBudgetData | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/system/context-budget')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  onMount(fetchData)

  const totalPromptChars = createMemo(() => {
    const d = data()
    if (!d) return 0
    return d.report.systemPrompt.chars + d.report.tools.schemaChars
  })

  const segments = createMemo(() => {
    const d = data()
    if (!d) return []
    const r = d.report
    return [
      { label: 'Core System Prompt', chars: r.systemPrompt.nonProjectContextChars, color: '#3b82f6' },
      ...r.injectedWorkspaceFiles
        .filter((f) => !f.missing)
        .map((f) => ({ label: f.name, chars: f.injectedChars, color: '#8b5cf6' })),
      { label: 'Skills List', chars: r.skills.promptChars, color: '#22c55e' },
      { label: 'Tool Descriptions', chars: r.tools.listChars, color: '#f59e0b' },
      { label: 'Tool Schemas (JSON)', chars: r.tools.schemaChars, color: '#ef4444' }
    ]
  })

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', 'backdrop-filter': 'blur(4px)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div
        class="flex max-h-[85vh] w-[90vw] max-w-[900px] flex-col overflow-hidden rounded-xl shadow-2xl"
        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
      >
        {/* Header */}
        <div class="flex items-center gap-3 border-b px-5 py-3" style={{ 'border-color': 'var(--c-border)' }}>
          <span class="text-lg">
            <BrainIcon size={20} />
          </span>
          <span class="text-sm font-semibold">LLM Context Budget</span>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            Fixed base context injected every turn
          </span>
          <div class="flex-1" />
          <button
            class="cursor-pointer rounded border px-2 py-1 text-[11px] transition-colors"
            style={{ 'border-color': 'var(--c-border)', background: 'transparent', color: 'var(--c-text-muted)' }}
            classList={{ 'pointer-events-none opacity-50': loading() }}
            onClick={fetchData}
          >
            {loading() ? '⟳' : '↻'} Recalculate
          </button>
          <button
            class="cursor-pointer px-2 text-lg"
            style={{ background: 'transparent', border: 'none', color: 'var(--c-text-muted)' }}
            onClick={props.onClose}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div class="flex-1 space-y-4 overflow-y-auto p-5">
          <Show when={loading()}>
            <div class="py-8 text-center" style={{ color: 'var(--c-text-muted)' }}>
              Loading context data…
            </div>
          </Show>

          <Show when={error()}>
            <div class="py-8 text-center text-red-400">{error()}</div>
          </Show>

          <Show when={data()}>
            {(d) => {
              const r = () => d().report
              const total = () => totalPromptChars()
              return (
                <>
                  {/* Summary bar */}
                  <div
                    class="rounded-lg p-4"
                    style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
                  >
                    <div class="mb-3 flex flex-wrap items-baseline gap-4">
                      <div>
                        <div class="text-[10px] tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
                          Base Context
                        </div>
                        <div class="text-xl font-bold">~{formatNum(estimateTokens(total()))} tokens</div>
                        <div class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                          {formatNum(total())} chars
                        </div>
                      </div>
                      <Show when={d().session.contextTokens}>
                        <div>
                          <div class="text-[10px] tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
                            Context Window
                          </div>
                          <div class="text-xl font-bold" style={{ color: '#22c55e' }}>
                            {formatNum(d().session.contextTokens!)} tokens
                          </div>
                          <div class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                            {pct(estimateTokens(total()), d().session.contextTokens!)} used by base
                          </div>
                        </div>
                      </Show>
                      <div>
                        <div class="text-[10px] tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
                          Model
                        </div>
                        <div class="text-sm font-medium">{r().model}</div>
                      </div>
                    </div>

                    {/* Visual bar */}
                    <div class="flex gap-0.5 overflow-hidden rounded" style={{ background: 'var(--c-bg-raised)' }}>
                      <For each={segments().filter((s) => s.chars > 0)}>
                        {(seg) => <BarSegment label={seg.label} chars={seg.chars} total={total()} color={seg.color} />}
                      </For>
                    </div>

                    {/* Legend */}
                    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      <For each={segments().filter((s) => s.chars > 0)}>
                        {(seg) => (
                          <div class="flex items-center gap-1 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                            <div class="h-2 w-2 rounded-sm" style={{ 'background-color': seg.color }} />
                            <span>{seg.label}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>

                  {/* Sections */}
                  <div class="space-y-2">
                    <Section
                      title="Core System Prompt"
                      icon={<SettingsIcon class="h-4 w-4" />}
                      chars={r().systemPrompt.nonProjectContextChars}
                      total={total()}
                      color="#3b82f6"
                    >
                      <div class="mt-2 space-y-0.5 text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                        <div class="flex justify-between">
                          <span>Total system prompt</span>
                          <span class="font-mono">{formatSize(r().systemPrompt.chars)}</span>
                        </div>
                        <div class="flex justify-between">
                          <span>↳ Core (non-project)</span>
                          <span class="font-mono">{formatSize(r().systemPrompt.nonProjectContextChars)}</span>
                        </div>
                        <div class="flex justify-between">
                          <span>↳ Project Context</span>
                          <span class="font-mono">{formatSize(r().systemPrompt.projectContextChars)}</span>
                        </div>
                      </div>
                    </Section>

                    <Section
                      title="Workspace Files (Project Context)"
                      icon={<FilesIcon class="h-4 w-4" />}
                      chars={r().injectedWorkspaceFiles.reduce((sum, f) => sum + (f.missing ? 0 : f.injectedChars), 0)}
                      total={total()}
                      color="#8b5cf6"
                      defaultOpen
                    >
                      <div class="mt-2 mb-1 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                        Bootstrap max per file: {formatNum(r().bootstrapMaxChars)} chars
                      </div>
                      <For each={r().injectedWorkspaceFiles}>
                        {(f) => (
                          <Show
                            when={!f.missing}
                            fallback={
                              <div class="py-0.5 text-[11px] opacity-50" style={{ color: 'var(--c-text-muted)' }}>
                                ○ {f.name} — not found
                              </div>
                            }
                          >
                            <FileViewer
                              name={f.name}
                              content={d().fileContents[f.name] || '(not available)'}
                              injectedChars={f.injectedChars}
                              rawChars={f.rawChars}
                            />
                          </Show>
                        )}
                      </For>
                    </Section>

                    <Section
                      title="Skills Listing"
                      icon={<TargetIcon class="h-4 w-4" />}
                      chars={r().skills.promptChars}
                      total={total()}
                      color="#22c55e"
                    >
                      <div class="mt-2 space-y-0.5">
                        <For each={[...r().skills.entries].sort((a, b) => b.blockChars - a.blockChars)}>
                          {(skill) => (
                            <div class="flex items-center justify-between py-0.5 text-[11px]">
                              <span>{skill.name}</span>
                              <span class="font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                                {formatNum(skill.blockChars)} chars
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Section>

                    <Section
                      title="Tool Descriptions"
                      icon={<WrenchIcon class="h-4 w-4" />}
                      chars={r().tools.listChars}
                      total={total()}
                      color="#f59e0b"
                    >
                      <div class="mt-2 space-y-0.5">
                        <For each={[...r().tools.entries].sort((a, b) => b.summaryChars - a.summaryChars)}>
                          {(tool) => (
                            <div class="flex items-center justify-between py-0.5 text-[11px]">
                              <span>{tool.name}</span>
                              <span class="font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                                {formatNum(tool.summaryChars)} chars
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Section>

                    <Section
                      title="Tool Schemas (JSON)"
                      icon={<ClipboardIcon class="h-4 w-4" />}
                      chars={r().tools.schemaChars}
                      total={total()}
                      color="#ef4444"
                    >
                      <div class="mt-2 space-y-0.5">
                        <For each={[...r().tools.entries].sort((a, b) => b.schemaChars - a.schemaChars)}>
                          {(tool) => (
                            <div class="flex items-center justify-between py-0.5 text-[11px]">
                              <div class="flex items-center gap-2">
                                <span>{tool.name}</span>
                                <Show when={tool.propertiesCount != null}>
                                  <span
                                    class="rounded px-1 text-[9px]"
                                    style={{ background: 'var(--c-bg)', color: 'var(--c-text-muted)' }}
                                  >
                                    {tool.propertiesCount} params
                                  </span>
                                </Show>
                              </div>
                              <span class="font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                                {formatNum(tool.schemaChars)} chars
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Section>
                  </div>

                  <div
                    class="rounded-lg p-3"
                    style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
                  >
                    <div class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                      This is the fixed base context injected into every turn — system prompt, workspace files, skills
                      listing, and tool definitions. The remaining context window is available for conversation history
                      (managed by compaction). Token estimates use ~4 chars/token.
                    </div>
                  </div>
                </>
              )
            }}
          </Show>
        </div>
      </div>
    </div>
  )
}

export default ContextBudgetModal

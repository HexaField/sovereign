// Chat Settings — floating popover for thread info (model, context, cron jobs)
import { createSignal, createEffect, onMount, onCleanup, Show, For } from 'solid-js'
import { Portal } from 'solid-js/web'
import { threadKey } from '../threads/store.js'
import { agentStatus, abortChat } from './store.js'
import { CronManagerModal } from '../crons/CronManagerModal.js'

interface ThreadInfo {
  model: string | null
  modelProvider: string | null
  contextTokens: number | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  compactionCount: number
  thinkingLevel: string | null
  agentStatus: string
  sessionKey: string | null
}

interface CronJob {
  id: string
  name: string
  enabled: boolean
  schedule: { kind: string; expr?: string; everyMs?: number }
  payload: { kind: string; message?: string; text?: string }
  state?: { lastStatus?: string; nextRunAtMs?: number }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatSchedule(s: CronJob['schedule']): string {
  if (s.expr) return s.expr
  if (s.everyMs) {
    const mins = Math.round(s.everyMs / 60000)
    if (mins < 60) return `every ${mins}m`
    const hrs = Math.round(mins / 60)
    return `every ${hrs}h`
  }
  return s.kind
}

function formatNextRun(ms?: number): string {
  if (!ms) return ''
  const diff = ms - Date.now()
  if (diff < 0) return 'overdue'
  if (diff < 60000) return 'in <1m'
  if (diff < 3600000) return `in ${Math.round(diff / 60000)}m`
  return `in ${Math.round(diff / 3600000)}h`
}

export function ChatSettingsButton() {
  const [open, setOpen] = createSignal(false)
  const [info, setInfo] = createSignal<ThreadInfo | null>(null)
  const [crons, setCrons] = createSignal<CronJob[]>([])
  const [loading, setLoading] = createSignal(false)
  const [availableModels, setAvailableModels] = createSignal<string[]>([])
  const [defaultModel, setDefaultModel] = createSignal<string | null>(null)
  const [selectedModel, setSelectedModel] = createSignal<string>('')
  const [modelSaving, setModelSaving] = createSignal(false)
  const [actionFeedback, setActionFeedback] = createSignal('')
  const [cronManagerOpen, setCronManagerOpen] = createSignal(false)
  let containerRef!: HTMLDivElement
  let dropdownRef!: HTMLDivElement

  const fetchData = async () => {
    const key = threadKey()
    if (!key) return
    setLoading(true)
    try {
      // Fetch session info + models in parallel — don't let crons block the menu
      const [infoRes, modelsRes] = await Promise.all([
        fetch(`/api/threads/${encodeURIComponent(key)}/session-info`),
        fetch('/api/models')
      ])
      if (infoRes.ok) {
        const data = await infoRes.json()
        setInfo(data)
        const current = data.modelProvider && data.model ? `${data.modelProvider}/${data.model}` : (data.model ?? '')
        setSelectedModel(current)
      }
      if (modelsRes.ok) {
        const data = await modelsRes.json()
        setAvailableModels(data.models ?? [])
        setDefaultModel(data.defaultModel ?? null)
      }
    } catch {
      /* ignore */
    }
    setLoading(false)

    // Fetch crons independently with a short timeout so a slow/down gateway doesn't block UI
    const key2 = threadKey()
    if (!key2) return
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const cronsRes = await fetch(`/api/threads/${encodeURIComponent(key2)}/crons`, { signal: controller.signal })
      clearTimeout(timeout)
      if (cronsRes.ok) {
        const data = await cronsRes.json()
        setCrons(data.crons ?? [])
      }
    } catch {
      /* crons unavailable — UI still works */
    }
  }

  const handleModelSwitch = async (model: string) => {
    const key = threadKey()
    if (!key || !model) return
    setModelSaving(true)
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(key)}/model`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      })
      if (res.ok) {
        setSelectedModel(model)
        setActionFeedback('Model updated')
      } else {
        setActionFeedback('Failed to update model')
      }
    } catch {
      setActionFeedback('Failed')
    }
    setModelSaving(false)
    setTimeout(() => setActionFeedback(''), 2000)
  }

  const toggle = () => {
    const next = !open()
    setOpen(next)
    if (next) fetchData()
  }

  // Close on click outside
  const handleClickOutside = (e: MouseEvent) => {
    if (
      containerRef &&
      !containerRef.contains(e.target as Node) &&
      (!dropdownRef || !dropdownRef.contains(e.target as Node))
    ) {
      setOpen(false)
    }
  }

  onMount(() => document.addEventListener('mousedown', handleClickOutside))
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))

  const usagePct = () => {
    const i = info()
    if (!i || !i.contextTokens) return 0
    return Math.min(100, Math.round((i.totalTokens / i.contextTokens) * 100))
  }

  // Position dropdown relative to the gear button, clamped to viewport
  createEffect(() => {
    if (!open()) return
    // Double rAF to ensure Portal has mounted the DOM element
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!dropdownRef || !containerRef) return
        const btn = containerRef.querySelector('button')
        if (!btn) return
        const r = btn.getBoundingClientRect()
        const dropW = 280
        let left = r.right - dropW
        if (left < 8) left = 8
        if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8
        let top = r.bottom + 4
        if (top + dropdownRef.offsetHeight > window.innerHeight - 8) top = r.top - dropdownRef.offsetHeight - 4
        dropdownRef.style.left = `${left}px`
        dropdownRef.style.top = `${top}px`
      })
    )
  })

  return (
    <div ref={containerRef} style={{ position: 'relative', 'z-index': '50' }}>
      {/* Gear button — compact for header */}
      <button
        onClick={toggle}
        class="flex cursor-pointer items-center justify-center rounded border-none transition-colors"
        style={{
          width: '24px',
          height: '24px',
          background: open() ? 'var(--c-bg-tertiary, var(--c-hover-bg))' : 'transparent',
          color: 'var(--c-text-muted)',
          'font-size': '13px',
          padding: '0'
        }}
        onMouseEnter={(e) => {
          if (!open()) e.currentTarget.style.background = 'var(--c-bg-tertiary, var(--c-hover-bg))'
        }}
        onMouseLeave={(e) => {
          if (!open()) e.currentTarget.style.background = 'transparent'
        }}
        title="Thread settings"
      >
        ⚙
      </button>

      {/* Dropdown */}
      <Show when={open()}>
        <Portal>
          <div
            ref={dropdownRef}
            class="rounded-xl shadow-2xl"
            style={{
              position: 'fixed',
              'z-index': '999',
              width: '280px',
              background: 'var(--c-bg-raised)',
              border: '1px solid var(--c-border)',
              'max-height': '70vh',
              'overflow-y': 'auto',
              left: '-9999px',
              top: '-9999px'
            }}
          >
            <div style={{ padding: '12px' }}>
              <Show when={loading()}>
                <div class="text-center text-xs" style={{ color: 'var(--c-text-muted)', padding: '8px 0' }}>
                  Loading…
                </div>
              </Show>

              <Show when={!loading() && info()}>
                {(i) => (
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                    {/* Model Selector */}
                    <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                      <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                        Model
                      </span>
                      <Show
                        when={availableModels().length > 0}
                        fallback={
                          <span
                            class="text-xs font-medium"
                            style={{
                              color: 'var(--c-text)',
                              background: 'var(--c-bg)',
                              padding: '1px 8px',
                              'border-radius': '9999px',
                              border: '1px solid var(--c-border)'
                            }}
                          >
                            {selectedModel() || i().model || 'Unknown'}
                          </span>
                        }
                      >
                        <select
                          class="rounded-md text-xs font-medium"
                          style={{
                            background: 'var(--c-bg)',
                            border: '1px solid var(--c-border)',
                            color: 'var(--c-text)',
                            'max-width': '170px',
                            padding: '2px 6px',
                            cursor: 'pointer',
                            opacity: modelSaving() ? '0.5' : '1',
                            'border-radius': '9999px'
                          }}
                          value={selectedModel()}
                          disabled={modelSaving()}
                          onChange={(e) => handleModelSwitch(e.currentTarget.value)}
                        >
                          <For each={availableModels()}>
                            {(m) => (
                              <option value={m} selected={m === selectedModel()}>
                                {m.includes('/') ? m.split('/').pop() : m}
                                {m === defaultModel() ? ' (default)' : ''}
                              </option>
                            )}
                          </For>
                          <Show when={selectedModel() && !availableModels().includes(selectedModel())}>
                            <option value={selectedModel()} selected>
                              {selectedModel().includes('/') ? selectedModel().split('/').pop() : selectedModel()}{' '}
                              (current)
                            </option>
                          </Show>
                        </select>
                      </Show>
                    </div>

                    {/* Feedback */}
                    <Show when={actionFeedback()}>
                      <div class="text-center text-xs" style={{ color: 'var(--c-accent)' }}>
                        {actionFeedback()}
                      </div>
                    </Show>

                    {/* Context usage */}
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          'justify-content': 'space-between',
                          'margin-bottom': '4px'
                        }}
                      >
                        <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                          Context
                        </span>
                        <span class="text-xs" style={{ color: 'var(--c-text)' }}>
                          {(() => {
                            const contextTokens = i().contextTokens
                            return `${formatTokens(i().totalTokens)} / ${contextTokens != null ? formatTokens(contextTokens) : '?'} `
                          })()}
                          <span style={{ color: 'var(--c-text-muted)' }}>({usagePct()}%)</span>
                        </span>
                      </div>
                      <div
                        style={{
                          height: '6px',
                          width: '100%',
                          'border-radius': '9999px',
                          background: 'var(--c-bg)',
                          overflow: 'hidden'
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            'border-radius': '9999px',
                            width: `${usagePct()}%`,
                            background: usagePct() > 80 ? 'var(--c-error, #ef4444)' : 'var(--c-accent)',
                            transition: 'width 0.3s ease'
                          }}
                        />
                      </div>
                    </div>

                    {/* Token breakdown */}
                    <div style={{ display: 'flex', gap: '12px' }}>
                      <div>
                        <div class="text-[10px] uppercase" style={{ color: 'var(--c-text-muted)' }}>
                          In
                        </div>
                        <div class="text-xs font-medium" style={{ color: 'var(--c-text)' }}>
                          {formatTokens(i().inputTokens)}
                        </div>
                      </div>
                      <div>
                        <div class="text-[10px] uppercase" style={{ color: 'var(--c-text-muted)' }}>
                          Out
                        </div>
                        <div class="text-xs font-medium" style={{ color: 'var(--c-text)' }}>
                          {formatTokens(i().outputTokens)}
                        </div>
                      </div>
                      <div>
                        <div class="text-[10px] uppercase" style={{ color: 'var(--c-text-muted)' }}>
                          Compactions
                        </div>
                        <div class="text-xs font-medium" style={{ color: 'var(--c-text)' }}>
                          {i().compactionCount}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Show>

              {/* Cron Jobs */}
              <Show when={crons().length > 0}>
                <div
                  style={{
                    'margin-top': '10px',
                    'padding-top': '10px',
                    'border-top': '1px solid var(--c-border)'
                  }}
                >
                  <div class="text-xs font-medium" style={{ color: 'var(--c-text-heading)', 'margin-bottom': '6px' }}>
                    Cron Jobs ({crons().length})
                  </div>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                    <For each={crons()}>
                      {(job) => (
                        <div
                          class="text-xs"
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '6px',
                            padding: '4px 6px',
                            'border-radius': '6px',
                            background: 'var(--c-bg)',
                            color: 'var(--c-text)'
                          }}
                        >
                          <span
                            style={{
                              width: '6px',
                              height: '6px',
                              'border-radius': '50%',
                              background: job.enabled ? 'var(--c-success, #22c55e)' : 'var(--c-text-muted)',
                              'flex-shrink': '0'
                            }}
                          />
                          <span
                            style={{
                              flex: '1',
                              'min-width': '0',
                              overflow: 'hidden',
                              'text-overflow': 'ellipsis',
                              'white-space': 'nowrap'
                            }}
                          >
                            {job.name || job.id}
                          </span>
                          <span style={{ color: 'var(--c-text-muted)', 'flex-shrink': '0', 'font-size': '10px' }}>
                            {formatSchedule(job.schedule)}
                          </span>
                          <Show when={job.state?.nextRunAtMs}>
                            <span style={{ color: 'var(--c-text-muted)', 'flex-shrink': '0', 'font-size': '10px' }}>
                              {formatNextRun(job.state?.nextRunAtMs)}
                            </span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                  <button
                    class="cursor-pointer text-xs"
                    style={{
                      'margin-top': '6px',
                      padding: '4px 10px',
                      'border-radius': '6px',
                      border: '1px solid var(--c-border)',
                      background: 'transparent',
                      color: 'var(--c-accent)',
                      cursor: 'pointer',
                      'font-weight': '500',
                      width: '100%',
                      'text-align': 'center'
                    }}
                    onClick={() => {
                      setCronManagerOpen(true)
                      setOpen(false)
                    }}
                  >
                    Manage Crons
                  </button>
                </div>
              </Show>

              {/* Manage Crons — always visible even when no per-thread crons */}
              <Show when={crons().length === 0 && !loading()}>
                <div
                  style={{
                    'margin-top': '10px',
                    'padding-top': '10px',
                    'border-top': '1px solid var(--c-border)'
                  }}
                >
                  <button
                    class="cursor-pointer text-xs"
                    style={{
                      padding: '4px 10px',
                      'border-radius': '6px',
                      border: '1px solid var(--c-border)',
                      background: 'transparent',
                      color: 'var(--c-accent)',
                      cursor: 'pointer',
                      'font-weight': '500',
                      width: '100%',
                      'text-align': 'center'
                    }}
                    onClick={() => {
                      setCronManagerOpen(true)
                      setOpen(false)
                    }}
                  >
                    Manage Crons
                  </button>
                </div>
              </Show>

              {/* Stop / Abort button — shown when agent is working */}
              <Show when={agentStatus() !== 'idle'}>
                <div
                  style={{
                    'margin-top': '10px',
                    'padding-top': '10px',
                    'border-top': '1px solid var(--c-border)'
                  }}
                >
                  <button
                    class="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-none px-3 py-2 text-sm font-medium text-white transition-colors"
                    style={{ background: 'var(--c-danger, #ef4444)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.85')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
                    onClick={() => {
                      abortChat()
                      setOpen(false)
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                    Stop
                  </button>
                </div>
              </Show>

              {/* No data state */}
              <Show when={!loading() && !info()}>
                <div class="text-center text-xs" style={{ color: 'var(--c-text-muted)', padding: '8px 0' }}>
                  No session info available
                </div>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>

      {/* Cron Manager Modal */}
      <Show when={cronManagerOpen()}>
        <CronManagerModal threadKey={threadKey() || 'main'} onClose={() => setCronManagerOpen(false)} />
      </Show>
    </div>
  )
}

// Chat Settings — floating popover for thread info (model, context, cron jobs)
import { createSignal, createEffect, onMount, onCleanup, Show, For } from 'solid-js'
import { Portal } from 'solid-js/web'
import { threadKey } from '../threads/store.js'
import { agentStatus, abortChat } from './store.js'
import { CronManagerModal } from '../crons/CronManagerModal.js'
import { isThreadMuted, setThreadMute } from '../threads/mute-store.js'

interface ThreadInfo {
  model: string | null
  modelProvider: string | null
  contextTokens: number | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  compactionCount: number
  thinkingLevel: string | null
  reasoningEffort: string | null
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

interface WatchEntry {
  uuid: string
  threadKey: string
  label: string
  autoDiscovered: boolean
}

interface PerspectiveItem {
  uuid: string
  name: string
  sharedUrl: string | null
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
  const [availableEfforts, setAvailableEfforts] = createSignal<string[]>([])
  const [defaultEffort, setDefaultEffort] = createSignal<string | null>(null)
  const [selectedEffort, setSelectedEffort] = createSignal<string>('')
  const [effortSaving, setEffortSaving] = createSignal(false)
  const [actionFeedback, setActionFeedback] = createSignal('')
  const [cronManagerOpen, setCronManagerOpen] = createSignal(false)
  const [watchedNeighbourhoods, setWatchedNeighbourhoods] = createSignal<WatchEntry[]>([])
  const [allPerspectives, setAllPerspectives] = createSignal<PerspectiveItem[]>([])
  const [ad4mLoaded, setAd4mLoaded] = createSignal(false)
  const [watchInput, setWatchInput] = createSignal('')
  const [watchSaving, setWatchSaving] = createSignal(false)
  let containerRef!: HTMLDivElement
  let dropdownRef!: HTMLDivElement

  const fetchData = async () => {
    const key = threadKey()
    if (!key) return
    setLoading(true)
    try {
      // Fetch session info + models + efforts in parallel — don't let crons block the menu
      const [infoRes, modelsRes, effortsRes] = await Promise.all([
        fetch(`/api/threads/${encodeURIComponent(key)}/session-info`),
        fetch('/api/models'),
        fetch('/api/efforts')
      ])
      if (infoRes.ok) {
        const data = await infoRes.json()
        setInfo(data)
        const current = data.modelProvider && data.model ? `${data.modelProvider}/${data.model}` : (data.model ?? '')
        setSelectedModel(current)
        setSelectedEffort(data.reasoningEffort ?? '')
      }
      if (modelsRes.ok) {
        const data = await modelsRes.json()
        setAvailableModels(data.models ?? [])
        setDefaultModel(data.defaultModel ?? null)
      }
      if (effortsRes.ok) {
        const data = await effortsRes.json()
        setAvailableEfforts(data.efforts ?? [])
        setDefaultEffort(data.defaultEffort ?? null)
        if (!selectedEffort() && data.defaultEffort) setSelectedEffort(data.defaultEffort)
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

    // AD4M neighbourhood watches — best-effort, won't block if AD4M is down
    try {
      const [watchRes, perspRes] = await Promise.all([
        fetch('/api/ad4m/watch/perspectives'),
        fetch('/api/ad4m/perspectives')
      ])
      const currentKey = threadKey()
      if (watchRes.ok) {
        const data = await watchRes.json()
        setWatchedNeighbourhoods((data.watched ?? []).filter((e: WatchEntry) => e.threadKey === currentKey))
      }
      if (perspRes.ok) {
        const data = await perspRes.json()
        setAllPerspectives(data.perspectives ?? [])
      }
      setAd4mLoaded(true)
    } catch {
      /* AD4M not connected — section hidden */
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

  const handleEffortSwitch = async (effort: string) => {
    const key = threadKey()
    if (!key || !effort) return
    setEffortSaving(true)
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(key)}/effort`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ effort })
      })
      if (res.ok) {
        setSelectedEffort(effort)
        setActionFeedback('Reasoning effort updated')
      } else {
        setActionFeedback('Failed to update effort')
      }
    } catch {
      setActionFeedback('Failed')
    }
    setEffortSaving(false)
    setTimeout(() => setActionFeedback(''), 2000)
  }

  // Perspectives not yet watched by this thread (has sharedUrl = is a neighbourhood)
  const unwatchedPerspectives = () => {
    const watchedUuids = new Set(watchedNeighbourhoods().map((e) => e.uuid))
    return allPerspectives().filter((p: PerspectiveItem) => p.sharedUrl && !watchedUuids.has(p.uuid))
  }

  const handleUnwatch = async (uuid: string) => {
    try {
      await fetch(`/api/ad4m/watch/perspectives/${encodeURIComponent(uuid)}`, { method: 'DELETE' })
      setWatchedNeighbourhoods((prev) => prev.filter((e) => e.uuid !== uuid))
    } catch {
      /* ignore */
    }
  }

  const handleWatch = async (uuid: string) => {
    if (!uuid) return
    const key = threadKey()
    const persp = allPerspectives().find((p: PerspectiveItem) => p.uuid === uuid)
    const label = persp?.name || `AD4M: ${uuid.slice(0, 8)}`
    setWatchSaving(true)
    try {
      const res = await fetch('/api/ad4m/watch/perspectives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid, threadKey: key, label })
      })
      if (res.ok) {
        setWatchedNeighbourhoods((prev) => [...prev, { uuid, threadKey: key!, label, autoDiscovered: false }])
        setWatchInput('')
      }
    } catch {
      /* ignore */
    }
    setWatchSaving(false)
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

                    {/* Reasoning Effort Selector */}
                    <Show when={availableEfforts().length > 0}>
                      <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                        <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                          Reasoning
                        </span>
                        <select
                          class="rounded-md text-xs font-medium"
                          style={{
                            background: 'var(--c-bg)',
                            border: '1px solid var(--c-border)',
                            color: 'var(--c-text)',
                            'max-width': '170px',
                            padding: '2px 6px',
                            cursor: 'pointer',
                            opacity: effortSaving() ? '0.5' : '1',
                            'border-radius': '9999px'
                          }}
                          value={selectedEffort()}
                          disabled={effortSaving()}
                          onChange={(e) => handleEffortSwitch(e.currentTarget.value)}
                        >
                          <For each={availableEfforts()}>
                            {(eff) => (
                              <option value={eff} selected={eff === selectedEffort()}>
                                {eff}
                                {eff === defaultEffort() ? ' (default)' : ''}
                              </option>
                            )}
                          </For>
                        </select>
                      </div>
                    </Show>

                    {/* Notifications mute toggle for THIS thread */}
                    <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
                      <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                        Notifications
                      </span>
                      <button
                        type="button"
                        title={isThreadMuted(threadKey()) ? 'Muted — click to unmute' : 'Mute this thread'}
                        aria-label={
                          isThreadMuted(threadKey()) ? 'Unmute thread notifications' : 'Mute thread notifications'
                        }
                        onClick={() => {
                          const id = threadKey()
                          if (id) void setThreadMute(id, !isThreadMuted(id))
                        }}
                        class="flex cursor-pointer items-center justify-center rounded-full border transition-colors"
                        style={{
                          width: '24px',
                          height: '24px',
                          background: isThreadMuted(threadKey()) ? 'var(--c-accent)' : 'var(--c-bg)',
                          'border-color': isThreadMuted(threadKey()) ? 'var(--c-accent)' : 'var(--c-border)',
                          color: isThreadMuted(threadKey()) ? '#fff' : 'var(--c-text-muted)'
                        }}
                      >
                        <Show
                          when={isThreadMuted(threadKey())}
                          fallback={
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 1 0-12 0v5l-2 2v1h16v-1l-2-2z" />
                            </svg>
                          }
                        >
                          {/* Bell with diagonal slash → muted */}
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-10.39-4.09L18 16zm-1.41 4.66L19.78 18 4.22 2.44 2.81 3.85l3.6 3.6A5.96 5.96 0 0 0 6 11v5l-2 2v1h13.59z" />
                          </svg>
                        </Show>
                      </button>
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

              {/* AD4M Neighbourhoods — only shown when AD4M is reachable */}
              <Show when={ad4mLoaded()}>
                <div
                  style={{
                    'margin-top': '10px',
                    'padding-top': '10px',
                    'border-top': '1px solid var(--c-border)'
                  }}
                >
                  <div class="text-xs font-medium" style={{ color: 'var(--c-text-heading)', 'margin-bottom': '6px' }}>
                    AD4M Neighbourhoods
                  </div>

                  {/* Currently watched for this thread */}
                  <Show when={watchedNeighbourhoods().length > 0}>
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', 'margin-bottom': '6px' }}>
                      <For each={watchedNeighbourhoods()}>
                        {(entry) => (
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
                                background: 'var(--c-success, #22c55e)',
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
                              title={entry.uuid}
                            >
                              {entry.label}
                            </span>
                            <button
                              class="cursor-pointer"
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--c-text-muted)',
                                cursor: 'pointer',
                                padding: '0 2px',
                                'flex-shrink': '0',
                                'font-size': '14px',
                                'line-height': '1'
                              }}
                              title="Unwatch"
                              onClick={() => handleUnwatch(entry.uuid)}
                            >
                              ×
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Watch a new neighbourhood — select from joined perspectives */}
                  <Show when={unwatchedPerspectives().length > 0}>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <select
                        value={watchInput()}
                        onChange={(e) => setWatchInput(e.currentTarget.value)}
                        class="text-xs"
                        style={{
                          flex: '1',
                          'min-width': '0',
                          padding: '4px 6px',
                          'border-radius': '6px',
                          border: '1px solid var(--c-border)',
                          background: 'var(--c-bg)',
                          color: watchInput() ? 'var(--c-text)' : 'var(--c-text-muted)'
                        }}
                      >
                        <option value="">Watch neighbourhood…</option>
                        <For each={unwatchedPerspectives()}>
                          {(p) => <option value={p.uuid}>{p.name || p.uuid.slice(0, 8)}</option>}
                        </For>
                      </select>
                      <button
                        class="cursor-pointer text-xs"
                        disabled={!watchInput() || watchSaving()}
                        style={{
                          padding: '4px 8px',
                          'border-radius': '6px',
                          border: '1px solid var(--c-border)',
                          background: watchInput() ? 'var(--c-accent)' : 'transparent',
                          color: watchInput() ? 'white' : 'var(--c-text-muted)',
                          cursor: watchInput() ? 'pointer' : 'default',
                          'font-weight': '500',
                          'flex-shrink': '0'
                        }}
                        onClick={() => handleWatch(watchInput())}
                      >
                        {watchSaving() ? '…' : 'Watch'}
                      </button>
                    </div>
                  </Show>

                  {/* Empty state — AD4M connected but no joined neighbourhoods */}
                  <Show when={watchedNeighbourhoods().length === 0 && unwatchedPerspectives().length === 0}>
                    <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      No joined neighbourhoods
                    </div>
                  </Show>
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

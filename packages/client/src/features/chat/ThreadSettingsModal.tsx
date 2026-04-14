// Thread settings modal — shows session info, actions
import { createSignal, onMount, Show, For } from 'solid-js'
import { abortChat } from '../chat/store.js'
import { threadKey } from '../threads/store.js'
import { CloseIcon } from '../../ui/icons.js'

interface SessionInfo {
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export default function ThreadSettingsModal(props: { onClose: () => void }) {
  const [info, setInfo] = createSignal<SessionInfo | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [actionFeedback, setActionFeedback] = createSignal('')
  const [availableModels, setAvailableModels] = createSignal<string[]>([])
  const [defaultModel, setDefaultModel] = createSignal<string | null>(null)
  const [selectedModel, setSelectedModel] = createSignal<string>('')
  const [modelSaving, setModelSaving] = createSignal(false)

  onMount(async () => {
    const key = threadKey()
    if (!key) {
      setLoading(false)
      return
    }
    try {
      const [infoRes, modelsRes] = await Promise.all([
        fetch(`/api/threads/${encodeURIComponent(key)}/session-info`),
        fetch('/api/models')
      ])
      if (infoRes.ok) {
        const data = await infoRes.json()
        setInfo(data)
        // Build current model string from provider + model
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
  })

  const handleClearLock = async () => {
    const key = threadKey()
    if (!key) return
    try {
      await fetch('/api/threads/clear-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: key })
      })
      setActionFeedback('Lock cleared')
      setTimeout(() => setActionFeedback(''), 2000)
    } catch {
      setActionFeedback('Failed')
    }
  }

  const handleStop = async () => {
    abortChat()
    setActionFeedback('Stop sent')
    setTimeout(() => setActionFeedback(''), 2000)
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

  const usagePct = () => {
    const i = info()
    if (!i || !i.contextTokens) return 0
    return Math.min(100, Math.round((i.totalTokens / i.contextTokens) * 100))
  }

  return (
    <>
      {/* Backdrop */}
      <div class="fixed inset-0 z-[500]" style={{ background: 'rgba(0,0,0,0.4)' }} onClick={props.onClose} />
      {/* Modal */}
      <div
        class="fixed top-1/2 left-1/2 z-[501] w-[380px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl shadow-2xl"
        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
      >
        {/* Header */}
        <div class="flex items-center justify-between border-b px-4 py-3" style={{ 'border-color': 'var(--c-border)' }}>
          <span class="text-sm font-semibold" style={{ color: 'var(--c-text-heading)' }}>
            Thread Settings
          </span>
          <button
            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent"
            style={{ color: 'var(--c-text-muted)' }}
            onClick={props.onClose}
          >
            <CloseIcon class="h-4 w-4" />
          </button>
        </div>

        <div class="space-y-4 p-4">
          {/* Session Info */}
          <Show
            when={!loading() && info()}
            fallback={
              <Show when={loading()}>
                <div class="text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  Loading...
                </div>
              </Show>
            }
          >
            {(i) => (
              <div class="space-y-3">
                {/* Model Selector */}
                <div class="flex items-center justify-between">
                  <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                    Model
                  </span>
                  <Show
                    when={availableModels().length > 0}
                    fallback={
                      <span class="text-xs font-medium" style={{ color: 'var(--c-text)' }}>
                        {selectedModel() || i().model || 'Unknown'}
                      </span>
                    }
                  >
                    <select
                      class="rounded-md px-2 py-1 text-xs font-medium"
                      style={{
                        background: 'var(--c-bg)',
                        border: '1px solid var(--c-border)',
                        color: 'var(--c-text)',
                        'max-width': '200px',
                        cursor: 'pointer',
                        opacity: modelSaving() ? '0.5' : '1'
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
                          {selectedModel().includes('/') ? selectedModel().split('/').pop() : selectedModel()} (current)
                        </option>
                      </Show>
                    </select>
                  </Show>
                </div>

                {/* Provider */}
                <Show when={i().modelProvider}>
                  <div class="flex items-center justify-between">
                    <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      Provider
                    </span>
                    <span class="text-xs" style={{ color: 'var(--c-text)' }}>
                      {i().modelProvider}
                    </span>
                  </div>
                </Show>

                {/* Context Usage Bar */}
                <div>
                  <div class="mb-1 flex items-center justify-between">
                    <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      Context Usage
                    </span>
                    <span class="text-xs" style={{ color: 'var(--c-text)' }}>
                      {(() => {
                        const contextTokens = i().contextTokens
                        return `${formatTokens(i().totalTokens)} / ${contextTokens != null ? formatTokens(contextTokens) : '?'}`
                      })()}
                    </span>
                  </div>
                  <div class="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--c-bg)' }}>
                    <div
                      class="h-full rounded-full transition-all"
                      style={{
                        width: `${usagePct()}%`,
                        background: usagePct() > 80 ? 'var(--c-error, #ef4444)' : 'var(--c-accent)'
                      }}
                    />
                  </div>
                </div>

                {/* Token breakdown */}
                <div class="flex gap-4">
                  <div>
                    <div class="text-[10px] uppercase" style={{ color: 'var(--c-text-muted)' }}>
                      Input
                    </div>
                    <div class="text-xs font-medium" style={{ color: 'var(--c-text)' }}>
                      {formatTokens(i().inputTokens)}
                    </div>
                  </div>
                  <div>
                    <div class="text-[10px] uppercase" style={{ color: 'var(--c-text-muted)' }}>
                      Output
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

                {/* Status */}
                <div class="flex items-center justify-between">
                  <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                    Status
                  </span>
                  <span
                    class="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      background: i().agentStatus === 'idle' ? 'var(--c-bg)' : 'var(--c-warning, #f59e0b)',
                      color: i().agentStatus === 'idle' ? 'var(--c-text-muted)' : 'white'
                    }}
                  >
                    {i().agentStatus}
                  </span>
                </div>
              </div>
            )}
          </Show>

          {/* Actions */}
          <div class="flex gap-2 border-t pt-3" style={{ 'border-color': 'var(--c-border)' }}>
            <button
              class="flex-1 cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
              style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--c-hover-bg)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--c-bg)'
              }}
              onClick={handleStop}
            >
              Stop Agent
            </button>
            <button
              class="flex-1 cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
              style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--c-hover-bg)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--c-bg)'
              }}
              onClick={handleClearLock}
            >
              Clear Lock
            </button>
          </div>

          {/* Feedback */}
          <Show when={actionFeedback()}>
            <div class="text-center text-xs" style={{ color: 'var(--c-accent)' }}>
              {actionFeedback()}
            </div>
          </Show>
        </div>
      </div>
    </>
  )
}

// §6.5 Config Tab — Editable form from config schema
// Fetch GET /api/config and GET /api/config/schema. Save via PATCH /api/config.
// Change history from GET /api/config/history. Hot-reload feedback.

import { createSignal, onMount, Show, For, type Component } from 'solid-js'

export interface ConfigSchemaField {
  key: string
  type: 'string' | 'number' | 'boolean' | 'select'
  label: string
  description?: string
  default?: unknown
  options?: string[] // for select type
}

export interface ConfigHistoryEntry {
  key: string
  oldValue: unknown
  newValue: unknown
  timestamp: string
  source: string
}

export async function fetchConfig(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/config')
  if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`)
  return res.json()
}

export async function fetchConfigSchema(): Promise<ConfigSchemaField[]> {
  const res = await fetch('/api/config/schema')
  if (!res.ok) throw new Error(`Failed to fetch config schema: ${res.status}`)
  return res.json()
}

export async function fetchConfigHistory(): Promise<ConfigHistoryEntry[]> {
  const res = await fetch('/api/config/history')
  if (!res.ok) throw new Error(`Failed to fetch config history: ${res.status}`)
  return res.json()
}

export async function patchConfig(updates: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  })
  if (!res.ok) throw new Error(`Failed to save config: ${res.status}`)
}

const ConfigTab: Component = () => {
  const [config, setConfig] = createSignal<Record<string, unknown>>({})
  const [schema, setSchema] = createSignal<ConfigSchemaField[]>([])
  const [history, setHistory] = createSignal<ConfigHistoryEntry[]>([])
  const [showHistory, setShowHistory] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [feedback, setFeedback] = createSignal<{ type: 'success' | 'error'; message: string } | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  onMount(async () => {
    try {
      const [cfg, sch, hist] = await Promise.all([fetchConfig(), fetchConfigSchema(), fetchConfigHistory()])
      setConfig(cfg)
      setSchema(sch)
      setHistory(hist)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load config')
    }
  })

  const updateField = (key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  const save = async () => {
    setSaving(true)
    setFeedback(null)
    try {
      await patchConfig(config())
      setFeedback({ type: 'success', message: 'Configuration saved — changes applied immediately' })
      // Refresh history
      const hist = await fetchConfigHistory()
      setHistory(hist)
    } catch (e: any) {
      setFeedback({ type: 'error', message: e.message ?? 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="space-y-4">
      {error() && <div class="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>}

      <Show when={feedback()}>
        {(fb) => (
          <div
            class={`rounded border p-3 text-sm ${
              fb().type === 'success'
                ? "border-green-500/30 bg-green-500/10 text-green-400"
                : "border-red-500/30 bg-red-500/10 text-red-400"
            }`}
          >
            {fb().message}
          </div>
        )}
      </Show>

      {/* Config form */}
      <div class="space-y-3">
        <For each={schema()}>
          {(field) => (
            <div
              class="rounded-lg border p-3"
              style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
            >
              <label class="mb-1 block text-sm font-medium">{field.label}</label>
              {field.description && <p class="mb-2 text-xs opacity-50">{field.description}</p>}

              {field.type === 'boolean' ? (
                <label class="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!config()[field.key]}
                    onChange={(e) => updateField(field.key, e.currentTarget.checked)}
                  />
                  <span class="text-sm">{config()[field.key] ? 'Enabled' : 'Disabled'}</span>
                </label>
              ) : field.type === 'select' ? (
                <select
                  class="rounded border px-2 py-1 text-sm"
                  style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
                  value={String(config()[field.key] ?? '')}
                  onChange={(e) => updateField(field.key, e.currentTarget.value)}
                >
                  <For each={field.options ?? []}>{(opt) => <option value={opt}>{opt}</option>}</For>
                </select>
              ) : field.type === 'number' ? (
                <input
                  type="number"
                  class="rounded border px-2 py-1 text-sm"
                  style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
                  value={String(config()[field.key] ?? '')}
                  onInput={(e) => updateField(field.key, Number(e.currentTarget.value))}
                />
              ) : (
                <input
                  type="text"
                  class="w-full rounded border px-2 py-1 text-sm"
                  style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
                  value={String(config()[field.key] ?? '')}
                  onInput={(e) => updateField(field.key, e.currentTarget.value)}
                />
              )}
            </div>
          )}
        </For>
      </div>

      {/* Save button */}
      <Show when={schema().length > 0}>
        <button
          class="rounded px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ background: 'var(--c-accent)' }}
          onClick={save}
          disabled={saving()}
        >
          {saving() ? 'Saving…' : 'Save Configuration'}
        </button>
      </Show>

      {/* Change history (collapsible) */}
      <Show when={history().length > 0}>
        <div class="rounded-lg border" style={{ 'border-color': 'var(--c-border)' }}>
          <button
            class="flex w-full items-center justify-between px-4 py-2 text-sm font-medium"
            onClick={() => setShowHistory(!showHistory())}
          >
            <span>Change History ({history().length})</span>
            <span>{showHistory() ? '▲' : '▼'}</span>
          </button>

          <Show when={showHistory()}>
            <div class="border-t px-4 py-2" style={{ 'border-color': 'var(--c-border)' }}>
              <For each={history()}>
                {(entry) => (
                  <div
                    class="flex items-start gap-3 border-b py-2 text-xs last:border-b-0"
                    style={{ 'border-color': 'var(--c-border)' }}
                  >
                    <span class="shrink-0 opacity-50">{new Date(entry.timestamp).toLocaleString()}</span>
                    <span class="font-medium">{entry.key}</span>
                    <span class="opacity-50">
                      {String(entry.oldValue)} → {String(entry.newValue)}
                    </span>
                    <span class="ml-auto opacity-40">{entry.source}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default ConfigTab

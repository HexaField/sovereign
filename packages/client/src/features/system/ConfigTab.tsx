// Config Tab — all configuration: architecture, membranes, modules, personality+hooks, settings

import { createSignal, onMount, For, Show, type Component } from 'solid-js'

// ── Shared data types ────────────────────────────────────────────────────────

interface ModuleNode {
  name: string
  status: 'healthy' | 'degraded' | 'error'
  subscribes: string[]
  publishes: string[]
}

interface Membrane {
  id: string
  name: string
  workspaceIds: string[]
}

interface Thread {
  id: string
  membraneId?: string
}

interface ActiveSession {
  threadKey: string
  agentStatus: string
  membraneId: string | null
}

interface PersonalityInfo {
  compiledAt: number | null
  size: number
  watcherActive: boolean
  outputPath: string
}

interface HookEvent {
  event: string
  count: number
}

interface HealthConn {
  wsStatus: string
  agentBackend: string
  uptime: number
}

// ── Config editor types (unchanged from before) ──────────────────────────────

interface ConfigSchemaField {
  key: string
  type: 'string' | 'number' | 'boolean' | 'select'
  label: string
  description?: string
  default?: unknown
  options?: string[]
}

interface ConfigHistoryEntry {
  key: string
  oldValue: unknown
  newValue: unknown
  timestamp: string
  source: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MEMBRANE_COLORS: Record<string, string> = {
  personal: '#8b5cf6',
  coasys: '#3b82f6',
  atlas: '#10b981',
  connectionengine: '#f59e0b'
}
const memColor = (id: string) => MEMBRANE_COLORS[id] ?? '#6b7280'

function statusColor(s: string): string {
  if (s === 'healthy' || s === 'connected') return '#22c55e'
  if (s === 'degraded' || s === 'connecting') return '#eab308'
  return '#ef4444'
}

function statusDot(s: string) {
  return <span class="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(s) }} />
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1_048_576).toFixed(0)} MB`
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ms).toLocaleDateString()
}

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// ── Section wrapper ──────────────────────────────────────────────────────────

function Section(props: { title: string; children: any; defaultOpen?: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  return (
    <div class="rounded-lg border" style={{ 'border-color': 'var(--c-border)' }}>
      <button
        class="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold transition-colors hover:opacity-80"
        style={{
          background: 'var(--c-bg-raised)',
          color: 'var(--c-text)',
          'border-radius': open() ? '0.5rem 0.5rem 0 0' : '0.5rem'
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{props.title}</span>
        <span class="text-xs opacity-50">{open() ? '▲' : '▼'}</span>
      </button>
      <Show when={open()}>
        <div class="border-t p-4" style={{ 'border-color': 'var(--c-border)' }}>
          {props.children}
        </div>
      </Show>
    </div>
  )
}

// ── Named exports for tests ──────────────────────────────────────────────────

export async function fetchConfig(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/config')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchConfigSchema(): Promise<ConfigSchemaField[]> {
  const res = await fetch('/api/config/schema')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchConfigHistory(): Promise<ConfigHistoryEntry[]> {
  const res = await fetch('/api/config/history')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function patchConfig(updates: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// ── ConfigTab ────────────────────────────────────────────────────────────────

const ConfigTab: Component = () => {
  // Architecture data
  const [modules, setModules] = createSignal<ModuleNode[]>([])
  const [healthConn, setHealthConn] = createSignal<HealthConn | null>(null)
  const [activeSessions, setActiveSessions] = createSignal<ActiveSession[]>([])

  // Membranes
  const [membranes, setMembranes] = createSignal<Membrane[]>([])
  const [threads, setThreads] = createSignal<Thread[]>([])

  // Personality & Hooks
  const [personality, setPersonality] = createSignal<PersonalityInfo | null>(null)
  const [hooks, setHooks] = createSignal<HookEvent[]>([])

  // Config editor
  const [config, setConfig] = createSignal<Record<string, unknown>>({})
  const [schema, setSchema] = createSignal<ConfigSchemaField[]>([])
  const [history, setHistory] = createSignal<ConfigHistoryEntry[]>([])
  const [showHistory, setShowHistory] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [feedback, setFeedback] = createSignal<{ type: 'success' | 'error'; message: string } | null>(null)

  onMount(async () => {
    const results = await Promise.allSettled([
      fetch('/api/system/architecture').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/system/health').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/system/agents/active').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/membranes').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/threads').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/system/personality').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/system/hooks').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/config').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/config/schema').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/config/history').then((r) => (r.ok ? r.json() : null))
    ])
    const [archR, healthR, agentR, memR, thrR, persR, hooksR, cfgR, schR, histR] = results

    if (archR.status === 'fulfilled' && archR.value) setModules(archR.value.modules ?? [])
    if (healthR.status === 'fulfilled' && healthR.value) setHealthConn(healthR.value.connection ?? null)
    if (agentR.status === 'fulfilled' && agentR.value) setActiveSessions(agentR.value.sessions ?? [])
    if (memR.status === 'fulfilled' && memR.value) setMembranes(memR.value.membranes ?? [])
    if (thrR.status === 'fulfilled' && thrR.value) setThreads(thrR.value.threads ?? thrR.value ?? [])
    if (persR.status === 'fulfilled' && persR.value) setPersonality(persR.value)
    if (hooksR.status === 'fulfilled' && hooksR.value) setHooks(hooksR.value.events ?? [])
    if (cfgR.status === 'fulfilled' && cfgR.value) setConfig(cfgR.value)
    if (schR.status === 'fulfilled' && schR.value) setSchema(schR.value)
    if (histR.status === 'fulfilled' && histR.value) setHistory(histR.value)
  })

  const thrByMem = (id: string) => threads().filter((t) => t.membraneId === id).length
  const activByMem = (id: string) => activeSessions().filter((s) => s.membraneId === id).length
  const backendStatus = () => healthConn()?.agentBackend ?? 'unknown'
  const wsStatus = () => healthConn()?.wsStatus ?? 'unknown'

  const updateField = (key: string, value: unknown) => setConfig((prev) => ({ ...prev, [key]: value }))

  const save = async () => {
    setSaving(true)
    setFeedback(null)
    try {
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config())
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      setFeedback({ type: 'success', message: 'Configuration saved — changes applied immediately' })
      const hist = await fetch('/api/config/history').then((r) => (r.ok ? r.json() : []))
      setHistory(hist)
    } catch (e: unknown) {
      setFeedback({ type: 'error', message: e instanceof Error ? e.message : 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="space-y-3">
      {/* ── Architecture ──────────────────────────────────────────────── */}
      <Section title="Architecture" defaultOpen={true}>
        <div class="space-y-3">
          {/* Root: Sovereign Server */}
          <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)' }}>
            <div class="flex items-center gap-2">
              {statusDot('healthy')}
              <span class="font-semibold" style={{ color: 'var(--c-text)' }}>
                Sovereign Server
              </span>
              <Show when={healthConn()}>
                <span class="ml-auto text-xs opacity-50">uptime {formatUptime(healthConn()!.uptime)} · Node.js</span>
              </Show>
            </div>
            <div class="mt-3 ml-5 space-y-2 border-l pl-4" style={{ 'border-color': 'var(--c-border)' }}>
              <div
                class="rounded border p-2.5"
                style={{ background: 'var(--c-bg-raised)', 'border-color': `${statusColor(backendStatus())}44` }}
              >
                <div class="flex items-center gap-2">
                  {statusDot(backendStatus())}
                  <span class="text-sm font-medium" style={{ color: 'var(--c-text)' }}>
                    Claude Code Backend
                  </span>
                  <span
                    class="ml-auto rounded px-1.5 py-0.5 text-[10px]"
                    style={{ background: `${statusColor(backendStatus())}22`, color: statusColor(backendStatus()) }}
                  >
                    {backendStatus()}
                  </span>
                </div>
                <Show when={activeSessions().length > 0}>
                  <div class="mt-1.5 text-xs opacity-60">
                    {activeSessions().length} active session{activeSessions().length !== 1 ? 's' : ''}
                  </div>
                </Show>
                <div class="mt-2 ml-4 border-l pl-3" style={{ 'border-color': 'var(--c-border)' }}>
                  <div class="flex items-center gap-2 text-xs">
                    {statusDot('healthy')}
                    <span style={{ color: 'var(--c-text-muted)' }}>MCP Sidecar</span>
                    <span class="ml-auto font-mono opacity-40">:5802</span>
                  </div>
                </div>
              </div>
              <div
                class="rounded border p-2.5"
                style={{ background: 'var(--c-bg-raised)', 'border-color': `${statusColor(wsStatus())}44` }}
              >
                <div class="flex items-center gap-2">
                  {statusDot(wsStatus())}
                  <span class="text-sm font-medium" style={{ color: 'var(--c-text)' }}>
                    WebSocket Handler
                  </span>
                  <span
                    class="ml-auto rounded px-1.5 py-0.5 text-[10px]"
                    style={{ background: `${statusColor(wsStatus())}22`, color: statusColor(wsStatus()) }}
                  >
                    {wsStatus()}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Membranes ─────────────────────────────────────────────────── */}
      <Section title={`Membranes (${membranes().length})`} defaultOpen={true}>
        <Show when={membranes().length === 0}>
          <div class="text-sm italic opacity-50">No membranes configured</div>
        </Show>
        <div class="grid gap-3 sm:grid-cols-2">
          <For each={membranes()}>
            {(m) => {
              const color = memColor(m.id)
              const tCount = thrByMem(m.id)
              const aCount = activByMem(m.id)
              return (
                <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg)', 'border-color': `${color}44` }}>
                  <div class="flex items-center gap-2">
                    <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />
                    <span class="font-medium" style={{ color: 'var(--c-text)' }}>
                      {m.name}
                    </span>
                    <span class="ml-auto text-xs opacity-50">{m.id}</span>
                  </div>
                  <div class="mt-1.5 flex gap-3 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                    <span>
                      {tCount} thread{tCount !== 1 ? 's' : ''}
                    </span>
                    <span>
                      {m.workspaceIds.length} workspace{m.workspaceIds.length !== 1 ? 's' : ''}
                    </span>
                    <Show when={aCount > 0}>
                      <span style={{ color }}>● {aCount} active</span>
                    </Show>
                  </div>
                  <Show when={m.workspaceIds.length > 0}>
                    <div class="mt-2 border-t pt-2" style={{ 'border-color': 'var(--c-border)' }}>
                      <For each={m.workspaceIds}>
                        {(ws) => <div class="truncate font-mono text-[10px] opacity-50">{ws}</div>}
                      </For>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Section>

      {/* ── Modules ───────────────────────────────────────────────────── */}
      <Section title={`Module Registry (${modules().length})`}>
        <Show when={modules().length === 0}>
          <div class="text-sm opacity-50">Loading modules…</div>
        </Show>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <For each={modules()}>
            {(mod) => (
              <div
                class="rounded-lg border p-3"
                style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)' }}
              >
                <div class="flex items-center gap-2">
                  <span
                    class={`inline-block h-2 w-2 shrink-0 rounded-full ${mod.status === 'healthy' ? 'bg-green-500' : mod.status === 'degraded' ? 'bg-amber-500' : 'bg-red-500'}`}
                  />
                  <span class="flex-1 truncate text-sm font-medium" style={{ color: 'var(--c-text)' }}>
                    {mod.name}
                  </span>
                  <span class="text-[10px] opacity-50">{mod.status}</span>
                </div>
                <Show when={mod.subscribes.length > 0}>
                  <div class="mt-2 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    <div class="mb-1 opacity-60">Subscribes</div>
                    <div class="flex flex-wrap gap-1">
                      <For each={mod.subscribes}>
                        {(e) => (
                          <span
                            class="rounded px-1 py-0.5 font-mono"
                            style={{ background: 'var(--c-border)', color: 'var(--c-text-muted)' }}
                          >
                            {e}
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
                <Show when={mod.publishes.length > 0}>
                  <div class="mt-2 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    <div class="mb-1 opacity-60">Publishes</div>
                    <div class="flex flex-wrap gap-1">
                      <For each={mod.publishes}>
                        {(e) => (
                          <span
                            class="rounded px-1 py-0.5 font-mono"
                            style={{ background: '#3b82f611', color: '#93c5fd' }}
                          >
                            {e}
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Section>

      {/* ── Personality & Hooks ───────────────────────────────────────── */}
      <Section title="Personality & Hooks">
        <div class="grid gap-4 sm:grid-cols-2">
          {/* Personality */}
          <div>
            <div class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">Personality</div>
            <Show when={personality()} fallback={<div class="text-xs italic opacity-50">Loading…</div>}>
              {(p) => (
                <div class="space-y-1.5 text-sm" style={{ color: 'var(--c-text-muted)' }}>
                  <div class="flex justify-between text-xs">
                    <span>Compiled</span>
                    <span class="font-mono">{p().compiledAt ? formatRelativeTime(p().compiledAt!) : 'never'}</span>
                  </div>
                  <div class="flex justify-between text-xs">
                    <span>Size</span>
                    <span class="font-mono">{formatBytes(p().size)}</span>
                  </div>
                  <div class="flex justify-between text-xs">
                    <span>Watcher</span>
                    <span class={`font-mono ${p().watcherActive ? 'text-green-400' : 'opacity-50'}`}>
                      {p().watcherActive ? 'active' : 'off'}
                    </span>
                  </div>
                  <div class="truncate font-mono text-[10px] opacity-40" title={p().outputPath}>
                    {p().outputPath}
                  </div>
                </div>
              )}
            </Show>
          </div>

          {/* Hooks */}
          <div>
            <div class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">Hooks ({hooks().length})</div>
            <Show when={hooks().length === 0}>
              <div class="text-xs italic opacity-50">No hooks configured</div>
            </Show>
            <div class="space-y-1">
              <For each={hooks()}>
                {(h) => (
                  <div
                    class="flex items-center justify-between rounded border px-2 py-1.5 text-xs"
                    style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)' }}
                  >
                    <span style={{ color: 'var(--c-text)' }}>{h.event}</span>
                    <span class="font-mono opacity-60">
                      {h.count} hook{h.count !== 1 ? 's' : ''}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Settings (Config Editor) ──────────────────────────────────── */}
      <Section title="Settings">
        <div class="space-y-4">
          <Show when={feedback()}>
            {(fb) => (
              <div
                class={`rounded border p-3 text-sm ${fb().type === 'success' ? "border-green-500/30 bg-green-500/10 text-green-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}
              >
                {fb().message}
              </div>
            )}
          </Show>

          <div class="space-y-3">
            <For each={schema()}>
              {(field) => (
                <div
                  class="rounded-lg border p-3"
                  style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)' }}
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
                      style={{
                        background: 'var(--c-bg-raised)',
                        'border-color': 'var(--c-border)',
                        color: 'var(--c-text)'
                      }}
                      value={String(config()[field.key] ?? '')}
                      onChange={(e) => updateField(field.key, e.currentTarget.value)}
                    >
                      <For each={field.options ?? []}>{(opt) => <option value={opt}>{opt}</option>}</For>
                    </select>
                  ) : field.type === 'number' ? (
                    <input
                      type="number"
                      class="rounded border px-2 py-1 text-sm"
                      style={{
                        background: 'var(--c-bg-raised)',
                        'border-color': 'var(--c-border)',
                        color: 'var(--c-text)'
                      }}
                      value={String(config()[field.key] ?? '')}
                      onInput={(e) => updateField(field.key, Number(e.currentTarget.value))}
                    />
                  ) : (
                    <input
                      type="text"
                      class="w-full rounded border px-2 py-1 text-sm"
                      style={{
                        background: 'var(--c-bg-raised)',
                        'border-color': 'var(--c-border)',
                        color: 'var(--c-text)'
                      }}
                      value={String(config()[field.key] ?? '')}
                      onInput={(e) => updateField(field.key, e.currentTarget.value)}
                    />
                  )}
                </div>
              )}
            </For>
          </div>

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
          <Show when={schema().length === 0}>
            <div class="text-xs italic opacity-50">No configurable settings</div>
          </Show>

          <Show when={history().length > 0}>
            <div class="rounded-lg border" style={{ 'border-color': 'var(--c-border)' }}>
              <button
                class="flex w-full items-center justify-between px-4 py-2 text-sm font-medium"
                onClick={() => setShowHistory((h) => !h)}
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
      </Section>
    </div>
  )
}

export default ConfigTab

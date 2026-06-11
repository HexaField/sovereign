// Status Tab — server health at a glance (replaces Overview + Health)

import { createSignal, onMount, onCleanup, Show, For, type Component } from 'solid-js'
import { wsStore } from '../../ws/index.js'
import HealthTimeline from './HealthTimeline.js'
import { formatBytes, formatUptime, fetchHealth, type HealthData } from './HealthTab.js'

interface ArchSummary {
  modules: Array<{ name: string; status: string }>
  system: { os: string; arch: string; cpus: number; totalMemory: number; freeMemory: number; nodeVersion: string }
  skills: { enabled: number; total: number }
  config: { models: string[]; defaultModel: string | null }
}

interface ActiveSession {
  threadKey: string
  agentStatus: string
  label: string
  membraneId: string | null
}

function statusDot(s: string) {
  const color =
    s === 'healthy' || s === 'connected' ? '#22c55e' : s === 'degraded' || s === 'connecting' ? '#eab308' : '#ef4444'
  return <span class="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
}

function Row(props: { label: string; value: string | number; accent?: string }) {
  return (
    <div class="flex justify-between text-xs">
      <span style={{ color: 'var(--c-text-muted)' }}>{props.label}</span>
      <span class="font-mono" style={{ color: props.accent ?? 'var(--c-text)' }}>
        {props.value}
      </span>
    </div>
  )
}

const StatusTab: Component = () => {
  const [health, setHealth] = createSignal<HealthData | null>(null)
  const [arch, setArch] = createSignal<ArchSummary | null>(null)
  const [sessions, setSessions] = createSignal<ActiveSession[]>([])
  const [error, setError] = createSignal<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const load = async () => {
    try {
      const [h, a, ag] = await Promise.all([
        fetchHealth().catch(() => null),
        fetch('/api/system/architecture')
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch('/api/system/agents/active')
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      ])
      if (h) setHealth(h)
      if (a) setArch(a)
      if (ag) setSessions(ag.sessions ?? [])
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
  }

  onMount(() => {
    load()
    wsStore.subscribe(['system'])
    const offHealth = wsStore.on('system.health', (msg: Record<string, unknown>) => {
      const { type: _t, timestamp: _ts, ...data } = msg
      if (data.connection) setHealth(data as unknown as HealthData)
    })
    pollTimer = setInterval(() => {
      if (!wsStore.connected()) load()
    }, 10_000)
    onCleanup(() => {
      offHealth()
      wsStore.unsubscribe(['system'])
      if (pollTimer) clearInterval(pollTimer)
    })
  })

  const working = () => sessions().filter((s) => s.agentStatus === 'working').length
  const thinking = () => sessions().filter((s) => s.agentStatus === 'thinking').length

  return (
    <div class="space-y-6">
      <Show when={error()}>
        <div class="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>
      </Show>

      <div class="grid gap-4 md:grid-cols-3">
        {/* Connection */}
        <div
          class="space-y-2 rounded-lg border p-4"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
        >
          <div class="mb-3 text-xs font-semibold tracking-wide uppercase opacity-60">Connection</div>
          <Show when={health()} fallback={<div class="text-xs opacity-40">Loading…</div>}>
            {(h) => (
              <>
                <div class="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--c-text-muted)' }}>WebSocket</span>
                  <div class="flex items-center gap-1.5">
                    {statusDot(h().connection.wsStatus)}
                    <span class="font-mono">{h().connection.wsStatus}</span>
                  </div>
                </div>
                <div class="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--c-text-muted)' }}>Agent Backend</span>
                  <div class="flex items-center gap-1.5">
                    {statusDot(h().connection.agentBackend)}
                    <span class="font-mono">{h().connection.agentBackend}</span>
                  </div>
                </div>
                <Row label="Uptime" value={formatUptime(h().connection.uptime)} />
                <Row
                  label="Errors (1h)"
                  value={h().errors.countLastHour}
                  accent={h().errors.countLastHour > 0 ? '#ef4444' : undefined}
                />
              </>
            )}
          </Show>
        </div>

        {/* Resources */}
        <div
          class="space-y-2 rounded-lg border p-4"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
        >
          <div class="mb-3 text-xs font-semibold tracking-wide uppercase opacity-60">Resources</div>
          <Show when={health()} fallback={<div class="text-xs opacity-40">Loading…</div>}>
            {(h) => (
              <>
                <Row
                  label="Disk"
                  value={`${formatBytes(h().resources.diskUsage.used)} / ${formatBytes(h().resources.diskUsage.total)}`}
                />
                <Show when={h().resources.memoryUsage}>
                  {(m) => <Row label="Memory" value={`${formatBytes(m().used)} / ${formatBytes(m().total)}`} />}
                </Show>
                <Show when={arch()}>
                  {(a) => (
                    <>
                      <Row
                        label="System mem"
                        value={`${formatBytes(a().system.totalMemory - a().system.freeMemory)} / ${formatBytes(a().system.totalMemory)}`}
                      />
                      <Row label="CPUs" value={a().system.cpus} />
                    </>
                  )}
                </Show>
              </>
            )}
          </Show>
        </div>

        {/* System */}
        <div
          class="space-y-2 rounded-lg border p-4"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
        >
          <div class="mb-3 text-xs font-semibold tracking-wide uppercase opacity-60">System</div>
          <Show when={arch()} fallback={<div class="text-xs opacity-40">Loading…</div>}>
            {(a) => (
              <>
                <Row label="OS" value={a().system.os} />
                <Row label="Arch" value={a().system.arch} />
                <Row label="Node" value={a().system.nodeVersion} />
                <Row label="Skills" value={`${a().skills.enabled} / ${a().skills.total} enabled`} />
                <Show when={a().config.defaultModel}>{(m) => <Row label="Default model" value={m()} />}</Show>
              </>
            )}
          </Show>
        </div>
      </div>

      {/* Active agents quick view */}
      <Show when={sessions().length > 0}>
        <div
          class="rounded-lg border p-4"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
        >
          <div class="mb-3 flex items-center gap-3">
            <span class="text-xs font-semibold tracking-wide uppercase opacity-60">Active Agents</span>
            <Show when={working() > 0}>
              <span class="rounded-full px-2 py-0.5 text-[10px]" style={{ background: '#3b82f622', color: '#3b82f6' }}>
                {working()} working
              </span>
            </Show>
            <Show when={thinking() > 0}>
              <span class="rounded-full px-2 py-0.5 text-[10px]" style={{ background: '#a855f722', color: '#a855f7' }}>
                {thinking()} thinking
              </span>
            </Show>
          </div>
          <div class="flex flex-wrap gap-2">
            <For each={sessions()}>
              {(s) => (
                <div
                  class="flex items-center gap-1.5 rounded border px-2 py-1 text-xs"
                  style={{
                    'border-color': s.agentStatus === 'working' ? '#3b82f655' : '#a855f755',
                    background: 'var(--c-bg)'
                  }}
                >
                  <span
                    class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: s.agentStatus === 'working' ? '#3b82f6' : '#a855f7' }}
                  />
                  <span>{s.label}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Recent errors */}
      <Show when={(health()?.errors.recent.length ?? 0) > 0}>
        <div
          class="rounded-lg border p-4"
          style={{ background: 'var(--c-bg-raised)', 'border-color': 'rgba(239,68,68,0.3)' }}
        >
          <div class="mb-3 text-xs font-semibold tracking-wide uppercase" style={{ color: '#ef4444' }}>
            Recent Errors
          </div>
          <div class="space-y-1">
            <For each={health()!.errors.recent.slice(0, 5)}>
              {(err) => (
                <div class="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">
                  <span class="opacity-60">{new Date(err.timestamp).toLocaleTimeString()}</span> {err.message}
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Timeline: resource charts + stats + events */}
      <HealthTimeline />
    </div>
  )
}

export default StatusTab

// §P.1.1 Overview Tab — Rich system overview with 16 SectionCards
// Replaces the basic module list with collapsible cards showing status, health, and metrics

import { createSignal, onMount, onCleanup, For, Show, type Component } from 'solid-js'
import { SectionCard } from '../../ui/SectionCard.js'
import { wsStore } from '../../ws/index.js'

export interface ArchitectureData {
  modules: Array<{ name: string; status: string; subscribes: string[]; publishes: string[] }>
  config: { models: string[]; defaultModel: string | null }
  sessions: { total: number; byKind: Record<string, number> }
  cron: { jobs: Array<{ name: string; schedule: string; status: string }> }
  skills: { entries: Array<{ name: string; enabled: boolean }>; total: number; enabled: number }
  system: {
    os: string
    arch: string
    platform: string
    cpus: number
    totalMemory: number
    freeMemory: number
    uptime: number
    nodeVersion: string
  }
}

export async function fetchOverviewData(): Promise<ArchitectureData> {
  const res = await fetch('/api/system/architecture')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(0)} MB`
  return `${(bytes / 1073741824).toFixed(1)} GB`
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function moduleHealthStatus(modules: ArchitectureData['modules']): 'healthy' | 'warning' | 'error' {
  if (modules.some((m) => m.status === 'error')) return 'error'
  if (modules.some((m) => m.status === 'degraded')) return 'warning'
  return 'healthy'
}

export interface PlanSummary {
  total: number
  completed: number
  blocked: number
  ready: number
  active: number
  completionPct: number
}

const OverviewTab: Component = () => {
  const [data, setData] = createSignal<ArchitectureData | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [planSummary, setPlanSummary] = createSignal<PlanSummary | null>(null)

  const load = async () => {
    try {
      setData(await fetchOverviewData())
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    load()
    fetch('/api/planning/summary')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setPlanSummary(d)
      })
      .catch(() => {})
    wsStore.subscribe(['system'])

    const offArch = wsStore.on('system.architecture', (msg: Record<string, unknown>) => {
      if (msg.modules) {
        setData((prev) => (prev ? { ...prev, modules: msg.modules as ArchitectureData['modules'] } : prev))
      }
    })

    pollTimer = setInterval(() => {
      if (!wsStore.connected()) load()
    }, 5000)

    onCleanup(() => {
      offArch()
      wsStore.unsubscribe(['system'])
      if (pollTimer) clearInterval(pollTimer)
    })
  })

  return (
    <div>
      <Show when={error()}>
        <div class="mb-4 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>
      </Show>
      <Show when={!data() && !error()}>
        <div class="text-sm opacity-60">Loading overview…</div>
      </Show>
      <Show when={data()}>
        {(d) => {
          const modules = () => d().modules
          const sys = () => d().system
          const cronJobs = () => d().cron.jobs
          const skills = () => d().skills
          const sessions = () => d().sessions
          const config = () => d().config

          const healthyCount = () => modules().filter((m) => m.status === 'healthy').length
          const degradedCount = () => modules().filter((m) => m.status === 'degraded').length
          const errorCount = () => modules().filter((m) => m.status === 'error').length
          const activeCron = () => cronJobs().filter((j) => j.status === 'active').length
          const pausedCron = () => cronJobs().filter((j) => j.status === 'paused').length
          const errorCron = () => cronJobs().filter((j) => j.status === 'error').length
          const memUsedPct = () =>
            sys().totalMemory > 0 ? Math.round(((sys().totalMemory - sys().freeMemory) / sys().totalMemory) * 100) : 0

          return (
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {/* 1. Thread Health */}
              <SectionCard
                title="Thread Health"
                icon="💓"
                status={moduleHealthStatus(modules())}
                badge={sessions().total || undefined}
              >
                <div class="mt-2 space-y-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  <div class="flex justify-between">
                    <span>Total sessions</span>
                    <span class="font-mono">{sessions().total}</span>
                  </div>
                  <For each={Object.entries(sessions().byKind)}>
                    {([kind, count]) => (
                      <div class="flex justify-between">
                        <span>{kind}</span>
                        <span class="font-mono">{count as number}</span>
                      </div>
                    )}
                  </For>
                </div>
              </SectionCard>

              {/* 2. Models */}
              <SectionCard title="Models" icon="🤖" badge={config().models.length || undefined}>
                <div class="mt-2 space-y-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  <Show when={config().defaultModel}>
                    <div class="flex justify-between">
                      <span>Default</span>
                      <span class="font-mono">{config().defaultModel}</span>
                    </div>
                  </Show>
                  <For each={config().models}>{(model) => <div class="font-mono">{model}</div>}</For>
                  <Show when={config().models.length === 0}>
                    <div class="italic opacity-60">No models configured</div>
                  </Show>
                </div>
              </SectionCard>

              {/* 3. Channels */}
              <SectionCard title="Channels" icon="📡">
                <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                  Channel data from gateway not yet wired
                </div>
              </SectionCard>

              {/* 4. Sessions */}
              <SectionCard title="Sessions" icon="🔗" badge={sessions().total || undefined}>
                <div class="mt-2 space-y-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  <div class="flex justify-between">
                    <span>Total</span>
                    <span class="font-mono">{sessions().total}</span>
                  </div>
                  <For each={Object.entries(sessions().byKind)}>
                    {([kind, count]) => (
                      <div class="flex justify-between">
                        <span>{kind}</span>
                        <span class="font-mono">{count as number}</span>
                      </div>
                    )}
                  </For>
                </div>
              </SectionCard>

              {/* 5. Cron Jobs */}
              <SectionCard
                title="Cron Jobs"
                icon="⏰"
                badge={cronJobs().length || undefined}
                status={errorCron() > 0 ? 'error' : pausedCron() > 0 ? 'warning' : 'healthy'}
              >
                <div class="mt-2 space-y-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  <div class="flex justify-between">
                    <span>Active</span>
                    <span class="font-mono">{activeCron()}</span>
                  </div>
                  <div class="flex justify-between">
                    <span>Paused</span>
                    <span class="font-mono">{pausedCron()}</span>
                  </div>
                  <div class="flex justify-between">
                    <span>Error</span>
                    <span class="font-mono">{errorCron()}</span>
                  </div>
                  <Show when={cronJobs().length > 0}>
                    <div class="mt-2 border-t pt-2" style={{ 'border-color': 'var(--c-border)' }}>
                      <For each={cronJobs().slice(0, 5)}>
                        {(job) => (
                          <div class="flex items-center justify-between py-0.5">
                            <span class="truncate">{job.name}</span>
                            <span class="font-mono text-[10px]">{job.status}</span>
                          </div>
                        )}
                      </For>
                      <Show when={cronJobs().length > 5}>
                        <div class="mt-1 text-[10px] opacity-60">+{cronJobs().length - 5} more</div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </SectionCard>

              {/* 6. Skills */}
              <SectionCard
                title="Skills"
                icon="🎯"
                badge={`${skills().enabled}/${skills().total}`}
                status={skills().enabled > 0 ? 'healthy' : 'warning'}
              >
                <div class="mt-2 space-y-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  <div class="flex justify-between">
                    <span>Enabled</span>
                    <span class="font-mono">{skills().enabled}</span>
                  </div>
                  <div class="flex justify-between">
                    <span>Total</span>
                    <span class="font-mono">{skills().total}</span>
                  </div>
                  <Show when={skills().entries.length > 0}>
                    <div class="mt-2 border-t pt-2" style={{ 'border-color': 'var(--c-border)' }}>
                      <For each={skills().entries.slice(0, 8)}>
                        {(skill) => (
                          <div class="flex items-center justify-between py-0.5">
                            <span class="truncate">{skill.name}</span>
                            <span class={`text-[10px] ${skill.enabled ? 'text-green-400' : 'opacity-40'}`}>
                              {skill.enabled ? '●' : '○'}
                            </span>
                          </div>
                        )}
                      </For>
                      <Show when={skills().entries.length > 8}>
                        <div class="mt-1 text-[10px] opacity-60">+{skills().entries.length - 8} more</div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </SectionCard>

              {/* 7. LLM Context */}
              <SectionCard title="LLM Context" icon="🧠">
                <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                  Use the context budget button in the header for detailed breakdown
                </div>
              </SectionCard>

              {/* 8. Hooks */}
              <SectionCard title="Hooks" icon="🪝">
                <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                  Hook data from gateway not yet wired
                </div>
              </SectionCard>

              {/* 9. Context Management */}
              <SectionCard title="Context Management" icon="📊">
                <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                  Compaction stats from gateway not yet wired
                </div>
              </SectionCard>

              {/* 10. Notifications */}
              <SectionCard title="Notifications" icon="🔔">
                <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                  Notification data from gateway not yet wired
                </div>
              </SectionCard>

              {/* 11. Webhooks */}
              <SectionCard title="Webhooks" icon="🌐">
                <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                  Webhook data from gateway not yet wired
                </div>
              </SectionCard>

              {/* 12. Events Pipeline */}
              <SectionCard title="Events Pipeline" icon="⚡">
                <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                  Event pipeline metrics from gateway not yet wired
                </div>
              </SectionCard>

              {/* 13. Security & Devices */}
              <SectionCard title="Security & Devices" icon="🔐">
                <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                  Device and credential data from gateway not yet wired
                </div>
              </SectionCard>

              {/* 14. Scripts */}
              <SectionCard title="Scripts" icon="📜">
                <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                  Script data from gateway not yet wired
                </div>
              </SectionCard>

              {/* 15. System */}
              <SectionCard title="System" icon="🖥️" status="healthy">
                <div class="mt-2 space-y-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  <div class="flex justify-between">
                    <span>OS</span>
                    <span class="font-mono">{sys().os}</span>
                  </div>
                  <div class="flex justify-between">
                    <span>Arch</span>
                    <span class="font-mono">{sys().arch}</span>
                  </div>
                  <div class="flex justify-between">
                    <span>CPUs</span>
                    <span class="font-mono">{sys().cpus}</span>
                  </div>
                  <div class="flex justify-between">
                    <span>Memory</span>
                    <span class="font-mono">
                      {formatBytes(sys().totalMemory - sys().freeMemory)} / {formatBytes(sys().totalMemory)} (
                      {memUsedPct()}%)
                    </span>
                  </div>
                  <div class="flex justify-between">
                    <span>Uptime</span>
                    <span class="font-mono">{formatUptime(sys().uptime)}</span>
                  </div>
                  <div class="flex justify-between">
                    <span>Node</span>
                    <span class="font-mono">{sys().nodeVersion}</span>
                  </div>
                </div>
              </SectionCard>

              {/* 16. Modules (Architecture) */}
              <SectionCard title="Modules" icon="🧩" badge={modules().length} status={moduleHealthStatus(modules())}>
                <div class="mt-2 space-y-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  <div class="flex justify-between">
                    <span>Healthy</span>
                    <span class="font-mono text-green-400">{healthyCount()}</span>
                  </div>
                  <div class="flex justify-between">
                    <span>Degraded</span>
                    <span class="font-mono text-amber-400">{degradedCount()}</span>
                  </div>
                  <div class="flex justify-between">
                    <span>Error</span>
                    <span class="font-mono text-red-400">{errorCount()}</span>
                  </div>
                  <div class="mt-2 border-t pt-2" style={{ 'border-color': 'var(--c-border)' }}>
                    <For each={modules()}>
                      {(mod) => (
                        <div class="flex items-center gap-2 py-0.5">
                          <span
                            class={`inline-block h-1.5 w-1.5 rounded-full ${mod.status === 'healthy' ? 'bg-green-500' : mod.status === 'degraded' ? 'bg-amber-500' : 'bg-red-500'}`}
                          />
                          <span class="truncate">{mod.name}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </SectionCard>

              {/* Plans Sync Status */}
              <SectionCard
                title="Planning"
                icon="📋"
                badge={planSummary()?.total || undefined}
                status={planSummary()?.blocked ? 'warning' : 'healthy'}
              >
                <Show
                  when={planSummary()}
                  fallback={
                    <div class="mt-2 text-xs italic" style={{ color: 'var(--c-text-muted)' }}>
                      No planning data
                    </div>
                  }
                >
                  {(ps) => (
                    <div class="mt-2 space-y-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      <div class="flex justify-between">
                        <span>Total</span>
                        <span class="font-mono">{ps().total}</span>
                      </div>
                      <div class="flex justify-between">
                        <span>Completed</span>
                        <span class="font-mono text-green-400">{ps().completed}</span>
                      </div>
                      <div class="flex justify-between">
                        <span>Active</span>
                        <span class="font-mono text-blue-400">{ps().active}</span>
                      </div>
                      <div class="flex justify-between">
                        <span>Blocked</span>
                        <span class="font-mono text-red-400">{ps().blocked}</span>
                      </div>
                      <div class="flex justify-between">
                        <span>Ready</span>
                        <span class="font-mono text-amber-400">{ps().ready}</span>
                      </div>
                      <div class="mt-2 h-1.5 w-full rounded-full" style={{ background: 'var(--c-border)' }}>
                        <div class="h-full rounded-full bg-green-500" style={{ width: `${ps().completionPct}%` }} />
                      </div>
                      <div class="text-right text-[10px] opacity-60">{ps().completionPct.toFixed(0)}% complete</div>
                    </div>
                  )}
                </Show>
              </SectionCard>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

export default OverviewTab

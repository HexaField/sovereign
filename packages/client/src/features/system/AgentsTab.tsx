// Agents Tab — all threads with active session context health

import { createSignal, onMount, onCleanup, For, Show, type Component } from 'solid-js'
import { ClockIcon } from '../../ui/icons.js'

interface ActiveSession {
  key: string
  threadKey: string
  agentStatus: string
  backendKind: string
  label: string
  membraneId: string | null
}

interface Thread {
  id: string
  label?: string
  membraneId?: string
  lastActivity?: number
  kind?: string
}

interface SessionMeta {
  totalTokens?: number | null
  contextTokens?: number | null
  compactionCount?: number | null
  model?: string | null
  reasoningEffort?: string | null
}

interface AgentRow {
  thread: Thread
  active: ActiveSession | null
  meta: SessionMeta | null
}

interface MembraneOption {
  id: string
  name: string
  color?: string
  icon?: string
}

function membraneColor(id: string, membranes: MembraneOption[]): string {
  const m = membranes.find((x) => x.id === id)
  return m?.color ?? '#6b7280'
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return new Date(ms).toLocaleDateString()
}

function contextPct(meta: SessionMeta | null): number {
  if (!meta?.totalTokens || !meta.contextTokens) return 0
  return Math.min(100, Math.round((meta.totalTokens / meta.contextTokens) * 100))
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function contextBarColor(pct: number): string {
  if (pct > 80) return '#ef4444'
  if (pct > 60) return '#f59e0b'
  return '#22c55e'
}

const KIND_COLORS: Record<string, string> = {
  main: '#3b82f6',
  thread: '#8b5cf6',
  cron: '#f59e0b',
  subagent: '#10b981',
  'event-agent': '#6366f1'
}

const AgentsTab: Component = () => {
  const [threads, setThreads] = createSignal<Thread[]>([])
  const [activeSessions, setActiveSessions] = createSignal<ActiveSession[]>([])
  const [metaMap, setMetaMap] = createSignal<Map<string, SessionMeta>>(new Map())
  const [membranes, setMembranes] = createSignal<MembraneOption[]>([])
  const [editingMembrane, setEditingMembrane] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  const loadMembranes = async () => {
    try {
      const res = await fetch('/api/membranes')
      if (res.ok) {
        const data = await res.json()
        setMembranes(data.membranes ?? [])
      }
    } catch {
      /* best-effort */
    }
  }

  const assignMembrane = async (threadId: string, membraneId: string | null) => {
    try {
      await fetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Empty string clears the membrane (falsy in UI checks)
        body: JSON.stringify({ membraneId: membraneId ?? '' })
      })
      setEditingMembrane(null)
      loadThreadsAndSessions()
    } catch {
      /* best-effort */
    }
  }

  const archiveThread = async (id: string) => {
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (res.ok) loadThreadsAndSessions()
    } catch {
      /* best-effort */
    }
  }

  const loadThreadsAndSessions = async () => {
    try {
      const [thrRes, activeRes] = await Promise.all([
        fetch('/api/threads?active=true').then((r) => (r.ok ? r.json() : { threads: [] })),
        fetch('/api/system/agents/active').then((r) => (r.ok ? r.json() : { sessions: [] }))
      ])
      const thr: Thread[] = thrRes.threads ?? thrRes ?? []
      const sessions: ActiveSession[] = activeRes.sessions ?? []
      setThreads(thr)
      setActiveSessions(sessions)

      // Fetch session meta for all active sessions
      if (sessions.length > 0) {
        const metas = await Promise.allSettled(
          sessions.map((s) =>
            fetch(`/api/threads/${s.threadKey}/session-info`)
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => ({ key: s.threadKey, meta: d as SessionMeta | null }))
          )
        )
        const newMap = new Map<string, SessionMeta>()
        for (const r of metas) {
          if (r.status === 'fulfilled' && r.value?.meta) {
            newMap.set(r.value.key, r.value.meta)
          }
        }
        setMetaMap(newMap)
      }
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    loadMembranes()
    loadThreadsAndSessions()
    pollTimer = setInterval(loadThreadsAndSessions, 5_000)
    onCleanup(() => {
      if (pollTimer) clearInterval(pollTimer)
    })
  })

  const activeByKey = () => {
    const m = new Map<string, ActiveSession>()
    for (const s of activeSessions()) m.set(s.threadKey, s)
    return m
  }

  const rows = (): AgentRow[] => {
    const aMap = activeByKey()
    const all: AgentRow[] = threads().map((t) => ({
      thread: t,
      active: aMap.get(t.id) ?? null,
      meta: metaMap().get(t.id) ?? null
    }))
    // Sort: working first, then thinking, then by lastActivity desc
    return all.sort((a, b) => {
      const order = (row: AgentRow) => {
        if (row.active?.agentStatus === 'working') return 0
        if (row.active?.agentStatus === 'thinking') return 1
        return 2
      }
      const oa = order(a),
        ob = order(b)
      if (oa !== ob) return oa - ob
      return (b.thread.lastActivity ?? 0) - (a.thread.lastActivity ?? 0)
    })
  }

  const workingCount = () => activeSessions().filter((s) => s.agentStatus === 'working').length
  const thinkingCount = () => activeSessions().filter((s) => s.agentStatus === 'thinking').length

  return (
    <div class="space-y-4">
      {/* Header */}
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-bold" style={{ color: 'var(--c-text)' }}>
            Agents
          </h2>
          <Show when={workingCount() > 0}>
            <span
              class="rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ background: '#3b82f622', color: '#3b82f6' }}
            >
              {workingCount()} working
            </span>
          </Show>
          <Show when={thinkingCount() > 0}>
            <span
              class="rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ background: '#a855f722', color: '#a855f7' }}
            >
              {thinkingCount()} thinking
            </span>
          </Show>
        </div>
        <button
          class="rounded border px-3 py-1 text-xs"
          style={{ background: 'transparent', 'border-color': 'var(--c-border)', color: 'var(--c-text-muted)' }}
          onClick={loadThreadsAndSessions}
        >
          Refresh
        </button>
      </div>

      <Show when={error()}>
        <div class="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>
      </Show>

      <Show when={loading() && rows().length === 0}>
        <div class="text-sm opacity-60">Loading agents…</div>
      </Show>

      <div class="space-y-2">
        <For each={rows()}>
          {(row) => {
            const t = row.thread
            const active = row.active
            const meta = row.meta
            const isActive = !!active
            const pct = contextPct(meta)
            const kindColor = KIND_COLORS[t.kind ?? ''] ?? '#6b7280'
            const memId = active?.membraneId ?? t.membraneId
            const label = active?.label ?? t.label ?? t.id
            const mColor = memId ? membraneColor(memId, membranes()) : '#6b7280'

            return (
              <div
                class="group rounded-lg border p-3 transition-colors"
                style={{
                  background: isActive ? 'var(--c-bg-raised)' : 'var(--c-surface, var(--c-bg))',
                  'border-color': isActive
                    ? active.agentStatus === 'working'
                      ? '#3b82f655'
                      : '#a855f755'
                    : 'var(--c-border)'
                }}
              >
                <div class="flex items-start gap-3">
                  {/* Status dot */}
                  <div class="mt-1 shrink-0">
                    <span
                      class="inline-block h-2 w-2 rounded-full"
                      style={{
                        background: !isActive ? '#6b7280' : active.agentStatus === 'working' ? '#3b82f6' : '#a855f7',
                        'box-shadow': isActive
                          ? `0 0 6px ${active.agentStatus === 'working' ? '#3b82f6' : '#a855f7'}`
                          : 'none'
                      }}
                    />
                  </div>

                  <div class="min-w-0 flex-1">
                    {/* Label + badges */}
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="truncate font-medium" style={{ color: 'var(--c-text)' }}>
                        {label}
                      </span>
                      <Show when={t.kind}>
                        <span
                          class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ background: `${kindColor}22`, color: kindColor }}
                        >
                          {t.kind}
                        </span>
                      </Show>
                      {/* Membrane badge — click to edit */}
                      <div class="relative">
                        <Show
                          when={memId}
                          fallback={
                            <button
                              class="cursor-pointer rounded border border-dashed px-1.5 py-0.5 text-[10px] opacity-40 hover:opacity-70"
                              style={{ 'border-color': 'var(--c-text-muted)', color: 'var(--c-text-muted)' }}
                              on:click={() => setEditingMembrane(editingMembrane() === t.id ? null : t.id)}
                              title="Assign membrane"
                            >
                              + membrane
                            </button>
                          }
                        >
                          <button
                            class="cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium hover:ring-1 hover:ring-white/20"
                            style={{ background: `${mColor}22`, color: mColor }}
                            on:click={() => setEditingMembrane(editingMembrane() === t.id ? null : t.id)}
                            title="Change membrane"
                          >
                            {membranes().find((m) => m.id === memId)?.name ?? memId}
                          </button>
                        </Show>
                        <Show when={editingMembrane() === t.id}>
                          {/* Backdrop — catches outside clicks without SolidJS delegation conflicts */}
                          <div class="fixed inset-0 z-40" on:click={() => setEditingMembrane(null)} />
                          <div
                            class="absolute top-full left-0 z-50 mt-1 min-w-[140px] rounded-lg border py-1 shadow-lg"
                            style={{
                              background: 'var(--c-bg-raised, var(--c-bg))',
                              'border-color': 'var(--c-border)'
                            }}
                          >
                            <For each={membranes()}>
                              {(m) => (
                                <button
                                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/5"
                                  style={{
                                    color: m.id === memId ? (m.color ?? 'var(--c-text)') : 'var(--c-text)',
                                    'font-weight': m.id === memId ? '600' : '400'
                                  }}
                                  on:click={() => assignMembrane(t.id, m.id)}
                                >
                                  <span
                                    class="inline-block h-2 w-2 shrink-0 rounded-full"
                                    style={{ background: m.color ?? '#6b7280' }}
                                  />
                                  {m.name}
                                </button>
                              )}
                            </For>
                            <Show when={memId}>
                              <div class="mx-2 my-1 border-t" style={{ 'border-color': 'var(--c-border)' }} />
                              <button
                                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/5"
                                style={{ color: 'var(--c-text-muted)' }}
                                on:click={() => assignMembrane(t.id, null)}
                              >
                                <span
                                  class="inline-block h-2 w-2 shrink-0 rounded-full border"
                                  style={{ 'border-color': 'var(--c-text-muted)' }}
                                />
                                None
                              </button>
                            </Show>
                          </div>
                        </Show>
                      </div>
                      <Show when={isActive && meta?.model}>
                        <span class="text-[10px] opacity-50">{meta!.model}</span>
                      </Show>
                      <Show when={isActive && active?.agentStatus}>
                        <span
                          class="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: active!.agentStatus === 'working' ? '#3b82f622' : '#a855f722',
                            color: active!.agentStatus === 'working' ? '#3b82f6' : '#a855f7'
                          }}
                        >
                          {active!.agentStatus}
                        </span>
                      </Show>
                    </div>

                    {/* Context bar (active sessions only) */}
                    <Show when={isActive && meta?.contextTokens}>
                      <div class="mt-2 space-y-1">
                        <div
                          class="flex items-center justify-between text-[10px]"
                          style={{ color: 'var(--c-text-muted)' }}
                        >
                          <span>Context</span>
                          <span class="font-mono">
                            {formatTokens(meta!.totalTokens ?? 0)} / {formatTokens(meta!.contextTokens!)} ({pct}%)
                          </span>
                        </div>
                        <div class="h-1 w-full overflow-hidden rounded-full" style={{ background: 'var(--c-border)' }}>
                          <div
                            class="h-full rounded-full transition-all"
                            style={{ width: `${pct}%`, background: contextBarColor(pct) }}
                          />
                        </div>
                      </div>
                    </Show>

                    {/* Footer row */}
                    <div class="mt-1.5 flex items-center gap-3 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                      <Show when={isActive && meta?.compactionCount != null && meta.compactionCount! > 0}>
                        <span class="rounded px-1 py-0.5" style={{ background: 'var(--c-border)' }}>
                          {meta!.compactionCount} compact{meta!.compactionCount !== 1 ? 'ions' : 'ion'}
                        </span>
                      </Show>
                      <Show when={isActive && meta?.reasoningEffort}>
                        <span class="opacity-60">effort: {meta!.reasoningEffort}</span>
                      </Show>
                      <div class="ml-auto flex items-center gap-2">
                        <Show when={t.lastActivity}>
                          <span class="flex items-center gap-1 opacity-60">
                            <ClockIcon class="h-3 w-3" />
                            {formatRelativeTime(t.lastActivity!)}
                          </span>
                        </Show>
                        <button
                          class="opacity-0 transition-opacity group-hover:opacity-50 hover:!opacity-100"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: 'var(--c-text-muted)',
                            'font-size': '11px',
                            padding: '0 2px',
                            'line-height': '1'
                          }}
                          title="Archive thread"
                          onClick={(e) => {
                            e.stopPropagation()
                            archiveThread(t.id)
                          }}
                        >
                          🗃
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          }}
        </For>
        <Show when={rows().length === 0 && !loading()}>
          <div class="py-8 text-center text-sm opacity-60">No threads found</div>
        </Show>
      </div>
    </div>
  )
}

export default AgentsTab

// §6.9 Threads Tab — View all gateway sessions, assign to workspaces
import { createSignal, onMount, For, Show, type Component } from 'solid-js'
import { fetchThreadsForOrg } from '../threads/store.js'

interface GatewaySession {
  key: string
  shortKey: string
  label?: string
  localLabel?: string
  kind?: string
  lastActivity?: number
  agentStatus?: string
  orgId?: string
  isRegistered?: boolean
}

interface OrgInfo {
  orgId: string
  name: string
}

const ThreadsTab: Component = () => {
  const [sessions, setSessions] = createSignal<GatewaySession[]>([])
  const [orgs, setOrgs] = createSignal<OrgInfo[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [moving, setMoving] = createSignal<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [sessionsRes, orgsRes] = await Promise.all([fetch('/api/threads/gateway-sessions'), fetch('/api/orgs')])
      if (!sessionsRes.ok) throw new Error(`Sessions: HTTP ${sessionsRes.status}`)
      if (!orgsRes.ok) throw new Error(`Orgs: HTTP ${orgsRes.status}`)
      const sessionsData = await sessionsRes.json()
      const orgsData = await orgsRes.json()
      setSessions((sessionsData.sessions ?? []).filter((s: any) => s.key))
      setOrgs(
        (orgsData.orgs ?? orgsData ?? []).map((o: any) => ({
          orgId: o.orgId ?? o.id,
          name: o.name ?? o.orgId ?? o.id
        }))
      )
      setError(null)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  onMount(load)

  const unassigned = () => sessions().filter((s) => !s.orgId || s.orgId === '_global')
  const assigned = () => sessions().filter((s) => s.orgId && s.orgId !== '_global')

  const orgName = (orgId: string) => {
    if (!orgId || orgId === '_global') return 'Global'
    const org = orgs().find((o) => o.orgId === orgId)
    return org?.name ?? orgId
  }

  const assignSession = async (fullKey: string, shortKey: string, orgId: string) => {
    setMoving(fullKey)
    try {
      const res = await fetch(`/api/threads/${shortKey}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId })
      })
      if (!res.ok) {
        // Thread might not exist locally yet — create it
        const createRes = await fetch('/api/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: shortKey, orgId, label: shortKey })
        })
        if (!createRes.ok) throw new Error(`HTTP ${createRes.status}`)
      }
      await load()
      fetchThreadsForOrg()
    } catch (e: any) {
      setError(e.message ?? 'Failed to assign')
    } finally {
      setMoving(null)
    }
  }

  const displayLabel = (s: GatewaySession) => s.localLabel || s.label || s.key
  const lastActive = (s: GatewaySession) => {
    if (!s.lastActivity) return ''
    const d = new Date(s.lastActivity)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const kindBadge = (s: GatewaySession) => {
    if (!s.kind) return null
    const colors: Record<string, string> = {
      main: '#3b82f6',
      thread: '#8b5cf6',
      cron: '#f59e0b',
      'cron-run': '#f59e0b',
      subagent: '#10b981',
      'event-agent': '#6366f1'
    }
    return { text: s.kind, color: colors[s.kind] ?? 'var(--c-text-muted)' }
  }

  const SessionRow = (props: { session: GatewaySession; showAssign: boolean; showMove: boolean }) => {
    const s = props.session
    const badge = kindBadge(s)
    return (
      <div
        class="flex items-center justify-between rounded px-3 py-2"
        style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)' }}
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-sm font-medium" style={{ color: 'var(--c-text)' }}>
              {displayLabel(s)}
            </span>
            {badge && (
              <span
                class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{ background: `${badge.color}22`, color: badge.color }}
              >
                {badge.text}
              </span>
            )}
            {!s.isRegistered && (
              <span
                class="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                style={{ background: 'var(--c-warning-bg, #78350f)', color: 'var(--c-warning, #fbbf24)' }}
              >
                gateway only
              </span>
            )}
          </div>
          <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            {s.orgId && s.orgId !== '_global' ? `${orgName(s.orgId!)} · ` : ''}
            {s.key !== displayLabel(s) ? `${s.key} · ` : ''}
            {lastActive(s)}
          </div>
        </div>
        <div class="ml-3 flex items-center gap-2">
          <Show when={moving() === s.key}>
            <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Moving…
            </span>
          </Show>
          <Show when={props.showAssign}>
            <select
              class="rounded border px-2 py-1 text-xs"
              style={{ background: 'var(--c-bg)', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }}
              disabled={moving() === s.key}
              onChange={(e) => {
                const orgId = e.currentTarget.value
                if (orgId) {
                  assignSession(s.key, s.shortKey, orgId)
                  e.currentTarget.value = ''
                }
              }}
            >
              <option value="">Assign to…</option>
              <For each={orgs().filter((o) => o.orgId !== '_global')}>
                {(org) => <option value={org.orgId}>{org.name}</option>}
              </For>
            </select>
          </Show>
          <Show when={props.showMove}>
            <select
              class="rounded border px-2 py-1 text-xs"
              style={{ background: 'var(--c-bg)', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }}
              disabled={moving() === s.key}
              onChange={(e) => {
                const orgId = e.currentTarget.value
                if (orgId) {
                  assignSession(s.key, s.shortKey, orgId === '_global' ? '_global' : orgId)
                  e.currentTarget.value = ''
                }
              }}
            >
              <option value="">Move to…</option>
              <option value="_global">Global (unassign)</option>
              <For each={orgs().filter((o) => o.orgId !== '_global' && o.orgId !== s.orgId)}>
                {(org) => <option value={org.orgId}>{org.name}</option>}
              </For>
            </select>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-bold" style={{ color: 'var(--c-text)' }}>
          Thread Management
        </h2>
        <button
          class="rounded px-3 py-1 text-xs font-medium"
          style={{ background: 'var(--c-accent)', color: '#fff' }}
          onClick={load}
        >
          Refresh
        </button>
      </div>

      <Show when={error()}>
        <div
          class="rounded px-3 py-2 text-sm"
          style={{ background: 'var(--c-error-bg, #7f1d1d)', color: 'var(--c-error, #fca5a5)' }}
        >
          {error()}
        </div>
      </Show>

      <Show when={loading()}>
        <p class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
          Loading sessions from gateway…
        </p>
      </Show>

      <div>
        <h3 class="mb-2 text-sm font-semibold" style={{ color: 'var(--c-text-muted)' }}>
          Unassigned ({unassigned().length})
        </h3>
        <Show
          when={unassigned().length > 0}
          fallback={
            <p class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
              All sessions are assigned to a workspace.
            </p>
          }
        >
          <div class="space-y-2">
            <For each={unassigned()}>{(s) => <SessionRow session={s} showAssign={true} showMove={false} />}</For>
          </div>
        </Show>
      </div>

      <div>
        <h3 class="mb-2 text-sm font-semibold" style={{ color: 'var(--c-text-muted)' }}>
          Assigned ({assigned().length})
        </h3>
        <Show
          when={assigned().length > 0}
          fallback={
            <p class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
              No assigned sessions.
            </p>
          }
        >
          <div class="space-y-2">
            <For each={assigned()}>{(s) => <SessionRow session={s} showAssign={false} showMove={true} />}</For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default ThreadsTab

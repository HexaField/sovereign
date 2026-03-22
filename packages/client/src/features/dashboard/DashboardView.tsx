// §2 Dashboard View — Home screen with workspace cards, global chat, voice widget, notifications
// Mobile-first, data-rich layout with real data fetching

// ── Re-exports from existing helpers (preserved for backward compat) ──

export {
  formatClock,
  formatUptime,
  getStatusColor,
  MAX_FEED_EVENTS,
  getEventIcon,
  getEventDescription,
  formatEventTime,
  groupNotificationsByThread,
  isUnread,
  formatAgentDuration,
  getAgentStatusLabel,
  getRecentThreads,
  QUICK_SWITCH_LIMIT
} from './dashboard-helpers'

export type {
  ServiceStatus,
  ActivityEvent,
  Notification,
  ThreadInfo,
  EventType,
  AgentStatus
} from './dashboard-helpers'

// ── §2.6 System Status Strip ──

export type ConnectionState = 'connected' | 'connecting' | 'disconnected'

export function getConnectionDotColor(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'bg-green-500'
    case 'connecting':
      return 'bg-amber-500'
    case 'disconnected':
      return 'bg-red-500'
  }
}

export function formatJobCount(count: number): string {
  if (count === 0) return 'No active jobs'
  if (count === 1) return '1 active job'
  return `${count} active jobs`
}

// ── §2.1 DashboardView Component ──

import WorkspaceCard from './WorkspaceCard'
import type { OrgSummary } from './WorkspaceCard'
import GlobalChat from './GlobalChat'
import VoiceWidget from './VoiceWidget'
import NotificationFeed from './NotificationFeed'
import { ActivityFeed } from './ActivityFeed'
import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { setActiveView } from '../nav/store'

export const [connectionState, setConnectionState] = createSignal<ConnectionState>('connected')
export const [agentBackendStatus, setAgentBackendStatus] = createSignal('online')
export const [activeJobCount, setActiveJobCount] = createSignal(0)

interface HealthData {
  resources?: {
    diskUsage?: { used: number; total: number }
  }
}

export function DashboardView() {
  const [orgs, setOrgs] = createSignal<OrgSummary[]>([])
  const [diskPct, setDiskPct] = createSignal<number | null>(null)
  const [isMobile, setIsMobile] = createSignal(window.innerWidth < 768)

  const checkMobile = () => setIsMobile(window.innerWidth < 768)

  onMount(async () => {
    window.addEventListener('resize', checkMobile)

    // Fetch dashboard summary (aggregated per-org data)
    try {
      const res = await fetch('/api/dashboard/summary')
      if (res.ok) {
        const data = await res.json()
        const summaries: OrgSummary[] = (data ?? []).map((s: any) => ({
          orgId: s.orgId ?? '',
          orgName: s.orgName ?? '',
          gitDirtyCount: s.gitDirtyCount ?? 0,
          branchesAhead: s.branchesAhead ?? 0,
          branchesBehind: s.branchesBehind ?? 0,
          activeThreads: s.activeThreadCount ?? 0,
          unreadThreads: s.unreadThreadCount ?? 0,
          errorThreads: 0,
          notificationCount: s.notificationCount ?? 0,
          hasActiveAgents: s.hasActiveAgent ?? false,
          hasPendingNotifications: (s.notificationCount ?? 0) > 0
        }))
        setOrgs(summaries)
      }
    } catch { /* fetch failed */ }

    // Fetch health for disk usage
    try {
      const res = await fetch('/api/system/health')
      if (res.ok) {
        const health: HealthData = await res.json()
        const disk = health.resources?.diskUsage
        if (disk && disk.total > 0) {
          setDiskPct(Math.round((disk.used / disk.total) * 100))
        }
      }
    } catch { /* ignore */ }
  })

  onCleanup(() => {
    window.removeEventListener('resize', checkMobile)
  })

  return (
    <div class="min-h-full overflow-y-auto" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
      {/* §2.6 System Status Strip */}
      <div class="flex items-center gap-3 px-3 py-1.5 text-[11px] opacity-70" style={{ 'border-bottom': '1px solid var(--c-border)' }}>
        <span class="flex items-center gap-1">
          <span class={`inline-block h-1.5 w-1.5 rounded-full ${getConnectionDotColor(connectionState())}`} />
          {connectionState()}
        </span>
        <span>Agent: {agentBackendStatus()}</span>
        <span>{formatJobCount(activeJobCount())}</span>
        <Show when={diskPct() !== null}>
          <span>Disk: {diskPct()}%</span>
        </Show>
      </div>

      <div class="p-3">
        {/* Quick Actions */}
        <div class="mb-3 flex gap-2 overflow-x-auto pb-1">
          <button
            class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:brightness-110"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            onClick={() => {
              // Dispatch custom event for AddWorkspaceDialog
              window.dispatchEvent(new CustomEvent('sovereign:add-workspace'))
            }}
          >
            <span>+</span> New Workspace
          </button>
          <button
            class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:brightness-110"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            onClick={() => setActiveView('planning')}
          >
            <span>📋</span> Planning
          </button>
        </div>

        {/* Workspace Cards */}
        <Show when={orgs().length > 0} fallback={
          <p class="mb-3 text-xs opacity-40">No workspaces configured</p>
        }>
          <div class={isMobile() ? 'mb-3 space-y-2' : 'mb-3 grid grid-cols-2 gap-2 lg:grid-cols-3'}>
            <For each={orgs()}>
              {(org) => <WorkspaceCard org={org} compact={isMobile()} />}
            </For>
          </div>
        </Show>

        {/* Desktop: Activity + Chat side by side; Mobile: stacked */}
        <Show when={!isMobile()} fallback={
          <>
            {/* Mobile: Chat capped at 40vh */}
            <div class="mb-3 overflow-hidden" style={{ 'max-height': '40vh' }}>
              <GlobalChat />
            </div>
            <div class="mb-3">
              <ActivityFeed />
            </div>
            <div class="mb-3">
              <NotificationFeed />
            </div>
          </>
        }>
          <div class="mb-3 grid grid-cols-3 gap-3">
            <div class="col-span-2">
              <ActivityFeed />
            </div>
            <div class="col-span-1">
              <GlobalChat />
            </div>
          </div>
          <div class="mb-3">
            <NotificationFeed />
          </div>
          <div class="max-w-xs">
            <VoiceWidget />
          </div>
        </Show>
      </div>

      {/* Mobile: Voice FAB */}
      <Show when={isMobile()}>
        <VoiceWidget fab />
      </Show>
    </div>
  )
}

export default DashboardView

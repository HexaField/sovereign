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

import type { OrgSummary } from './WorkspaceCard'
import GlobalChat from './GlobalChat'
import VoiceWidget from './VoiceWidget'
import NotificationFeed from './NotificationFeed'
import { ActivityFeed } from './ActivityFeed'
import ThreadPreviews from './ThreadPreviews'
import DashboardThreadsView from './DashboardThreadsView'
import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { setActiveView } from '../nav/store'
import { ExpandIcon, CollapseIcon } from '../../ui/icons'

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

  onMount(async () => {
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
          threadCount: s.threadCount ?? 0,
          unreadThreads: s.unreadThreadCount ?? 0,
          errorThreads: 0,
          notificationCount: s.notificationCount ?? 0,
          hasActiveAgents: s.hasActiveAgent ?? false,
          hasPendingNotifications: (s.notificationCount ?? 0) > 0
        }))
        setOrgs(summaries)
      }
    } catch {
      /* fetch failed */
    }

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
    } catch {
      /* ignore */
    }
  })

  onCleanup(() => {})

  return (
    <div class="h-full overflow-y-auto overscroll-none" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
      {/* §2.6 System Status Strip */}
      <div
        class="flex items-center gap-3 px-3 py-1.5 text-[11px] opacity-70"
        style={{ 'border-bottom': '1px solid var(--c-border)' }}
      >
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
        <Show when={orgs().length > 0} fallback={<p class="mb-3 text-xs opacity-40">No workspaces configured</p>}>
          <div class="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            <For each={orgs()}>
              {(org) => (
                <div>
                  <h3 class="mb-1 text-xs font-semibold" style={{ color: 'var(--c-text-muted)' }}>
                    {org.orgName}
                  </h3>
                  <ThreadPreviews orgId={org.orgId} orgName={org.orgName} />
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Activity + Chat — responsive grid */}
        <div class="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          {/* Mobile: chat first, then activity */}
          <div class="max-h-[40vh] overflow-y-auto md:hidden">
            <GlobalChat />
          </div>
          <div class="md:col-span-2">
            <ActivityFeed />
          </div>
          <div class="hidden md:block">
            <GlobalChat />
          </div>
        </div>

        <div class="mb-3">
          <NotificationFeed />
        </div>

        {/* Desktop voice widget */}
        <div class="hidden max-w-xs md:block">
          <VoiceWidget />
        </div>
      </div>

      {/* Mobile: Voice FAB */}
      <div class="md:hidden">
        <VoiceWidget fab />
      </div>
    </div>
  )
}

export default DashboardView

// §2 Dashboard View — Home screen with workspace cards, global chat, voice widget, notifications
// Exports pure functions for testability; SolidJS components use Tailwind with var(--c-*) tokens

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
import { createSignal, onMount } from 'solid-js'

export const [connectionState, setConnectionState] = createSignal<ConnectionState>('connected')
export const [agentBackendStatus, setAgentBackendStatus] = createSignal('online')
export const [activeJobCount, setActiveJobCount] = createSignal(0)

export function DashboardView() {
  const [orgs, setOrgs] = createSignal<OrgSummary[]>([])

  onMount(async () => {
    try {
      const res = await fetch('/api/orgs')
      if (res.ok) {
        const data = await res.json()
        const summaries: OrgSummary[] = (data ?? []).map((org: any) => ({
          orgId: org.id ?? org.orgId ?? '',
          orgName: org.name ?? org.orgName ?? org.id ?? '',
          gitDirtyCount: 0,
          branchesAhead: 0,
          branchesBehind: 0,
          activeThreads: 0,
          unreadThreads: 0,
          errorThreads: 0,
          notificationCount: 0,
          hasActiveAgents: false,
          hasPendingNotifications: false
        }))
        setOrgs(summaries)
      }
    } catch {
      // fetch failed — leave empty
    }
  })

  return (
    <div class="min-h-full overflow-y-auto p-4" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
      {/* §2.6 System Status Strip */}
      <div class="mb-4 flex items-center gap-3 text-xs opacity-70">
        <span class="flex items-center gap-1">
          <span class={`inline-block h-2 w-2 rounded-full ${getConnectionDotColor(connectionState())}`} />
          {connectionState()}
        </span>
        <span>Agent: {agentBackendStatus()}</span>
        <span>{formatJobCount(activeJobCount())}</span>
      </div>

      {/* §2.1 Responsive grid */}
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {/* §2.2 Workspace Cards */}
        {orgs().map((org) => (
          <WorkspaceCard org={org} />
        ))}

        {/* §2.3 Global Chat — spans 2 cols on desktop */}
        <div class="md:col-span-2 lg:col-span-2">
          <GlobalChat />
        </div>

        {/* §2.4 Voice Widget */}
        <div>
          <VoiceWidget />
        </div>

        {/* §2.5 Notification Feed — spans full width on large screens */}
        <div class="md:col-span-2 lg:col-span-3">
          <NotificationFeed />
        </div>
      </div>
    </div>
  )
}

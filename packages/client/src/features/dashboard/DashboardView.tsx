import { lazy } from 'solid-js'

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

import { createSignal } from 'solid-js'

export const [connectionState, setConnectionState] = createSignal<ConnectionState>('connected')
export const [agentBackendStatus, setAgentBackendStatus] = createSignal('online')
export const [activeJobCount, setActiveJobCount] = createSignal(0)

const ThreadList = lazy(() => import('./ThreadList'))
const DeviceCard = lazy(() => import('./DeviceCard'))
const TailscaleCard = lazy(() => import('./TailscaleCard'))
const WeatherCard = lazy(() => import('./WeatherCard'))

export function DashboardView() {
  return (
    <div class="flex h-full" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
      {/* Thread list — main column */}
      <div class="flex-[3] overflow-hidden border-r" style={{ 'border-color': 'var(--c-border)' }}>
        <ThreadList />
      </div>

      {/* System cards — sidebar */}
      <div class="flex-[2] overflow-y-auto p-3">
        <div class="space-y-3">
          <WeatherCard />
          <DeviceCard />
          <TailscaleCard />
        </div>
      </div>
    </div>
  )
}

export default DashboardView

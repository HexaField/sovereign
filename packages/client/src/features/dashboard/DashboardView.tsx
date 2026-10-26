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
const TimelinePanel = lazy(() => import('../timeline/TimelinePanel'))

export function DashboardView() {
  // Landscape: three columns (threads | timeline | cards). Portrait: threads and cards
  // side by side on top, the timeline across the full width below them.
  return (
    <div
      class="flex h-full portrait:grid portrait:grid-cols-[3fr_2fr] portrait:grid-rows-2"
      style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}
    >
      <div
        class="min-h-0 min-w-0 flex-[3] overflow-hidden border-r portrait:col-start-1 portrait:row-start-1"
        style={{ 'border-color': 'var(--c-border)' }}
      >
        <ThreadList />
      </div>

      {/* Timeline — what happened inside Sovereign, newest first */}
      <div
        class="min-h-0 min-w-0 flex-[3] overflow-hidden border-r portrait:col-span-2 portrait:row-start-2 portrait:border-t portrait:border-r-0"
        style={{ 'border-color': 'var(--c-border)' }}
      >
        <TimelinePanel />
      </div>

      {/* System cards — sidebar */}
      <div class="min-h-0 min-w-0 flex-[2] overflow-y-auto p-3 portrait:col-start-2 portrait:row-start-1">
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

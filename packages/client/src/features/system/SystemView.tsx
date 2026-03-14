// §6 System View — Administration and observability
// Tab state is managed in nav/store.ts so the Header can render the tab bar

import { type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { activeSystemTab } from '../nav/store.js'
import OverviewTab from './OverviewTab'
import ArchitectureTab from './ArchitectureTab'
import LogsTab from './LogsTab'
import HealthTab from './HealthTab'
import ConfigTab from './ConfigTab'
import DevicesTab from './DevicesTab'
import JobsTab from './JobsTab'
import EventStreamTab from './EventStreamTab'

export type { SystemTabId } from '../nav/store.js'
export { activeSystemTab, setActiveSystemTab } from '../nav/store.js'

export interface SystemTab {
  id: string
  label: string
  component: Component
}

export const SYSTEM_TABS: SystemTab[] = [
  { id: 'overview', label: 'Overview', component: OverviewTab },
  { id: 'architecture', label: 'Architecture', component: ArchitectureTab },
  { id: 'logs', label: 'Logs', component: LogsTab },
  { id: 'health', label: 'Health', component: HealthTab },
  { id: 'config', label: 'Config', component: ConfigTab },
  { id: 'devices', label: 'Devices', component: DevicesTab },
  { id: 'jobs', label: 'Jobs', component: JobsTab },
  { id: 'events', label: 'Events', component: EventStreamTab }
]

const SystemView: Component = () => {
  const activeComponent = () => SYSTEM_TABS.find((t) => t.id === activeSystemTab())?.component

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
      {/* No tab bar here — tabs are in the Header */}
      <div class="flex-1 overflow-y-auto p-4">
        <Dynamic component={activeComponent()} />
      </div>
    </div>
  )
}

export default SystemView

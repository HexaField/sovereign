// §6 System View — Administration and observability
// Tab state is managed in nav/store.ts so the Header can render the tab bar

import { type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { activeSystemTab } from '../nav/store.js'
import StatusTab from './StatusTab'
import AgentsTab from './AgentsTab'
import ActivityTab from './ActivityTab'
import ConfigTab from './ConfigTab'
import JobsTab from './JobsTab'

export type { SystemTabId } from '../nav/store.js'
export { activeSystemTab, setActiveSystemTab } from '../nav/store.js'

export interface SystemTab {
  id: string
  label: string
  component: Component
}

export const SYSTEM_TABS: SystemTab[] = [
  { id: 'status', label: 'Status', component: StatusTab },
  { id: 'agents', label: 'Agents', component: AgentsTab },
  { id: 'activity', label: 'Activity', component: ActivityTab },
  { id: 'config', label: 'Config', component: ConfigTab },
  { id: 'jobs', label: 'Jobs', component: JobsTab }
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

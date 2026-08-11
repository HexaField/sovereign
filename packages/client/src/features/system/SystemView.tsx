// §6 System View — Administration and observability
// Tab state lives in nav/store.ts; tab bar renders here in content.

import { type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { activeSystemTab, setActiveSystemTab, type SystemTabId } from '../nav/store.js'
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
      {/* Sub-tab bar */}
      <div
        class="scrollbar-none flex shrink-0 items-center gap-1 overflow-x-auto px-4 py-2"
        style={{ 'border-bottom': '1px solid var(--c-border)' }}
      >
        {SYSTEM_TABS.map((tab) => (
          <button
            class="shrink-0 cursor-pointer rounded-md border-none px-3 py-1 text-xs font-medium transition-colors"
            style={{
              background: activeSystemTab() === tab.id ? 'var(--c-accent)' : 'transparent',
              color: activeSystemTab() === tab.id ? '#fff' : 'var(--c-text-muted)'
            }}
            onClick={() => setActiveSystemTab(tab.id as SystemTabId)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div class="flex-1 overflow-y-auto p-4">
        <Dynamic component={activeComponent()} />
      </div>
    </div>
  )
}

export default SystemView

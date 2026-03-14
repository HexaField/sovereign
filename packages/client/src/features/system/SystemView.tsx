// §6 System View — Administration and observability, rendered as tabbed layout
// Exports pure functions for testability; SolidJS components use Tailwind with var(--c-*) tokens

import { createSignal, type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import ArchitectureTab from './ArchitectureTab'
import LogsTab from './LogsTab'
import HealthTab from './HealthTab'
import ConfigTab from './ConfigTab'
import DevicesTab from './DevicesTab'
import JobsTab from './JobsTab'
import EventStreamTab from './EventStreamTab'

export type SystemTabId = 'architecture' | 'logs' | 'health' | 'config' | 'devices' | 'jobs' | 'events'

export interface SystemTab {
  id: SystemTabId
  label: string
  component: Component
}

export const SYSTEM_TABS: SystemTab[] = [
  { id: 'architecture', label: 'Architecture', component: ArchitectureTab },
  { id: 'logs', label: 'Logs', component: LogsTab },
  { id: 'health', label: 'Health', component: HealthTab },
  { id: 'config', label: 'Config', component: ConfigTab },
  { id: 'devices', label: 'Devices', component: DevicesTab },
  { id: 'jobs', label: 'Jobs', component: JobsTab },
  { id: 'events', label: 'Events', component: EventStreamTab }
]

const SystemView: Component = () => {
  const [activeTab, setActiveTab] = createSignal<SystemTabId>('architecture')

  const activeComponent = () => SYSTEM_TABS.find((t) => t.id === activeTab())?.component

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
      {/* §6.1 Horizontal tab bar */}
      <div class="scrollbar-none flex overflow-x-auto border-b" style={{ 'border-color': 'var(--c-border)' }}>
        {SYSTEM_TABS.map((tab) => (
          <button
            class={`shrink-0 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab() === tab.id ? 'border-b-2' : "opacity-60 hover:opacity-100"
            }`}
            style={{
              'border-color': activeTab() === tab.id ? 'var(--c-accent)' : 'transparent',
              color: activeTab() === tab.id ? 'var(--c-accent)' : 'var(--c-text)'
            }}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active tab content */}
      <div class="flex-1 overflow-y-auto p-4">
        <Dynamic component={activeComponent()} />
      </div>
    </div>
  )
}

export default SystemView

// Agent context view — the agent-wide views behind the ⬡ icon: Overview
// (dashboard), Forest, Tasks and System. The presence thread opens in the
// workspace like any other thread; settings live in the header's Service
// Health popover.

import { Switch, Match, lazy, Suspense } from 'solid-js'
import { activeAgentTab } from '../nav/store.js'

// Lazy-loaded tabs
const DashboardView = lazy(() => import('../dashboard/DashboardView.js'))
const ForestView = lazy(() => import('../forest/ForestView.js'))
const TasksView = lazy(() => import('../tasks/TasksView.js'))
const SystemView = lazy(() => import('../system/SystemView.js'))

export default function AgentView() {
  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      <Suspense>
        <Switch>
          <Match when={activeAgentTab() === 'overview'}>
            <DashboardView />
          </Match>
          <Match when={activeAgentTab() === 'forest'}>
            <ForestView />
          </Match>
          <Match when={activeAgentTab() === 'tasks'}>
            <TasksView />
          </Match>
          <Match when={activeAgentTab() === 'system'}>
            <SystemView />
          </Match>
        </Switch>
      </Suspense>
    </div>
  )
}

import { lazy, Switch, Match, onCleanup, onMount } from 'solid-js'
import './app.css'

// Nav store
import { activeView, initNavStore } from './features/nav/store.js'

// WS + connection stores
import { wsStore } from './ws/index.js'
import { initConnectionStore, setConnectionStatus } from './features/connection/store.js'
import { initThreadStore } from './features/threads/store.js'

// Global keyboard shortcuts
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js'

// Components
import { Header } from './features/nav/Header.js'
import { SettingsModal } from './features/nav/SettingsModal.js'
// Lazy-loaded views
const DashboardView = lazy(() => import('./features/dashboard/DashboardView.js'))
const WorkspaceView = lazy(() => import('./features/workspace/WorkspaceView.js'))
const CanvasView = lazy(() => import('./features/canvas/CanvasView.js'))
const GlobalPlanningView = lazy(() => import('./features/planning/GlobalPlanningView.js'))
const SystemView = lazy(() => import('./features/system/SystemView.js'))

export default function App() {
  const cleanups: Array<() => void> = []

  useKeyboardShortcuts()

  onMount(() => {
    cleanups.push(initNavStore())

    const cleanupConnection = initConnectionStore(wsStore)
    cleanups.push(cleanupConnection)

    const cleanupThreads = initThreadStore(wsStore)
    cleanups.push(cleanupThreads)

    const checkInterval = setInterval(() => {
      setConnectionStatus(wsStore.connected() ? 'connected' : 'disconnected')
    }, 1000)

    cleanups.push(() => {
      clearInterval(checkInterval)
      wsStore.close()
    })
  })

  onCleanup(() => {
    cleanups.forEach((fn) => fn())
  })

  return (
    <div
      class="flex h-screen flex-col"
      style={{
        background: 'var(--c-bg)',
        color: 'var(--c-text)',
        'font-family': 'var(--c-font)'
      }}
    >
      <Header />

      <main class="flex-1 overflow-hidden pt-12">
        <Switch>
          <Match when={activeView() === 'dashboard'}>
            <DashboardView />
          </Match>
          <Match when={activeView() === 'workspace'}>
            <WorkspaceView />
          </Match>
          <Match when={activeView() === 'canvas'}>
            <CanvasView />
          </Match>
          <Match when={activeView() === 'planning'}>
            <GlobalPlanningView />
          </Match>
          <Match when={activeView() === 'system'}>
            <SystemView />
          </Match>
        </Switch>
      </main>

      <SettingsModal />
    </div>
  )
}

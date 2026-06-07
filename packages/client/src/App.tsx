import { lazy, Switch, Match, onCleanup, onMount, Show, Suspense } from 'solid-js'
import './app.css'

// Nav store
import {
  activeView,
  initNavStore,
  setActiveView,
  dashboardModalOpen,
  closeDashboardModal
} from './features/nav/store.js'

// Identity
import { loadIdentity } from './lib/identity.js'

// Workspace auto-init
import { activeWorkspace, autoSelectProject, openFileTab, setChatExpanded } from './features/workspace/store.js'

// WS + connection stores
import { wsStore } from './ws/index.js'
import { initConnectionStore, setConnectionStatus } from './features/connection/store.js'
import { initThreadStore, threadKey } from './features/threads/store.js'
import { initPresence } from './features/threads/presence.js'
import { loadMutes } from './features/threads/mute-store.js'
import { initChatStore } from './features/chat/store.js'
import { initCronResultsStore } from './features/crons/CronResultsBanner.js'

// Global keyboard shortcuts
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js'

// Components
import { Header } from './features/nav/Header.js'
import { SettingsModal } from './features/nav/SettingsModal.js'
import { QuickSwitchModal } from './features/threads/QuickSwitchModal.js'
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
    loadIdentity()
    autoSelectProject()
    cleanups.push(initNavStore())

    // Set actual viewport height as CSS variable (handles Android nav bar)
    const updateVh = () => {
      const vh = window.visualViewport?.height ?? window.innerHeight
      document.documentElement.style.setProperty('--app-height', `${vh}px`)
    }
    updateVh()
    window.visualViewport?.addEventListener('resize', updateVh)
    window.addEventListener('resize', updateVh)
    cleanups.push(() => {
      window.visualViewport?.removeEventListener('resize', updateVh)
      window.removeEventListener('resize', updateVh)
    })

    const cleanupConnection = initConnectionStore(wsStore)
    cleanups.push(cleanupConnection)

    const cleanupThreads = initThreadStore(wsStore, activeWorkspace()?.orgId)
    cleanups.push(cleanupThreads)

    // Init chat store at app level so dashboard GlobalChat has data on fresh load
    const cleanupChat = initChatStore(threadKey, wsStore)
    if (cleanupChat) cleanups.push(cleanupChat)

    // Init cron results store for real-time cron run monitoring
    const cleanupCronResults = initCronResultsStore(wsStore)
    cleanups.push(cleanupCronResults)

    // Presence emitter: tell the server which thread this tab has focused so
    // push notifications + unread badges suppress when the user is already
    // looking at the thread. Fire-and-forget on the mute load.
    const cleanupPresence = initPresence(threadKey, wsStore)
    cleanups.push(cleanupPresence)
    void loadMutes()

    // Listen for sovereign:open-file events from file chips
    const handleOpenFile = (e: Event) => {
      const { path } = (e as CustomEvent).detail
      setChatExpanded(false)
      openFileTab(path, '_workspace')
      setActiveView('workspace')
    }
    window.addEventListener('sovereign:open-file', handleOpenFile)
    cleanups.push(() => window.removeEventListener('sovereign:open-file', handleOpenFile))

    // ESC closes the dashboard modal. Lives at App level so it works no
    // matter which underlying view is focused. Stops propagation so any
    // view-level ESC handlers don't fire as well.
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dashboardModalOpen()) {
        e.stopPropagation()
        closeDashboardModal()
      }
    }
    document.addEventListener('keydown', handleEsc, true)
    cleanups.push(() => document.removeEventListener('keydown', handleEsc, true))

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
      class="flex flex-col overflow-hidden"
      style={{
        height: 'var(--app-height, 100dvh)',
        background: 'var(--c-bg)',
        color: 'var(--c-text)',
        'font-family': 'var(--c-font)'
      }}
    >
      <Header />

      <main class="relative flex-1 overflow-hidden">
        <Suspense>
          <Switch>
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
        </Suspense>

        {/* Dashboard modal overlay — covers the full page when open,
            stays mounted *on top of* the underlying view so dismissing
            it returns the user exactly where they were (same view,
            same thread, same scroll position). No backdrop dismiss by
            design — only the ⬡ button or ESC closes it. */}
        <Show when={dashboardModalOpen()}>
          <div
            class="absolute inset-0 z-[150] overflow-hidden"
            style={{ background: 'var(--c-bg)' }}
            role="dialog"
            aria-modal="true"
            aria-label="Dashboard"
          >
            <Suspense>
              <DashboardView />
            </Suspense>
          </div>
        </Show>
      </main>

      <SettingsModal />
      <QuickSwitchModal />
    </div>
  )
}

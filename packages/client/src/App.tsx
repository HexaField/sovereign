import { createEffect, lazy, Switch, Match, onCleanup, onMount, Suspense } from 'solid-js'
import type { ThreadInfo } from '@sovereign/core'
import './app.css'

// Nav store
import { activeView, initNavStore, setActiveView, navigateToAgent } from './features/nav/store.js'

// Identity
import { loadIdentity } from './lib/identity.js'

// Theme — must load eagerly so the stored theme class applies on startup
// (SettingsContent is lazy-loaded, so its import alone won't trigger this)
import './features/theme/store.js'

// Workspace auto-init
import {
  activeWorkspace,
  autoSelectProject,
  openFileTab,
  setChatExpanded,
  syncWorkspaceForThread
} from './features/workspace/store.js'

// WS + connection stores
import { wsStore } from './ws/index.js'
import { initTtsPlayer } from './features/voice/tts-player.js'
import { initConnectionStore, setConnectionStatus } from './features/connection/store.js'
import { initThreadStore, threadKey, threads, threadPrimaryWorkspace } from './features/threads/store.js'
import { initPresence } from './features/threads/presence.js'
import { loadMutes } from './features/threads/mute-store.js'
import { initChatStore } from './features/chat/store.js'
import { initSummaryStore } from './features/chat/summary-store.js'
import { initSimpleConversationStore } from './features/chat/simple-conversation-store.js'
import { initCronResultsStore } from './features/crons/CronResultsBanner.js'
import { hasDeviceName, initDeviceNameSync } from './features/settings/device-name.js'

// Global keyboard shortcuts
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js'

// Components
import { Header } from './features/nav/Header.js'
import { QuickSwitchModal } from './features/threads/QuickSwitchModal.js'

// Lazy-loaded views
const WorkspaceView = lazy(() => import('./features/workspace/WorkspaceView.js'))
const AgentView = lazy(() => import('./features/agent/AgentView.js'))

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

    // Device naming — announce the stored name on every WS connect/
    // reconnect, and open Settings on first launch so the user names the
    // device before voice replies need to reference it.
    cleanups.push(initDeviceNameSync())
    if (!hasDeviceName()) navigateToAgent('settings')

    // Voice TTS playback — listens for voice.tts.audio JSON messages
    const cleanupTts = initTtsPlayer(wsStore)
    cleanups.push(cleanupTts)

    const cleanupThreads = initThreadStore(wsStore, activeWorkspace()?.orgId)
    cleanups.push(cleanupThreads)

    // Keep the workspace/membrane dropdown in sync with the active thread.
    let lastSyncedThreadId: string | null = null
    createEffect(() => {
      const key = threadKey()
      if (!key || key === lastSyncedThreadId) return
      lastSyncedThreadId = key
      const local = threads().find((t) => t.id === key)
      const applyFrom = (t: ThreadInfo): void => {
        const target = threadPrimaryWorkspace(t) ?? '_global'
        if (target !== activeWorkspace()?.orgId) syncWorkspaceForThread(target)
      }
      if (local) {
        applyFrom(local)
        return
      }
      fetch(`/api/threads/${encodeURIComponent(key)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { thread?: ThreadInfo } | null) => {
          if (data?.thread && threadKey() === key) applyFrom(data.thread)
        })
        .catch(() => {})
    })

    // Init chat store at app level so agent/hex and workspace chat have data.
    const cleanupChat = initChatStore(threadKey, wsStore)
    if (cleanupChat) cleanups.push(cleanupChat)

    const cleanupCronResults = initCronResultsStore(wsStore)
    cleanups.push(cleanupCronResults)

    const cleanupPresence = initPresence(threadKey, wsStore)
    cleanups.push(cleanupPresence)

    const cleanupSummary = initSummaryStore(wsStore, threadKey)
    cleanups.push(cleanupSummary)

    const cleanupSimpleConversation = initSimpleConversationStore(wsStore, threadKey)
    cleanups.push(cleanupSimpleConversation)
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
            <Match when={activeView() === 'agent'}>
              <AgentView />
            </Match>
          </Switch>
        </Suspense>
      </main>

      <QuickSwitchModal />
    </div>
  )
}

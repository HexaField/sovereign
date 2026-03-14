import { createSignal, createEffect, onCleanup, Show, Switch, Match, lazy, For } from 'solid-js'
import type { Component } from 'solid-js'
import {
  activeSidebarTab,
  setActiveSidebarTab,
  chatExpanded,
  toggleChatExpanded,
  chatPanelWidth,
  setChatPanelWidth,
  activeThreadKey,
  sidebarCollapsed,
  SIDEBAR_TABS,
  CHAT_PANEL_MIN_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  activeMobileTab,
  setActiveMobileTab,
  swipeMobileTab,
  MOBILE_TAB_ORDER,
  isMobileWidth
} from './store.js'

// Lazy-loaded sidebar panels
const FileExplorerPanel = lazy(() => import('./panels/FileExplorerPanel.js'))
const GitPanel = lazy(() => import('./panels/GitPanel.js'))
const ThreadsPanel = lazy(() => import('./panels/ThreadsPanel.js'))
const PlanningPanel = lazy(() => import('./panels/PlanningPanel.js'))
const NotificationsPanel = lazy(() => import('./panels/NotificationsPanel.js'))
const TerminalPanel = lazy(() => import('./panels/TerminalPanel.js'))
const RecordingsPanel = lazy(() => import('./panels/RecordingsPanel.js'))
const MeetingsPanel = lazy(() =>
  import('../../features/meetings/MeetingsPanel.js').then((m) => ({ default: m.MeetingsPanel }))
)
const LogsPanel = lazy(() => import('./panels/LogsPanel.js'))

// §3.3 — Sidebar Tab Bar
const SidebarTabBar: Component = () => {
  return (
    <div class="flex flex-wrap gap-1 border-b px-2 py-1" style={{ 'border-color': 'var(--c-border)' }}>
      {SIDEBAR_TABS.map((tab) => (
        <button
          class="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
          style={{
            background: activeSidebarTab() === tab.key ? 'var(--c-accent)' : 'transparent',
            color: activeSidebarTab() === tab.key ? 'var(--c-text)' : 'var(--c-text-muted)'
          }}
          onClick={() => setActiveSidebarTab(tab.key)}
          title={tab.label}
        >
          <span>{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  )
}

// §3.3 — Sidebar Panel Content
const SidebarContent: Component = () => {
  return (
    <div class="flex-1 overflow-auto">
      <Switch>
        <Match when={activeSidebarTab() === 'files'}>
          <FileExplorerPanel />
        </Match>
        <Match when={activeSidebarTab() === 'git'}>
          <GitPanel />
        </Match>
        <Match when={activeSidebarTab() === 'threads'}>
          <ThreadsPanel />
        </Match>
        <Match when={activeSidebarTab() === 'planning'}>
          <PlanningPanel />
        </Match>
        <Match when={activeSidebarTab() === 'notifications'}>
          <NotificationsPanel />
        </Match>
        <Match when={activeSidebarTab() === 'terminal'}>
          <TerminalPanel />
        </Match>
        <Match when={activeSidebarTab() === 'recordings'}>
          <RecordingsPanel />
        </Match>
        <Match when={activeSidebarTab() === 'meetings'}>
          <MeetingsPanel />
        </Match>
        <Match when={activeSidebarTab() === 'logs'}>
          <LogsPanel />
        </Match>
      </Switch>
    </div>
  )
}

// §3.5 — Right Panel Chat
const ChatPanel: Component = () => {
  const [dragging, setDragging] = createSignal(false)

  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    setDragging(true)
  }

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging()) return
    const newWidth = window.innerWidth - e.clientX
    setChatPanelWidth(Math.max(CHAT_PANEL_MIN_WIDTH, Math.min(CHAT_PANEL_MAX_WIDTH, newWidth)))
  }

  const onMouseUp = () => setDragging(false)

  createEffect(() => {
    if (dragging()) {
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    }
    onCleanup(() => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    })
  })

  return (
    <>
      {/* Resize divider */}
      <div
        class="w-1 cursor-col-resize transition-colors hover:bg-blue-500/30"
        style={{ background: dragging() ? 'var(--c-accent)' : 'var(--c-border)' }}
        onMouseDown={onMouseDown}
      />
      <div
        class="flex flex-col overflow-hidden"
        style={{
          width: `${chatPanelWidth()}px`,
          'min-width': `${CHAT_PANEL_MIN_WIDTH}px`,
          'max-width': `${CHAT_PANEL_MAX_WIDTH}px`
        }}
      >
        {/* Chat panel header */}
        <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
          <span class="text-sm font-medium" style={{ color: 'var(--c-text-heading)' }}>
            Thread: {activeThreadKey()}
          </span>
          <button
            class="rounded p-1 text-sm transition-colors hover:bg-white/10"
            onClick={toggleChatExpanded}
            title="Expand chat (Cmd+Shift+E)"
          >
            ⤢
          </button>
        </div>
        {/* Chat content — reuses ChatView when wired */}
        <div class="flex-1 overflow-auto p-3" style={{ color: 'var(--c-text-muted)' }}>
          <p class="text-sm">Chat for thread: {activeThreadKey()}</p>
        </div>
      </div>
    </>
  )
}

// §3.2 — Expanded Chat View
const ExpandedChatView: Component = () => {
  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      <div class="flex items-center border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <button
          class="mr-3 rounded p-1 text-sm transition-colors hover:bg-white/10"
          onClick={toggleChatExpanded}
          title="Back to Workspace"
        >
          ⤡
        </button>
        <span class="text-sm font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Thread: {activeThreadKey()}
        </span>
      </div>
      <div class="flex-1 overflow-auto p-4" style={{ color: 'var(--c-text)' }}>
        {/* Full chat interface — reuses ChatView, InputArea, MessageBubble etc. */}
        <p class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
          Expanded chat view for thread: {activeThreadKey()}
        </p>
      </div>
    </div>
  )
}

// §7.3 — Mobile Workspace with swipeable tab strip
const MobileWorkspace: Component = () => {
  const [dropdownOpen, setDropdownOpen] = createSignal(false)
  let touchStartX = 0

  const handleTouchStart = (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX
  }

  const handleTouchEnd = (e: TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX
    if (Math.abs(dx) > 50) {
      swipeMobileTab(dx < 0 ? 'left' : 'right')
    }
  }

  const currentLabel = () => MOBILE_TAB_ORDER.find((t) => t.key === activeMobileTab())?.label ?? 'Files'

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      {/* Tab header */}
      <div class="relative flex items-center border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <button
          class="text-sm font-medium"
          style={{ color: 'var(--c-text-heading)' }}
          onClick={() => setDropdownOpen(!dropdownOpen())}
        >
          {currentLabel()} ▾
        </button>
        <Show when={dropdownOpen()}>
          <div
            class="absolute top-full left-0 z-50 w-48 border shadow-lg"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
          >
            <For each={MOBILE_TAB_ORDER}>
              {(tab) => (
                <button
                  class="block w-full px-3 py-2 text-left text-sm transition-colors"
                  style={{
                    background: activeMobileTab() === tab.key ? 'var(--c-accent)' : 'transparent',
                    color: 'var(--c-text)'
                  }}
                  onClick={() => {
                    setActiveMobileTab(tab.key)
                    setDropdownOpen(false)
                  }}
                >
                  {tab.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      {/* Swipeable content */}
      <div
        class="flex-1 overflow-auto"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{
          transition: 'transform 0.2s ease-out'
        }}
      >
        <Switch>
          <Match when={activeMobileTab() === 'files'}>
            <FileExplorerPanel />
          </Match>
          <Match when={activeMobileTab() === 'file-viewer'}>
            <div class="p-4 text-sm" style={{ color: 'var(--c-text-muted)' }}>
              File Viewer
            </div>
          </Match>
          <Match when={activeMobileTab() === 'chat'}>
            <div class="p-4 text-sm" style={{ color: 'var(--c-text-muted)' }}>
              Chat: {activeThreadKey()}
            </div>
          </Match>
          <Match when={activeMobileTab() === 'git'}>
            <GitPanel />
          </Match>
          <Match when={activeMobileTab() === 'threads'}>
            <ThreadsPanel />
          </Match>
          <Match when={activeMobileTab() === 'planning'}>
            <PlanningPanel />
          </Match>
          <Match when={activeMobileTab() === 'notifications'}>
            <NotificationsPanel />
          </Match>
          <Match when={activeMobileTab() === 'terminal'}>
            <TerminalPanel />
          </Match>
          <Match when={activeMobileTab() === 'recordings'}>
            <RecordingsPanel />
          </Match>
          <Match when={activeMobileTab() === 'meetings'}>
            <MeetingsPanel />
          </Match>
          <Match when={activeMobileTab() === 'logs'}>
            <LogsPanel />
          </Match>
        </Switch>
      </div>
    </div>
  )
}

// Main Workspace View
const WorkspaceView: Component = () => {
  const [isMobile, setIsMobile] = createSignal(isMobileWidth())

  // §7.1 — Detect mobile on mount and resize
  createEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    onCleanup(() => window.removeEventListener('resize', onResize))
  })

  // §3.2 — Cmd+Shift+E toggle
  const handleKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
      e.preventDefault()
      toggleChatExpanded()
    }
  }

  createEffect(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', handleKeydown)
    }
    onCleanup(() => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', handleKeydown)
      }
    })
  })

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      <Show
        when={isMobile()}
        fallback={
          <Show when={!chatExpanded()} fallback={<ExpandedChatView />}>
            <div class="flex flex-1 overflow-hidden">
              {/* §3.1 — Sidebar */}
              <Show when={!sidebarCollapsed()}>
                <div
                  class="flex flex-col border-r"
                  style={{
                    width: '260px',
                    'min-width': '260px',
                    'border-color': 'var(--c-border)',
                    background: 'var(--c-bg-raised)'
                  }}
                >
                  <SidebarTabBar />
                  <SidebarContent />
                </div>
              </Show>

              {/* §3.1 — Main Content */}
              <div class="flex flex-1 flex-col overflow-hidden" style={{ background: 'var(--c-bg)' }}>
                <div class="flex-1 overflow-auto p-4">
                  <p class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
                    Main content area
                  </p>
                </div>
              </div>

              {/* §3.5 — Right Panel Chat */}
              <ChatPanel />
            </div>
          </Show>
        }
      >
        <MobileWorkspace />
      </Show>
    </div>
  )
}

export default WorkspaceView

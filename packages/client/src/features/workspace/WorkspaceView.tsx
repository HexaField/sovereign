import { createSignal, createEffect, onCleanup, Show, Switch, Match, lazy, For, onMount, Suspense } from 'solid-js'
import type { Component } from 'solid-js'
import {
  FilesIcon,
  GitIcon,
  ThreadsIcon,
  PlanningIcon,
  NotificationsIcon,
  TerminalIcon,
  RecordingIcon,
  MeetingsIcon,
  LogsIcon,
  ExpandIcon,
  CollapseIcon,
  CloseIcon
} from '../../ui/icons.js'
import {
  activeSidebarTab,
  setActiveSidebarTab,
  chatExpanded,
  toggleChatExpanded,
  chatPanelWidth,
  setChatPanelWidth,
  activeThreadKey,
  setActiveThreadKey,
  sidebarCollapsed,
  setSidebarCollapsed,
  sidebarWidth,
  setSidebarWidth,
  chatCollapsed,
  setChatCollapsed,
  SIDEBAR_TABS,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_SNAP_THRESHOLD,
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_SNAP_THRESHOLD,
  activeMobileTab,
  setActiveMobileTab,
  swipeMobileTab,
  MOBILE_TAB_ORDER,
  isMobileWidth,
  openFileTabs,
  activeFileTabId,
  setActiveFileTabId,
  closeFileTab
} from './store.js'

// Chat imports
import { ChatView } from '../chat/ChatView.js'
import { InputArea } from '../chat/InputArea.js'
import {
  turns,
  streamingHtml,
  agentStatus,
  liveWork,
  liveThinkingText,
  compacting,
  isRetryCountdownActive,
  retryCountdownSeconds,
  sendMessage,
  abortChat,
  initChatStore
} from '../chat/store.js'
import { threadKey, switchThread, threads, createThread } from '../threads/store.js'
import { wsStore } from '../../ws/index.js'
import type { ChatMessage } from '../chat/types.js'

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
const FileViewerTab = lazy(() => import('./tabs/FileViewerTab.js'))

// Icon component lookup
const SIDEBAR_ICON_MAP: Record<string, Component<{ class?: string }>> = {
  files: FilesIcon,
  git: GitIcon,
  threads: ThreadsIcon,
  planning: PlanningIcon,
  notifications: NotificationsIcon,
  terminal: TerminalIcon,
  recordings: RecordingIcon,
  meetings: MeetingsIcon,
  logs: LogsIcon
}

// §3.3 — Sidebar Tab Bar
const SidebarTabBar: Component = () => {
  return (
    <div class="flex flex-wrap gap-1 border-b px-2 py-1.5" style={{ 'border-color': 'var(--c-border)' }}>
      {SIDEBAR_TABS.map((tab) => {
        const Icon = SIDEBAR_ICON_MAP[tab.iconKey]
        return (
          <button
            class="flex items-center gap-1 rounded px-2 py-1.5 text-xs transition-colors"
            style={{
              background: activeSidebarTab() === tab.key ? 'var(--c-accent)' : 'transparent',
              color: activeSidebarTab() === tab.key ? 'var(--c-text)' : 'var(--c-text-muted)'
            }}
            onClick={() => setActiveSidebarTab(tab.key)}
            title={tab.label}
          >
            {Icon && <Icon class="h-3.5 w-3.5" />}
            <span>{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// §3.3 — Sidebar Panel Content
const SidebarContent: Component = () => {
  return (
    <div class="flex-1 overflow-auto">
      <Suspense
        fallback={
          <p class="p-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
            Loading...
          </p>
        }
      >
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
      </Suspense>
    </div>
  )
}

// §3.6 — Main Content Area with file tabs
const MainContentArea: Component = () => {
  const tabs = openFileTabs
  const activeId = activeFileTabId

  return (
    <div class="flex flex-1 flex-col overflow-hidden" style={{ background: 'var(--c-bg)' }}>
      {/* Tab bar */}
      <Show when={tabs().length > 0}>
        <div
          class="scrollbar-none flex shrink-0 overflow-x-auto border-b"
          style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-raised)' }}
        >
          <For each={tabs()}>
            {(tab) => (
              <div
                class="group flex shrink-0 cursor-pointer items-center gap-1.5 border-r px-3 py-1.5 text-xs"
                style={{
                  'border-color': 'var(--c-border)',
                  background: activeId() === tab.id ? 'var(--c-bg)' : 'transparent',
                  color: activeId() === tab.id ? 'var(--c-text)' : 'var(--c-text-muted)',
                  'border-bottom': activeId() === tab.id ? '2px solid var(--c-accent)' : '2px solid transparent'
                }}
                onClick={() => setActiveFileTabId(tab.id)}
              >
                <span class="max-w-[200px] truncate" title={tab.path}>
                  <span style={{ color: 'var(--c-text-muted)', 'font-size': '0.65rem' }}>
                    {tab.path.split('/').slice(0, -1).join('/') ? tab.path.split('/').slice(0, -1).join('/') + '/' : ''}
                  </span>
                  {tab.label}
                </span>
                <button
                  class="ml-1 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: 'var(--c-text-muted)' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeFileTab(tab.id)
                  }}
                >
                  <CloseIcon class="h-3 w-3" />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Content */}
      <div class="flex-1 overflow-auto">
        <Show
          when={activeId() && tabs().find((t) => t.id === activeId())}
          fallback={
            <div class="flex h-full items-center justify-center">
              <p class="text-sm" style={{ color: 'var(--c-text-muted)', opacity: 0.5 }}>
                Select a file to get started
              </p>
            </div>
          }
        >
          {(tab) => (
            <Suspense
              fallback={
                <p class="p-4 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  Loading file...
                </p>
              }
            >
              <FileViewerTab path={tab().path} projectId={tab().projectId} onClose={() => closeFileTab(tab().id)} />
            </Suspense>
          )}
        </Show>
      </div>
    </div>
  )
}

// Generic resize handle hook
function createResizeHandle(opts: {
  getWidth: () => number
  setWidth: (w: number) => void
  minWidth: number
  maxWidth: number
  defaultWidth: number
  snapThreshold: number
  collapsed: () => boolean
  setCollapsed: (v: boolean) => void
  side: 'left' | 'right'
}) {
  const [dragging, setDragging] = createSignal(false)
  const [hovered, setHovered] = createSignal(false)

  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMouseMove = (e: MouseEvent) => {
      const rawWidth = opts.side === 'right' ? window.innerWidth - e.clientX : e.clientX

      if (opts.collapsed()) {
        // Snap open if dragged past threshold
        if (rawWidth > opts.snapThreshold) {
          opts.setCollapsed(false)
          opts.setWidth(opts.defaultWidth)
        }
      } else {
        // Snap closed if below threshold
        if (rawWidth < opts.snapThreshold) {
          opts.setCollapsed(true)
          opts.setWidth(0)
        } else {
          opts.setWidth(Math.max(opts.minWidth, Math.min(opts.maxWidth, rawWidth)))
        }
      }
    }

    const onMouseUp = () => {
      setDragging(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  return { dragging, hovered, setHovered, onMouseDown }
}

// Resize divider component
const ResizeDivider: Component<{
  dragging: boolean
  hovered: boolean
  onMouseDown: (e: MouseEvent) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}> = (props) => {
  return (
    <div
      style={{
        width: '4px',
        cursor: 'col-resize',
        background: props.dragging
          ? 'var(--c-accent)'
          : props.hovered
            ? 'color-mix(in srgb, var(--c-accent) 40%, transparent)'
            : 'var(--c-border)',
        transition: props.dragging ? 'none' : 'background 150ms ease',
        'flex-shrink': '0'
      }}
      onMouseDown={props.onMouseDown}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    />
  )
}

// Small toggle button to reopen a collapsed panel
const ReopenButton: Component<{ side: 'left' | 'right'; onClick: () => void }> = (props) => {
  return (
    <button
      style={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        [props.side === 'left' ? 'left' : 'right']: '0',
        width: '16px',
        height: '48px',
        background: 'var(--c-bg-raised)',
        border: '1px solid var(--c-border)',
        'border-radius': props.side === 'left' ? '0 4px 4px 0' : '4px 0 0 4px',
        cursor: 'pointer',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        color: 'var(--c-text-muted)',
        'font-size': '10px',
        'z-index': '10',
        padding: '0'
      }}
      onClick={props.onClick}
      title={props.side === 'left' ? 'Show sidebar' : 'Show chat'}
    >
      {props.side === 'left' ? '›' : '‹'}
    </button>
  )
}

// §3.5 — Right Panel Chat (now functional)
const ChatPanel: Component = () => {
  // Init chat store for the active thread
  onMount(() => {
    const cleanup = initChatStore(threadKey, wsStore)
    onCleanup(() => cleanup?.())
  })

  const resize = createResizeHandle({
    getWidth: chatPanelWidth,
    setWidth: setChatPanelWidth,
    minWidth: CHAT_PANEL_MIN_WIDTH,
    maxWidth: CHAT_PANEL_MAX_WIDTH,
    defaultWidth: CHAT_PANEL_DEFAULT_WIDTH,
    snapThreshold: CHAT_SNAP_THRESHOLD,
    collapsed: chatCollapsed,
    setCollapsed: setChatCollapsed,
    side: 'right'
  })

  // Build messages from turns
  const messages = (): ChatMessage[] =>
    turns().map((t) => ({
      turn: t,
      pending: t.pending
    }))

  return (
    <>
      {/* Resize divider */}
      <ResizeDivider
        dragging={resize.dragging()}
        hovered={resize.hovered()}
        onMouseDown={resize.onMouseDown}
        onMouseEnter={() => resize.setHovered(true)}
        onMouseLeave={() => resize.setHovered(false)}
      />
      <Show when={!chatCollapsed()}>
        <div
          class="flex h-full flex-col overflow-hidden"
          style={{
            width: `${chatPanelWidth()}px`,
            'min-width': `${CHAT_PANEL_MIN_WIDTH}px`,
            'max-width': `${CHAT_PANEL_MAX_WIDTH}px`,
            transition: resize.dragging() ? 'none' : 'width 200ms ease'
          }}
        >
          {/* Chat panel header with thread info */}
          <div
            class="flex items-center justify-between border-b px-3 py-2"
            style={{ 'border-color': 'var(--c-border)' }}
          >
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <span class="truncate text-sm font-medium" style={{ color: 'var(--c-text-heading)' }}>
                {threadKey()}
              </span>
              <Show when={agentStatus() === 'working' || agentStatus() === 'thinking'}>
                <span
                  class="flex h-[18px] min-w-[18px] shrink-0 animate-pulse items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
                  style={{ background: '#f59e0b' }}
                >
                  {agentStatus() === 'thinking' ? 'thinking' : '...'}
                </span>
              </Show>
            </div>
            <div class="flex items-center gap-1">
              {/* Thread selector dropdown */}
              <select
                class="rounded border px-1.5 py-0.5 text-[11px]"
                style={{
                  background: 'var(--c-bg)',
                  'border-color': 'var(--c-border)',
                  color: 'var(--c-text)'
                }}
                value={threadKey()}
                onChange={(e) => switchThread(e.currentTarget.value)}
              >
                <option value="main">main</option>
                <For each={threads()}>{(t) => <option value={t.key}>{t.label ?? t.key}</option>}</For>
              </select>
              <button
                class="rounded p-1 text-sm transition-colors hover:bg-white/10"
                onClick={toggleChatExpanded}
                title="Expand chat (Cmd+Shift+E)"
              >
                <ExpandIcon class="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Chat messages */}
          <ChatView
            messages={messages()}
            streamingHtml={streamingHtml()}
            agentStatus={agentStatus()}
            liveWork={liveWork()}
            liveThinkingText={liveThinkingText()}
            compacting={compacting()}
            isRetryCountdownActive={isRetryCountdownActive()}
            retryCountdownSeconds={retryCountdownSeconds()}
            onSend={sendMessage}
            onAbort={abortChat}
            threadKey={threadKey()}
          />

          {/* Input area */}
          <InputArea onSend={sendMessage} onAbort={abortChat} agentStatus={agentStatus()} threadKey={threadKey()} />
        </div>
      </Show>
    </>
  )
}

// §3.2 — Expanded Chat View (full-screen chat)
const ExpandedChatView: Component = () => {
  onMount(() => {
    const cleanup = initChatStore(threadKey, wsStore)
    onCleanup(() => cleanup?.())
  })

  const messages = (): ChatMessage[] =>
    turns().map((t) => ({
      turn: t,
      pending: t.pending
    }))

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      <div class="flex items-center border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <button
          class="mr-3 rounded p-1 text-sm transition-colors hover:bg-white/10"
          onClick={toggleChatExpanded}
          title="Back to Workspace"
        >
          <CollapseIcon class="h-4 w-4" />
        </button>
        <span class="text-sm font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Thread: {threadKey()}
        </span>
      </div>

      <ChatView
        messages={messages()}
        streamingHtml={streamingHtml()}
        agentStatus={agentStatus()}
        liveWork={liveWork()}
        liveThinkingText={liveThinkingText()}
        compacting={compacting()}
        isRetryCountdownActive={isRetryCountdownActive()}
        retryCountdownSeconds={retryCountdownSeconds()}
        onSend={sendMessage}
        onAbort={abortChat}
        threadKey={threadKey()}
      />

      <InputArea onSend={sendMessage} onAbort={abortChat} agentStatus={agentStatus()} threadKey={threadKey()} />
    </div>
  )
}

// §7.3 — Mobile Chat Panel (full-screen chat for mobile)
const MobileChatPanel: Component = () => {
  onMount(() => {
    const cleanup = initChatStore(threadKey, wsStore)
    onCleanup(() => cleanup?.())
  })

  const messages = (): ChatMessage[] =>
    turns().map((t) => ({
      turn: t,
      pending: t.pending
    }))

  return (
    <div class="flex h-full flex-col">
      {/* Thread selector */}
      <div class="flex items-center gap-2 border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <select
          class="flex-1 rounded border px-2 py-1 text-xs"
          style={{
            background: 'var(--c-bg)',
            'border-color': 'var(--c-border)',
            color: 'var(--c-text)'
          }}
          value={threadKey()}
          onChange={(e) => switchThread(e.currentTarget.value)}
        >
          <option value="main">main</option>
          <For each={threads()}>{(t) => <option value={t.key}>{t.label ?? t.key}</option>}</For>
        </select>
        <Show when={agentStatus() === 'working' || agentStatus() === 'thinking'}>
          <span
            class="flex h-[18px] min-w-[18px] shrink-0 animate-pulse items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
            style={{ background: '#f59e0b' }}
          >
            {agentStatus() === 'thinking' ? 'thinking' : '...'}
          </span>
        </Show>
      </div>

      <ChatView
        messages={messages()}
        streamingHtml={streamingHtml()}
        agentStatus={agentStatus()}
        liveWork={liveWork()}
        liveThinkingText={liveThinkingText()}
        compacting={compacting()}
        isRetryCountdownActive={isRetryCountdownActive()}
        retryCountdownSeconds={retryCountdownSeconds()}
        onSend={sendMessage}
        onAbort={abortChat}
        threadKey={threadKey()}
      />

      <InputArea onSend={sendMessage} onAbort={abortChat} agentStatus={agentStatus()} threadKey={threadKey()} />
    </div>
  )
}

// §7.3 — Mobile Workspace with swipeable tab strip
const MobileWorkspace: Component = () => {
  const [dropdownOpen, setDropdownOpen] = createSignal(false)
  let touchStartX = 0
  let touchStartY = 0
  let isHorizontalSwipe = false

  const handleTouchStart = (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX
    touchStartY = e.touches[0].clientY
    isHorizontalSwipe = false
  }

  const handleTouchMove = (e: TouchEvent) => {
    const dx = Math.abs(e.touches[0].clientX - touchStartX)
    const dy = Math.abs(e.touches[0].clientY - touchStartY)
    if (dx > 10 && dx > dy * 1.5) {
      isHorizontalSwipe = true
      e.preventDefault()
    }
  }

  const handleTouchEnd = (e: TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX
    if (isHorizontalSwipe && Math.abs(dx) > 50) {
      swipeMobileTab(dx < 0 ? 'left' : 'right')
    }
  }

  const currentLabel = () => MOBILE_TAB_ORDER.find((t) => t.key === activeMobileTab())?.label ?? 'Files'

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
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
      <div
        ref={(el: HTMLDivElement) => {
          onMount(() => {
            el.addEventListener('touchstart', handleTouchStart, { passive: true })
            el.addEventListener('touchmove', handleTouchMove, { passive: false })
            el.addEventListener('touchend', handleTouchEnd, { passive: true })
            onCleanup(() => {
              el.removeEventListener('touchstart', handleTouchStart)
              el.removeEventListener('touchmove', handleTouchMove)
              el.removeEventListener('touchend', handleTouchEnd)
            })
          })
        }}
        class="flex-1 overflow-auto"
      >
        <Switch>
          <Match when={activeMobileTab() === 'files'}>
            <FileExplorerPanel />
          </Match>
          <Match when={activeMobileTab() === 'file-viewer'}>
            <Show
              when={activeFileTabId() && openFileTabs().find((t) => t.id === activeFileTabId())}
              fallback={
                <div class="flex h-full items-center justify-center">
                  <p class="text-sm" style={{ color: 'var(--c-text-muted)', opacity: 0.5 }}>
                    Select a file from the Files tab
                  </p>
                </div>
              }
            >
              {(tab) => (
                <Suspense
                  fallback={
                    <p class="p-4 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      Loading file...
                    </p>
                  }
                >
                  <FileViewerTab path={tab().path} projectId={tab().projectId} onClose={() => closeFileTab(tab().id)} />
                </Suspense>
              )}
            </Show>
          </Match>
          <Match when={activeMobileTab() === 'chat'}>
            <MobileChatPanel />
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
  const sidebarResize = createResizeHandle({
    getWidth: sidebarWidth,
    setWidth: setSidebarWidth,
    minWidth: SIDEBAR_MIN_WIDTH,
    maxWidth: SIDEBAR_MAX_WIDTH,
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    snapThreshold: SIDEBAR_SNAP_THRESHOLD,
    collapsed: sidebarCollapsed,
    setCollapsed: setSidebarCollapsed,
    side: 'left'
  })

  const handleKeydown = (e: KeyboardEvent) => {
    // Only register keyboard shortcuts on desktop
    if (window.innerWidth < 768) return
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
      {/* Mobile layout — visible only below 768px */}
      <div class="flex h-full flex-col md:hidden">
        <MobileWorkspace />
      </div>

      {/* Desktop layout — visible only at 768px and above */}
      <div class="hidden h-full md:flex md:flex-col">
        {chatExpanded() ? (
          <ExpandedChatView />
        ) : (
          <div class="relative flex flex-1 overflow-hidden">
            {/* Sidebar reopen button */}
            <Show when={sidebarCollapsed()}>
              <ReopenButton
                side="left"
                onClick={() => {
                  setSidebarCollapsed(false)
                  setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
                }}
              />
            </Show>

            {/* §3.1 — Sidebar */}
            <Show when={!sidebarCollapsed()}>
              <div
                class="flex flex-col border-r"
                style={{
                  width: `${sidebarWidth()}px`,
                  'min-width': `${SIDEBAR_MIN_WIDTH}px`,
                  'max-width': `${SIDEBAR_MAX_WIDTH}px`,
                  'border-color': 'var(--c-border)',
                  background: 'var(--c-bg-raised)',
                  transition: sidebarResize.dragging() ? 'none' : 'width 200ms ease',
                  'flex-shrink': '0'
                }}
              >
                <SidebarTabBar />
                <SidebarContent />
              </div>
            </Show>

            {/* Sidebar resize divider */}
            <ResizeDivider
              dragging={sidebarResize.dragging()}
              hovered={sidebarResize.hovered()}
              onMouseDown={sidebarResize.onMouseDown}
              onMouseEnter={() => sidebarResize.setHovered(true)}
              onMouseLeave={() => sidebarResize.setHovered(false)}
            />

            {/* §3.1 — Main Content with file tabs */}
            <MainContentArea />

            {/* §3.5 — Right Panel Chat */}
            <ChatPanel />

            {/* Chat reopen button */}
            <Show when={chatCollapsed()}>
              <ReopenButton
                side="right"
                onClick={() => {
                  setChatCollapsed(false)
                  setChatPanelWidth(CHAT_PANEL_DEFAULT_WIDTH)
                }}
              />
            </Show>
          </div>
        )}
      </div>
    </div>
  )
}

export default WorkspaceView

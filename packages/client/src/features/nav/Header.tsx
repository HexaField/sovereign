import { createMemo, createSignal, Show, For, onCleanup } from 'solid-js'
import { ContextBudgetModal } from '../system/ContextBudgetModal.js'
import { agentName, agentIcon } from '../../lib/identity.js'
import { connectionStatus } from '../connection/store.js'
import {
  DashboardIcon,
  WorkspaceIcon,
  CanvasIcon,
  PlanningIcon,
  SystemIcon,
  SettingsIcon,
  LinkIcon,
  KanbanIcon,
  ListIcon,
  TreeIcon
} from '../../ui/icons.js'
import {
  activeView,
  setActiveView,
  setSettingsOpen,
  activeSystemTab,
  setActiveSystemTab,
  type NavView,
  type SystemTabId
} from '../nav/store.js'
import {
  viewMode as planningViewMode,
  setViewMode as setPlanningViewMode,
  type PlanningViewMode
} from '../planning/store.js'
import { activeWorkspace, chatExpanded, toggleChatExpanded } from '../workspace/store.js'
import { threadKey, switchThread, threads } from '../threads/store.js'
import { agentStatus } from '../chat/store.js'
import { unreadNotificationCount, startNotificationPolling } from '../notifications/store.js'
import { ExpandIcon, CollapseIcon } from '../../ui/icons.js'

// ── Exported helpers (used by tests) ─────────────────────────────────
export const VIEW_MODES = ['chat', 'voice', 'dashboard', 'recording'] as const

export function getViewModeIcon(mode: string): string {
  const icons: Record<string, string> = { chat: 'chat', voice: 'voice', dashboard: 'dashboard', recording: 'recording' }
  return icons[mode] || 'list'
}

export function getViewModeLabel(mode: string): string {
  const labels: Record<string, string> = {
    chat: 'Chat',
    voice: 'Voice',
    dashboard: 'Dashboard',
    recording: 'Recordings'
  }
  return labels[mode] || mode
}

// ── System tabs definition ───────────────────────────────────────────
const SYSTEM_TAB_IDS: SystemTabId[] = [
  'overview',
  'architecture',
  'logs',
  'health',
  'config',
  'devices',
  'jobs',
  'events'
]
const SYSTEM_TAB_LABELS: Record<SystemTabId, string> = {
  overview: 'Overview',
  architecture: 'Architecture',
  logs: 'Logs',
  health: 'Health',
  config: 'Config',
  devices: 'Devices',
  jobs: 'Jobs',
  events: 'Events'
}

// ── Planning mode icons ──────────────────────────────────────────────
const PLANNING_MODES: Array<{ mode: PlanningViewMode; label: string; icon: () => any }> = [
  { mode: 'dag', label: 'DAG', icon: () => <LinkIcon class="h-3.5 w-3.5" /> },
  { mode: 'kanban', label: 'Kanban', icon: () => <KanbanIcon class="h-3.5 w-3.5" /> },
  { mode: 'list', label: 'List', icon: () => <ListIcon class="h-3.5 w-3.5" /> },
  { mode: 'tree', label: 'Tree', icon: () => <TreeIcon class="h-3.5 w-3.5" /> }
]

// ── Per-view header center content ───────────────────────────────────

function DashboardHeaderContent() {
  return (
    <span class="text-base font-semibold" style={{ color: 'var(--c-text-heading)' }}>
      Dashboard
    </span>
  )
}

function WorkspaceHeaderContent() {
  const ws = () => activeWorkspace()
  const [threadPickerOpen, setThreadPickerOpen] = createSignal(false)

  // Start polling notifications
  startNotificationPolling()

  const activeThreadLabel = () => {
    const key = threadKey()
    const t = threads().find((th) => th.key === key)
    return t?.label ?? t?.key ?? key
  }

  return (
    <div class="flex items-center gap-1.5 text-sm">
      <span class="font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        {ws()?.orgName ?? 'Global'}
      </span>
      <Show when={ws()?.activeProjectName}>
        <span style={{ color: 'var(--c-text-muted)' }}>/</span>
        <span style={{ color: 'var(--c-text)' }}>{ws()!.activeProjectName}</span>
      </Show>
      <span style={{ color: 'var(--c-text-muted)' }}>/</span>
      <div class="relative">
        <button
          class="flex cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-1.5 py-0.5 text-sm font-medium transition-colors"
          style={{ color: 'var(--c-accent)' }}
          onClick={() => setThreadPickerOpen(!threadPickerOpen())}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {activeThreadLabel()}
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            ▾
          </span>
        </button>
        <Show when={threadPickerOpen()}>
          <div class="fixed inset-0 z-[199]" onClick={() => setThreadPickerOpen(false)} />
          <div
            class="absolute top-full left-0 z-[200] mt-1 min-w-[160px] overflow-hidden rounded-lg shadow-lg"
            style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
          >
            <For each={threads().filter((t) => t.key)}>
              {(t) => (
                <button
                  class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
                  style={{
                    color: t.key === threadKey() ? 'var(--c-accent)' : 'var(--c-text)',
                    background: t.key === threadKey() ? 'var(--c-hover-bg)' : undefined
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = t.key === threadKey() ? 'var(--c-hover-bg)' : '')
                  }
                  onClick={() => {
                    switchThread(t.key)
                    setThreadPickerOpen(false)
                  }}
                >
                  <Show when={t.key === threadKey()}>
                    <span class="text-xs">●</span>
                  </Show>
                  <span>{t.label ?? t.key}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      {/* Agent status dot */}
      <span
        class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{
          background:
            agentStatus() === 'error'
              ? '#ef4444'
              : agentStatus() === 'working' || agentStatus() === 'thinking'
                ? '#f59e0b'
                : '#22c55e',
          animation:
            agentStatus() === 'working' || agentStatus() === 'thinking' ? 'pulse 1.5s ease-in-out infinite' : 'none'
        }}
        title={`Agent: ${agentStatus()}`}
      />
      {/* Unread notifications badge */}
      <Show when={unreadNotificationCount() > 0}>
        <span
          class="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
          style={{ background: '#ef4444' }}
          title={`${unreadNotificationCount()} unread notifications`}
        >
          {unreadNotificationCount() > 99 ? '99+' : unreadNotificationCount()}
        </span>
      </Show>
      <button
        class="ml-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent transition-colors"
        style={{ color: 'var(--c-text-muted)' }}
        onClick={() => toggleChatExpanded()}
        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--c-accent)')}
        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--c-text-muted)')}
        title={chatExpanded() ? 'Collapse chat' : 'Expand chat'}
      >
        <Show when={chatExpanded()} fallback={<ExpandIcon class="h-3.5 w-3.5" />}>
          <CollapseIcon class="h-3.5 w-3.5" />
        </Show>
      </button>
    </div>
  )
}

function CanvasHeaderContent() {
  return (
    <span class="text-base font-semibold" style={{ color: 'var(--c-text-heading)' }}>
      Canvas
    </span>
  )
}

function PlanningHeaderContent() {
  return (
    <div class="flex items-center gap-3">
      <span class="text-base font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        Planning
      </span>
      <div class="flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--c-bg)' }}>
        <For each={PLANNING_MODES}>
          {(pm) => (
            <button
              class="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
              style={{
                background: planningViewMode() === pm.mode ? 'var(--c-accent)' : 'transparent',
                color: planningViewMode() === pm.mode ? '#fff' : 'var(--c-text-muted)'
              }}
              onClick={() => setPlanningViewMode(pm.mode)}
              title={pm.label}
            >
              {pm.icon()}
              <span class="hidden sm:inline">{pm.label}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

function SystemHeaderContent() {
  return (
    <div class="scrollbar-none flex items-center gap-0.5 overflow-x-auto">
      <For each={SYSTEM_TAB_IDS}>
        {(tabId) => (
          <button
            class="shrink-0 rounded-md px-3 py-1 text-xs font-medium transition-colors"
            style={{
              background: activeSystemTab() === tabId ? 'var(--c-accent)' : 'transparent',
              color: activeSystemTab() === tabId ? '#fff' : 'var(--c-text-muted)'
            }}
            onClick={() => setActiveSystemTab(tabId)}
          >
            {SYSTEM_TAB_LABELS[tabId]}
          </button>
        )}
      </For>
    </div>
  )
}

// ── Top-level views for menu ─────────────────────────────────────────

const topLevelViews: Array<{ view: NavView; label: string; icon: () => any; shortcut: string }> = [
  { view: 'dashboard', label: 'Dashboard', icon: () => <DashboardIcon class="h-4 w-4" />, shortcut: '⌘1' },
  { view: 'workspace', label: 'Workspace', icon: () => <WorkspaceIcon class="h-4 w-4" />, shortcut: '⌘2' },
  { view: 'canvas', label: 'Canvas', icon: () => <CanvasIcon class="h-4 w-4" />, shortcut: '⌘3' },
  { view: 'planning', label: 'Planning', icon: () => <PlanningIcon class="h-4 w-4" />, shortcut: '⌘4' },
  { view: 'system', label: 'System', icon: () => <SystemIcon class="h-4 w-4" />, shortcut: '⌘5' }
]

// ── Main Header ──────────────────────────────────────────────────────

export function Header() {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [showContextBudget, setShowContextBudget] = createSignal(false)
  const [warningCount, setWarningCount] = createSignal(0)

  const BASE = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'

  const statusStyle = createMemo(() => {
    const s = connectionStatus()
    if (s === 'connected') return { background: 'rgba(74,255,138,0.1)', color: '#4aff8a' }
    if (s === 'error' || s === 'disconnected') return { background: 'rgba(255,74,106,0.1)', color: 'var(--c-danger)' }
    return { background: 'var(--c-hover-bg-strong)', color: 'var(--c-text-muted)' }
  })

  const statusLabel = createMemo(() => {
    const s = connectionStatus()
    if (s === 'connecting') return 'connecting…'
    if (s === 'authenticating') return 'authenticating…'
    if (s === 'connected') return 'connected'
    if (s === 'disconnected') return 'disconnected'
    return 'error'
  })

  async function loadWarningCount(): Promise<void> {
    try {
      const res = await fetch(`${BASE}api/architecture/warnings`)
      if (res.ok) {
        const warnings = await res.json()
        setWarningCount(Array.isArray(warnings) ? warnings.length : 0)
      }
    } catch {
      /* stub */
    }
  }

  loadWarningCount()
  const warnInterval = setInterval(loadWarningCount, 60_000)
  onCleanup(() => clearInterval(warnInterval))

  const totalBadge = createMemo(() => warningCount())

  const selectView = (view: NavView) => {
    setActiveView(view)
    setMenuOpen(false)
  }

  return (
    <div
      class="safe-top z-[100] flex shrink-0 items-center gap-2 px-4 py-2"
      style={{ 'border-bottom': '1px solid var(--c-border)', background: 'var(--c-bg-raised)' }}
    >
      {/* Left: Agent icon */}
      <span class="shrink-0 text-xl">{agentIcon()}</span>

      {/* Center: View-specific content */}
      <div class="min-w-0 flex-1 px-2">
        <Show when={activeView() === 'dashboard'}>
          <DashboardHeaderContent />
        </Show>
        <Show when={activeView() === 'workspace'}>
          <WorkspaceHeaderContent />
        </Show>
        <Show when={activeView() === 'canvas'}>
          <CanvasHeaderContent />
        </Show>
        <Show when={activeView() === 'planning'}>
          <PlanningHeaderContent />
        </Show>
        <Show when={activeView() === 'system'}>
          <SystemHeaderContent />
        </Show>
      </div>

      {/* Right: Context budget */}
      <button
        class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border bg-transparent transition-all"
        style={{
          'border-color': showContextBudget() ? 'var(--c-accent)' : 'var(--c-border)',
          color: showContextBudget() ? 'var(--c-accent)' : 'var(--c-text-muted)'
        }}
        onClick={() => setShowContextBudget(!showContextBudget())}
        title="Context Budget"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      </button>

      <Show when={showContextBudget()}>
        <ContextBudgetModal onClose={() => setShowContextBudget(false)} />
      </Show>

      {/* Status badge */}
      <span class="shrink-0 rounded-[10px] px-2 py-[3px] text-[11px] whitespace-nowrap" style={statusStyle()}>
        {statusLabel()}
      </span>

      {/* Hamburger menu */}
      <div class="relative">
        <button
          class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border bg-transparent transition-all"
          style={{
            'border-color': menuOpen() ? 'var(--c-accent)' : 'var(--c-border)',
            color: menuOpen() ? 'var(--c-accent)' : 'var(--c-text-muted)'
          }}
          onClick={() => setMenuOpen(!menuOpen())}
          title="Menu"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
          <Show when={totalBadge() > 0}>
            <span
              class="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
              style={{ background: '#ef4444' }}
            >
              {totalBadge() > 9 ? '9+' : totalBadge()}
            </span>
          </Show>
        </button>

        <Show when={menuOpen()}>
          <div class="fixed inset-0 z-[199]" onClick={() => setMenuOpen(false)} />
          <div
            class="absolute top-full right-0 z-[200] mt-1 w-52 overflow-hidden rounded-lg shadow-lg"
            style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
          >
            {topLevelViews.map((item) => (
              <button
                class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors"
                style={{
                  color: activeView() === item.view ? 'var(--c-accent)' : 'var(--c-text)',
                  background: activeView() === item.view ? 'var(--c-hover-bg)' : undefined
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = activeView() === item.view ? 'var(--c-hover-bg)' : '')
                }
                onClick={() => selectView(item.view)}
              >
                <span class="flex w-5 items-center justify-center">{item.icon()}</span>
                <span class="flex-1">{item.label}</span>
                <span class="hidden text-[10px] sm:inline" style={{ color: 'var(--c-text-muted)' }}>
                  {item.shortcut}
                </span>
              </button>
            ))}
            <div style={{ 'border-top': '1px solid var(--c-border)' }}>
              <button
                class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors"
                style={{ color: 'var(--c-text)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                onClick={() => {
                  setMenuOpen(false)
                  setSettingsOpen(true)
                }}
              >
                <span class="flex w-5 items-center justify-center">
                  <SettingsIcon class="h-4 w-4" />
                </span>
                <span class="flex-1">Settings</span>
              </button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

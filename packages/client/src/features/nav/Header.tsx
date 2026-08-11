import { createMemo, createSignal, Show, For, onMount, onCleanup } from 'solid-js'
import { agentIcon } from '../../lib/identity.js'
import { HealthPopover, overallHealth, initHealthPolling } from '../connection/HealthPopover.js'
import { WorkspaceIcon, SystemIcon, SettingsIcon } from '../../ui/icons.js'
import {
  activeView,
  setActiveView,
  setSettingsOpen,
  activeSystemTab,
  setActiveSystemTab,
  dashboardModalOpen,
  toggleDashboardModal,
  type NavView,
  type SystemTabId
} from '../nav/store.js'
import { WorkspaceHeaderContent } from '../workspace/WorkspaceHeaderContent.js'

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
const SYSTEM_TAB_IDS: SystemTabId[] = ['status', 'agents', 'activity', 'config', 'jobs']
const SYSTEM_TAB_LABELS: Record<SystemTabId, string> = {
  status: 'Status',
  agents: 'Agents',
  activity: 'Activity',
  config: 'Config',
  jobs: 'Jobs'
}

// ── Per-view header center content ───────────────────────────────────

function DashboardHeaderContent() {
  return (
    <span class="text-base font-semibold" style={{ color: 'var(--c-text-heading)' }}>
      Dashboard
    </span>
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
//
// Dashboard accessed via the ⬡ icon (top-left). Canvas and Planning
// removed pending reimplementation. Menu shows only active pages.
const topLevelViews: Array<{ view: NavView; label: string; icon: () => any; shortcut: string }> = [
  { view: 'workspace', label: 'Workspace', icon: () => <WorkspaceIcon class="h-4 w-4" />, shortcut: '⌘2' },
  { view: 'system', label: 'System', icon: () => <SystemIcon class="h-4 w-4" />, shortcut: '⌘3' }
]

// ── Main Header ──────────────────────────────────────────────────────

export function Header() {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [warningCount, setWarningCount] = createSignal(0)
  const [healthOpen, setHealthOpen] = createSignal(false)
  let healthDotRef: HTMLButtonElement | undefined

  const BASE = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'

  onMount(() => {
    const cleanup = initHealthPolling()
    onCleanup(cleanup)
  })

  const statusStyle = createMemo(() => {
    const h = overallHealth()
    if (h === 'ok') return { background: 'rgba(74,255,138,0.1)', color: '#4aff8a' }
    if (h === 'error') return { background: 'rgba(255,74,106,0.1)', color: 'var(--c-danger)' }
    return { background: 'rgba(245,158,11,0.1)', color: 'var(--c-amber, #f59e0b)' }
  })

  const statusLabel = createMemo(() => {
    const h = overallHealth()
    if (h === 'ok') return 'all services healthy'
    if (h === 'degraded') return 'service degraded — click for details'
    return 'service error — click for details'
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
      {/* Left: Agent icon — toggles the dashboard modal overlay. */}
      <button
        class="shrink-0 cursor-pointer text-xl"
        onClick={toggleDashboardModal}
        title={dashboardModalOpen() ? 'Close dashboard' : 'Open dashboard'}
      >
        {agentIcon()}
      </button>

      {/* Center: header content reflects what the user is *looking at*.
          When the dashboard modal is open it covers the page, so the
          dashboard header takes precedence over the underlying view's. */}
      <div class="min-w-0 flex-1 px-2">
        <Show when={dashboardModalOpen()}>
          <DashboardHeaderContent />
        </Show>
        <Show when={!dashboardModalOpen() && activeView() === 'workspace'}>
          <WorkspaceHeaderContent />
        </Show>
        <Show when={!dashboardModalOpen() && activeView() === 'system'}>
          <SystemHeaderContent />
        </Show>
      </div>

      {/* Status dot — clickable to show health popover */}
      <button
        ref={healthDotRef}
        class="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent transition-all"
        style={{ background: statusStyle().background }}
        onClick={() => setHealthOpen(!healthOpen())}
        title={statusLabel()}
      >
        <span class="inline-block h-2 w-2 rounded-full" style={{ background: statusStyle().color }} />
      </button>
      <HealthPopover open={healthOpen()} onClose={() => setHealthOpen(false)} anchorRef={healthDotRef} />

      {/* Hamburger menu */}
      <div class="relative">
        <div>
          <button
            class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent transition-all"
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
              {topLevelViews.map((item) => {
                const isActive = () => activeView() === item.view
                return (
                  <button
                    class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors"
                    style={{
                      color: isActive() ? 'var(--c-accent)' : 'var(--c-text)',
                      background: isActive() ? 'var(--c-hover-bg)' : undefined
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = isActive() ? 'var(--c-hover-bg)' : '')}
                    onClick={() => selectView(item.view)}
                  >
                    <span class="flex w-5 items-center justify-center">{item.icon()}</span>
                    <span class="flex-1">{item.label}</span>
                    <span class="hidden text-[10px] sm:inline" style={{ color: 'var(--c-text-muted)' }}>
                      {item.shortcut}
                    </span>
                  </button>
                )
              })}
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
    </div>
  )
}

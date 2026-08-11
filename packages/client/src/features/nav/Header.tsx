import { createMemo, createSignal, Show, onMount, onCleanup } from 'solid-js'
import { agentIcon, agentName } from '../../lib/identity.js'
import { HealthPopover, overallHealth, initHealthPolling } from '../connection/HealthPopover.js'
import {
  activeView,
  setActiveView,
  activeAgentTab,
  setActiveAgentTab,
  activeSystemTab,
  setActiveSystemTab,
  type AgentTab,
  type SystemTabId
} from '../nav/store.js'
import { threadKey, switchThread } from '../threads/store.js'
import { getPresenceGatewayThreadId } from '../threads/presence-helper.js'
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

// ── System tabs ─────────────────────────────────────────────────────
const SYSTEM_TAB_IDS: SystemTabId[] = ['status', 'agents', 'activity', 'config', 'jobs']
const SYSTEM_TAB_LABELS: Record<SystemTabId, string> = {
  status: 'Status',
  agents: 'Agents',
  activity: 'Activity',
  config: 'Config',
  jobs: 'Jobs'
}

// ── Agent-context tab bar ───────────────────────────────────────────

const AGENT_TAB_DEFS: Array<{ tab: AgentTab; staticLabel?: string }> = [
  { tab: 'hex' },
  { tab: 'overview', staticLabel: 'Overview' },
  { tab: 'settings', staticLabel: 'Settings' },
  { tab: 'system', staticLabel: 'System' }
]

function AgentHeaderContent() {
  return (
    <div class="scrollbar-none flex items-center gap-0.5 overflow-x-auto">
      {AGENT_TAB_DEFS.map((item) => {
        const label = () => item.staticLabel ?? agentName()
        const active = () => activeAgentTab() === item.tab
        return (
          <button
            class="shrink-0 rounded-md px-3 py-1 text-xs font-medium transition-colors"
            style={{
              background: active() ? 'var(--c-accent)' : 'transparent',
              color: active() ? '#fff' : 'var(--c-text-muted)'
            }}
            onClick={() => setActiveAgentTab(item.tab)}
          >
            {label()}
          </button>
        )
      })}

      {/* System sub-tabs — inline when the system agent tab has focus. */}
      <Show when={activeAgentTab() === 'system'}>
        <div
          class="scrollbar-none ml-2 flex items-center gap-0.5 overflow-x-auto border-l pl-2"
          style={{ 'border-color': 'var(--c-border)' }}
        >
          {SYSTEM_TAB_IDS.map((tabId) => (
            <button
              class="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors"
              style={{
                background: activeSystemTab() === tabId ? 'var(--c-accent)' : 'transparent',
                color: activeSystemTab() === tabId ? '#fff' : 'var(--c-text-muted)'
              }}
              onClick={() => setActiveSystemTab(tabId)}
            >
              {SYSTEM_TAB_LABELS[tabId]}
            </button>
          ))}
        </div>
      </Show>
    </div>
  )
}

// ── Main Header ─────────────────────────────────────────────────────

export function Header() {
  const [healthOpen, setHealthOpen] = createSignal(false)
  let healthDotRef: HTMLButtonElement | undefined

  // Saved workspace thread — restored when leaving agent mode.
  let savedWorkspaceThread: string | null = null
  const [presenceGatewayId, setPresenceGatewayId] = createSignal<string | null>(null)

  onMount(() => {
    const cleanup = initHealthPolling()
    onCleanup(cleanup)
    void getPresenceGatewayThreadId().then((id) => setPresenceGatewayId(id))
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

  /** Toggle between workspace and agent modes. */
  const handleToggleMode = () => {
    if (activeView() === 'workspace') {
      savedWorkspaceThread = threadKey()
      setActiveView('agent')
      const pgId = presenceGatewayId()
      if (pgId) switchThread(pgId)
    } else {
      setActiveView('workspace')
      if (savedWorkspaceThread) switchThread(savedWorkspaceThread)
    }
  }

  return (
    <div
      class="safe-top z-[100] flex shrink-0 items-center gap-2 px-4 py-2"
      style={{ 'border-bottom': '1px solid var(--c-border)', background: 'var(--c-bg-raised)' }}
    >
      {/* Left: Agent icon — toggles between workspace and agent modes. */}
      <button
        class="shrink-0 cursor-pointer text-xl"
        style={{ color: activeView() === 'agent' ? 'var(--c-accent)' : undefined }}
        onClick={handleToggleMode}
        title={activeView() === 'agent' ? 'Back to workspace' : `Open ${agentName()}`}
      >
        {agentIcon()}
      </button>

      {/* Center: mode-dependent header content. */}
      <div class="min-w-0 flex-1 px-2">
        <Show when={activeView() === 'workspace'}>
          <WorkspaceHeaderContent />
        </Show>
        <Show when={activeView() === 'agent'}>
          <AgentHeaderContent />
        </Show>
      </div>

      {/* Status dot */}
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
    </div>
  )
}

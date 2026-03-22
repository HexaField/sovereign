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
import { activeWorkspace, chatExpanded, toggleChatExpanded, setChatExpanded, setActiveWorkspace } from '../workspace/store.js'
import { threadKey, switchThread, threads, createThread, moveThread } from '../threads/store.js'
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
  'events',
  'threads'
]
const SYSTEM_TAB_LABELS: Record<SystemTabId, string> = {
  overview: 'Overview',
  architecture: 'Architecture',
  logs: 'Logs',
  health: 'Health',
  config: 'Config',
  devices: 'Devices',
  jobs: 'Jobs',
  events: 'Events',
  threads: 'Threads'
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

interface OrgListItem {
  id: string
  name: string
}

function AddWorkspaceDialog(props: { onClose: () => void; onCreated: (org: OrgListItem) => void }) {
  const [name, setName] = createSignal('')
  const [wsPath, setWsPath] = createSignal('')
  const [error, setError] = createSignal('')
  const [submitting, setSubmitting] = createSignal(false)

  const BASE = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'

  const handleSubmit = async () => {
    if (!name().trim() || !wsPath().trim()) {
      setError('Name and path are required')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`${BASE}api/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name().trim(), path: wsPath().trim() })
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to create workspace' }))
        setError(data.error || 'Failed to create workspace')
        return
      }
      const org = await res.json()
      props.onCreated(org)
    } catch (e: any) {
      setError(e.message || 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div class="fixed inset-0 z-[300] bg-black/50" onClick={() => props.onClose()} />
      <div
        class="fixed top-1/2 left-1/2 z-[301] w-[400px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl p-5 shadow-2xl"
        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
      >
        <h2 class="mb-4 text-base font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          Add Workspace
        </h2>
        <div class="flex flex-col gap-3">
          <div>
            <label class="mb-1 block text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
              Name
            </label>
            <input
              type="text"
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--c-bg)', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }}
              placeholder="My Workspace"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
              Path
            </label>
            <input
              type="text"
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--c-bg)', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }}
              placeholder="/home/user/projects"
              value={wsPath()}
              onInput={(e) => setWsPath(e.currentTarget.value)}
            />
          </div>
          <Show when={error()}>
            <p class="text-xs" style={{ color: 'var(--c-danger, #ef4444)' }}>
              {error()}
            </p>
          </Show>
          <div class="mt-1 flex justify-end gap-2">
            <button
              class="rounded-lg px-4 py-2 text-sm transition-colors"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={() => props.onClose()}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
            >
              Cancel
            </button>
            <button
              class="rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
              style={{ background: 'var(--c-accent)', opacity: submitting() ? '0.6' : '1' }}
              disabled={submitting()}
              onClick={handleSubmit}
            >
              {submitting() ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function WorkspaceHeaderContent() {
  const ws = () => activeWorkspace()
  const [threadPickerOpen, setThreadPickerOpen] = createSignal(false)
  const [newThreadInput, setNewThreadInput] = createSignal(false)
  const [newThreadLabel, setNewThreadLabel] = createSignal('')
  const [moveThreadKey, setMoveThreadKey] = createSignal<string | null>(null)
  const [wsPickerOpen, setWsPickerOpen] = createSignal(false)
  const [orgList, setOrgList] = createSignal<OrgListItem[]>([])
  const [showAddDialog, setShowAddDialog] = createSignal(false)

  const BASE = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'

  const fetchOrgs = async () => {
    try {
      const res = await fetch(`${BASE}api/orgs`)
      if (res.ok) setOrgList(await res.json())
    } catch {
      /* ignore */
    }
  }

  // Start polling notifications
  startNotificationPolling()

  const activeThreadLabel = () => {
    const key = threadKey()
    if (!key) return 'No thread'
    const t = threads().find((th) => th.key === key)
    return t?.label ?? t?.key ?? key
  }

  return (
    <div class="flex items-center gap-1.5 text-sm">
      <div class="relative">
        <button
          class="flex cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-1.5 py-0.5 text-sm font-semibold transition-colors"
          style={{ color: 'var(--c-text-heading)' }}
          onClick={() => {
            fetchOrgs()
            setWsPickerOpen(!wsPickerOpen())
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {ws()?.orgName ?? 'Global'}
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            ▾
          </span>
        </button>
        <Show when={wsPickerOpen()}>
          <div class="fixed inset-0 z-[199]" onClick={() => setWsPickerOpen(false)} />
          <div
            class="fixed z-[200] mt-1 min-w-[180px] overflow-hidden rounded-lg shadow-lg"
            style={{
              background: 'var(--c-bg-raised)',
              border: '1px solid var(--c-border)',
              top: 'var(--ws-picker-top, 40px)',
              left: 'var(--ws-picker-left, 60px)'
            }}
            ref={(el) => {
              // Position relative to parent button
              const btn = el.previousElementSibling?.previousElementSibling as HTMLElement
              if (btn) {
                const rect = btn.getBoundingClientRect()
                el.style.top = `${rect.bottom + 4}px`
                el.style.left = `${rect.left}px`
              }
            }}
          >
            <For each={orgList()}>
              {(org) => (
                <button
                  class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
                  style={{
                    color: org.id === ws()?.orgId ? 'var(--c-accent)' : 'var(--c-text)',
                    background: org.id === ws()?.orgId ? 'var(--c-hover-bg)' : undefined
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = org.id === ws()?.orgId ? 'var(--c-hover-bg)' : '')
                  }
                  onClick={() => {
                    setActiveWorkspace(org.id, org.name)
                    setWsPickerOpen(false)
                  }}
                >
                  <Show when={org.id === ws()?.orgId}>
                    <span class="text-xs">●</span>
                  </Show>
                  <span>{org.name}</span>
                </button>
              )}
            </For>
            <div style={{ 'border-top': '1px solid var(--c-border)' }}>
              <button
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
                style={{ color: 'var(--c-text-muted)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                onClick={() => {
                  setWsPickerOpen(false)
                  setShowAddDialog(true)
                }}
              >
                <span>+</span>
                <span>Add Workspace…</span>
              </button>
            </div>
          </div>
        </Show>
      </div>

      <Show when={showAddDialog()}>
        <AddWorkspaceDialog
          onClose={() => setShowAddDialog(false)}
          onCreated={(org) => {
            setShowAddDialog(false)
            setActiveWorkspace(org.id, org.name)
          }}
        />
      </Show>
      <span style={{ color: 'var(--c-text-muted)' }}>/</span>
      <div class="relative flex items-center">
        <button
          class="flex cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-1.5 py-0.5 text-sm font-medium transition-colors"
          style={{ color: 'var(--c-accent)', 'max-width': '140px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}
          onClick={() => {
            fetchOrgs()
            setThreadPickerOpen(!threadPickerOpen())
            setNewThreadInput(false)
            setMoveThreadKey(null)
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          title="Switch thread"
        >
          <span class="overflow-hidden text-ellipsis whitespace-nowrap">{activeThreadLabel()}</span>
          <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>▾</span>
        </button>
        <button
          class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border bg-transparent transition-all"
          style={{ color: 'var(--c-text-muted)', 'border-color': 'var(--c-border)' }}
          onClick={() => toggleChatExpanded()}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--c-hover-bg)'; e.currentTarget.style.color = 'var(--c-accent)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--c-text-muted)' }}
          title={chatExpanded() ? 'Minimize chat' : 'Maximize chat'}
        >
          <Show when={chatExpanded()} fallback={<ExpandIcon class="h-3.5 w-3.5" />}>
            <CollapseIcon class="h-3.5 w-3.5" />
          </Show>
        </button>
        <Show when={threadPickerOpen()}>
          <div class="fixed inset-0 z-[199]" onClick={() => setThreadPickerOpen(false)} />
          <div
            class="absolute top-full left-0 z-[200] mt-1 min-w-[200px] overflow-hidden rounded-lg shadow-lg"
            style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
          >
            <For each={[...threads().filter((t) => t.key)].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))}>
              {(t) => (
                <div
                  class="group relative flex w-full items-center text-left text-sm transition-colors"
                  style={{
                    color: t.key === threadKey() ? 'var(--c-accent)' : 'var(--c-text)',
                    background: t.key === threadKey() ? 'var(--c-hover-bg)' : undefined
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = t.key === threadKey() ? 'var(--c-hover-bg)' : '')
                  }
                >
                  <button
                    class="flex flex-1 items-center gap-2 px-3 py-2"
                    onClick={() => {
                      switchThread(t.key)
                      setThreadPickerOpen(false)
                    }}
                  >
                    <Show when={t.key === threadKey()}>
                      <span class="text-xs">●</span>
                    </Show>
                    <span class="truncate">{t.label ?? t.key}</span>
                  </button>
                  {/* Move to workspace button */}
                  <div class="relative">
                    <button
                      class="px-2 py-2 text-sm font-bold opacity-80 transition-opacity hover:!opacity-100"
                      style={{ color: 'var(--c-accent)' }}
                      title="Move to workspace"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMoveThreadKey(moveThreadKey() === t.key ? null : t.key)
                      }}
                    >
                      ⇄
                    </button>
                    <Show when={moveThreadKey() === t.key}>
                      <div
                        class="absolute top-0 left-full z-[210] ml-1 min-w-[150px] overflow-hidden rounded-lg shadow-lg"
                        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
                      >
                        <div
                          class="px-3 py-1.5 text-[10px] font-semibold tracking-wide uppercase"
                          style={{ color: 'var(--c-text-muted)' }}
                        >
                          Move to…
                        </div>
                        <For each={orgList().filter((o) => o.id !== t.orgId)}>
                          {(org) => (
                            <button
                              class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors"
                              style={{ color: 'var(--c-text)' }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                              onClick={() => {
                                moveThread(t.key, org.id)
                                setMoveThreadKey(null)
                                setThreadPickerOpen(false)
                              }}
                            >
                              {org.name}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </For>

            {/* Separator + New Thread */}
            <div class="mx-2 my-1 border-t" style={{ 'border-color': 'var(--c-border)' }} />
            <Show
              when={newThreadInput()}
              fallback={
                <button
                  class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors"
                  style={{ color: 'var(--c-text-muted)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  onClick={() => setNewThreadInput(true)}
                >
                  + New Thread
                </button>
              }
            >
              <div class="flex items-center gap-1 px-2 py-1.5">
                <input
                  class="flex-1 rounded border px-2 py-1 text-xs outline-none"
                  style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
                  placeholder="Thread name…"
                  value={newThreadLabel()}
                  onInput={(e) => setNewThreadLabel(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newThreadLabel().trim()) {
                      createThread(newThreadLabel().trim())
                      setNewThreadLabel('')
                      setNewThreadInput(false)
                      setThreadPickerOpen(false)
                    }
                    if (e.key === 'Escape') {
                      setNewThreadLabel('')
                      setNewThreadInput(false)
                    }
                  }}
                  ref={(el) => setTimeout(() => el.focus(), 0)}
                />
                <button
                  class="rounded px-2 py-1 text-xs font-medium text-white"
                  style={{ background: 'var(--c-accent)', opacity: newThreadLabel().trim() ? '1' : '0.4' }}
                  disabled={!newThreadLabel().trim()}
                  onClick={() => {
                    if (newThreadLabel().trim()) {
                      createThread(newThreadLabel().trim())
                      setNewThreadLabel('')
                      setNewThreadInput(false)
                      setThreadPickerOpen(false)
                    }
                  }}
                >
                  Create
                </button>
              </div>
            </Show>
          </div>
        </Show>
      </div>

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
      {/* Left: Agent icon — always navigates to dashboard */}
      <button class="shrink-0 cursor-pointer text-xl" onClick={() => setActiveView('dashboard')} title="Dashboard">{agentIcon()}</button>

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
        class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border bg-transparent transition-all"
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

      {/* Status dot */}
      <span
        class="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: statusStyle().color }}
        title={statusLabel()}
      />

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

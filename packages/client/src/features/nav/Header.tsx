import { createMemo, createSignal, Show, For, onCleanup } from 'solid-js'
import { connectionStatus } from '../connection/store.js'
import {
  viewMode,
  setViewMode,
  activeView,
  setActiveView,
  drawerOpen,
  setDrawerOpen,
  setSettingsOpen,
  type ViewMode,
  type NavView
} from '../nav/store.js'
import { threadKey } from '../threads/store.js'
import { formatRelativeTime } from '../threads/helpers.js'
import { isAudioPlaying, interruptPlayback } from '../voice/store.js'
import { turns, sendMessage } from '../chat/store.js'

// ── Exported helpers (used by tests) ─────────────────────────────────
export const VIEW_MODES = ['chat', 'voice', 'dashboard', 'recording'] as const

export function getViewModeIcon(mode: string): string {
  const icons: Record<string, string> = { chat: '💬', voice: '🎤', dashboard: '📊', recording: '🎙' }
  return icons[mode] || '📋'
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

const BASE = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'

// Stub helpers for features not yet wired
function isSubagentSession(sk: string): boolean {
  return sk.includes(':subagent:')
}
function getParentSessionKey(sk: string): string {
  const parts = sk.split(':subagent:')
  return parts.length > 1 ? parts[0] : 'main'
}
function switchThread(key: string, _label?: string): void {
  // Stub - will be wired to thread store
  if (typeof history !== 'undefined') {
    history.pushState(null, '', `#thread=${key}`)
  }
}
async function fetchSubagents(
  _sk: string
): Promise<Array<{ sessionKey: string; label: string; updatedAt?: number; totalTokens: number }>> {
  return [] // Stub
}

interface ForkState {
  progress: 'requesting-summary' | 'waiting-for-summary' | 'creating-fork' | 'done' | 'error'
  error?: string
}

export function Header() {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [subagentOpen, setSubagentOpen] = createSignal(false)
  const [warningCount, setWarningCount] = createSignal(0)
  const [subagentList, setSubagentList] = createSignal<
    Array<{ sessionKey: string; label: string; updatedAt?: number; totalTokens: number }>
  >([])

  const statusStyle = createMemo(() => {
    const s = connectionStatus()
    if (s === 'connected') return { background: 'rgba(74,255,138,0.1)', color: '#4aff8a' }
    if (s === 'error' || s === 'disconnected') return { background: 'rgba(255,74,106,0.1)', color: 'var(--c-danger)' }
    return { background: 'var(--c-hover-bg-strong)', color: 'var(--c-text-muted)' }
  })

  // Fetch warning count periodically (stubbed)
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

  // Thread status signals
  const [unreadThreadCount, _setUnreadThreadCount] = createSignal(0)
  const [threadBusy, _setThreadBusy] = createSignal(false)
  const [threadStuck, _setThreadStuck] = createSignal<{ reason: string; secs: number } | null>(null)
  const [retrying, setRetrying] = createSignal(false)
  const [laneErrors, _setLaneErrors] = createSignal<Array<{ timestamp: string; error: string; durationMs?: number }>>(
    []
  )
  const [showErrorPopover, setShowErrorPopover] = createSignal(false)
  const [showModelDropdown, setShowModelDropdown] = createSignal(false)
  const [showRecoveryMenu, setShowRecoveryMenu] = createSignal(false)
  const [forkState, setForkState] = createSignal<ForkState | null>(null)

  const AVAILABLE_MODELS = [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'gpt-5.2-codex',
    'o3',
    'gemini-2.5-pro',
    'default'
  ]

  function stuckLabel(s: { reason: string; secs: number }): string {
    const mins = Math.round(s.secs / 60)
    const time = mins > 0 ? `${mins}m` : `${s.secs}s`
    switch (s.reason) {
      case 'cooldown-error':
      case 'cooldown-after-work':
        return `Rate limited (${time})`
      case 'empty-response':
      case 'empty-after-work':
        return `No response (${time})`
      case 'unprocessed-message':
        return `Stuck (${time})`
      case 'lane-timeout':
        return `LLM timeout (${time})`
      case 'lane-error':
        return `Lane error (${time})`
      default:
        return `Stuck: ${s.reason} (${time})`
    }
  }

  const NUDGE_PREFIX = '[System] This is a nudge to unstick the session.'
  const NUDGE_MSG = NUDGE_PREFIX + ' Reply with only NO_REPLY.'

  function hasActiveNudge(): boolean {
    return turns().some((t) => t.pending && t.role === 'user' && t.content?.startsWith(NUDGE_PREFIX))
  }

  async function handleRetry(): Promise<void> {
    const sk = threadKey()
    if (!sk || retrying()) return
    if (hasActiveNudge()) return
    setRetrying(true)
    try {
      sendMessage(NUDGE_MSG)
    } catch (e) {
      console.error('[header] Retry failed:', e)
    } finally {
      setTimeout(() => setRetrying(false), 5000)
    }
  }

  async function handleClearLock(): Promise<void> {
    const sk = threadKey()
    if (!sk || retrying()) return
    setRetrying(true)
    try {
      await fetch(`${BASE}api/threads/clear-lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: sk })
      })
    } catch (e) {
      console.error('[header] Clear lock failed:', e)
    } finally {
      setTimeout(() => setRetrying(false), 3000)
    }
  }

  async function handleStop(): Promise<void> {
    const sk = threadKey()
    if (!sk || retrying()) return
    setRetrying(true)
    try {
      await fetch(`${BASE}api/threads/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: sk })
      })
    } catch (e) {
      console.error('[header] Stop failed:', e)
    } finally {
      setTimeout(() => setRetrying(false), 3000)
    }
  }

  async function handleSwitchModelRetry(model: string): Promise<void> {
    const sk = threadKey()
    if (!sk || retrying()) return
    if (hasActiveNudge()) return
    setRetrying(true)
    setShowModelDropdown(false)
    try {
      await fetch(`${BASE}api/threads/switch-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: sk, model })
      })
      sendMessage(`${NUDGE_PREFIX} Model switched to ${model}. Reply with only NO_REPLY.`)
    } catch (e) {
      console.error('[header] Switch model failed:', e)
    } finally {
      setTimeout(() => setRetrying(false), 5000)
    }
  }

  async function handleForkThread(): Promise<void> {
    setShowRecoveryMenu(false)
    setForkState({ progress: 'requesting-summary' })
    // Stub - fork not yet implemented
    setTimeout(() => setForkState({ progress: 'error', error: 'Not yet implemented' }), 2000)
    setTimeout(() => setForkState(null), 7000)
  }

  function forkStatusLabel(): string {
    const state = forkState()
    if (!state) return ''
    switch (state.progress) {
      case 'requesting-summary':
        return '🍴 Requesting summary…'
      case 'waiting-for-summary':
        return '🍴 Waiting for summary…'
      case 'creating-fork':
        return '🍴 Creating fork…'
      case 'done':
        return '🍴 Fork created!'
      case 'error':
        return `🍴 Fork failed: ${state.error}`
    }
  }

  // Load on mount
  loadWarningCount()
  const warnInterval = setInterval(loadWarningCount, 60_000)
  onCleanup(() => clearInterval(warnInterval))

  const totalBadge = createMemo(() => warningCount())

  const statusLabel = createMemo(() => {
    const s = connectionStatus()
    if (s === 'connecting') return 'connecting…'
    if (s === 'authenticating') return 'authenticating…'
    if (s === 'connected') return 'connected'
    if (s === 'disconnected') return 'disconnected'
    return 'error'
  })

  const headerTitle = createMemo(() => {
    const sk = threadKey()
    if (isSubagentSession(sk)) return sk.split(':subagent:').pop() || 'Subagent'
    return sk === 'main' ? 'Hex' : sk
  })

  const isThread = createMemo(() => {
    const sk = threadKey()
    return sk !== 'main' && !isSubagentSession(sk) && !sk.startsWith('cron:')
  })

  const isInSubagent = createMemo(() => {
    const sk = threadKey()
    return sk !== 'main' && (isSubagentSession(sk) || sk.startsWith('cron:'))
  })

  const parentKey = createMemo(() => getParentSessionKey(threadKey()))
  const toggleDrawer = () => setDrawerOpen(!drawerOpen())
  const selectMode = (mode: ViewMode) => {
    setActiveView('workspace')
    setViewMode(mode)
    setMenuOpen(false)
  }
  const selectView = (view: NavView) => {
    setActiveView(view)
    setMenuOpen(false)
  }

  const topLevelViews: Array<{ view: NavView; label: string; icon: string; shortcut: string }> = [
    { view: 'dashboard', label: 'Dashboard', icon: '🏠', shortcut: '⌘1' },
    { view: 'workspace', label: 'Workspace', icon: '📁', shortcut: '⌘2' },
    { view: 'canvas', label: 'Canvas', icon: '⬡', shortcut: '⌘3' },
    { view: 'planning', label: 'Planning', icon: '📊', shortcut: '⌘4' },
    { view: 'system', label: 'System', icon: '⚙️', shortcut: '⌘5' }
  ]

  const menuItems: Array<{ mode: ViewMode; label: string; icon: string }> = [
    { mode: 'chat', label: 'Chat', icon: '💬' },
    { mode: 'voice', label: 'Voice', icon: '🎙' },
    { mode: 'events', label: 'Events', icon: '🔔' },
    { mode: 'recording', label: 'Recording', icon: '⏺' },
    { mode: 'logs', label: 'Logs', icon: '📜' },
    { mode: 'files', label: 'Files', icon: '📂' },
    { mode: 'plans', label: 'Plans', icon: '🗺️' }
  ]

  return (
    <div
      class="safe-top z-[100] flex shrink-0 items-center gap-2 px-4 py-3"
      style={{ 'border-bottom': '1px solid var(--c-border)', background: 'var(--c-bg-raised)' }}
    >
      <span class="shrink-0 text-xl">⬡</span>

      {/* Back-to-main button (when viewing subagent) */}
      <Show when={viewMode() === 'chat' && isInSubagent()}>
        <button
          class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-all"
          style={{ background: 'var(--c-hover-bg)', color: 'var(--c-text-muted)' }}
          onClick={() => switchThread(parentKey())}
          title={`Back to main`}
        >
          ←
        </button>
      </Show>

      {/* Title area — opens thread drawer (chat only) */}
      <Show when={viewMode() === 'chat'}>
        <div
          class="tap-highlight-none relative flex min-w-0 flex-1 cursor-pointer flex-col rounded-lg px-2 py-1 transition-colors"
          onClick={toggleDrawer}
        >
          <div class="flex items-center gap-1.5">
            <span class="overflow-hidden text-base font-semibold text-ellipsis whitespace-nowrap">{headerTitle()}</span>
            <span
              class="shrink-0 text-[10px] transition-transform duration-200"
              style={{ color: 'var(--c-text-muted)' }}
              classList={{ 'rotate-180': drawerOpen() }}
            >
              ▾
            </span>
            <Show when={threadBusy()}>
              <span
                class="flex h-[18px] min-w-[18px] shrink-0 animate-pulse items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
                style={{ background: '#f59e0b' }}
              >
                ⏳
              </span>
            </Show>
            <Show when={unreadThreadCount() > 0}>
              <span
                class="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
                style={{ background: 'var(--c-accent)' }}
              >
                {unreadThreadCount() > 9 ? '9+' : unreadThreadCount()}
              </span>
            </Show>
          </div>
          <Show when={threadBusy()}>
            <div class="mt-0.5 flex items-center gap-1.5">
              <div class="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: '#f59e0b' }} />
              <span class="text-[10px]" style={{ color: '#f59e0b' }}>
                Processing…
              </span>
            </div>
          </Show>
          <Show when={!threadBusy() && threadStuck() !== null}>
            <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
              <div class="h-1.5 w-1.5 rounded-full" style={{ background: '#ef4444' }} />
              <span class="text-[10px]" style={{ color: '#ef4444' }}>
                {stuckLabel(threadStuck()!)}
              </span>
              <Show when={laneErrors().length > 0}>
                <button
                  class="rounded px-1 py-0.5 text-[9px]"
                  style={{ background: 'rgba(239,68,68,0.2)', color: '#ef4444', cursor: 'pointer', border: 'none' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowErrorPopover(!showErrorPopover())
                  }}
                >
                  {laneErrors().length} {laneErrors().length === 1 ? 'error' : 'errors'}
                </button>
              </Show>
              <button
                class="rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  background: '#ef4444',
                  color: 'white',
                  opacity: retrying() ? '0.5' : '1',
                  border: 'none',
                  cursor: 'pointer'
                }}
                disabled={retrying()}
                onClick={(e) => {
                  e.stopPropagation()
                  handleRetry()
                }}
              >
                {retrying() ? 'Retrying…' : hasActiveNudge() ? '🔄 Nudge queued' : '🔄 Retry'}
              </button>
              <button
                class="rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  background: '#f59e0b',
                  color: 'white',
                  opacity: retrying() ? '0.5' : '1',
                  border: 'none',
                  cursor: 'pointer'
                }}
                disabled={retrying()}
                onClick={(e) => {
                  e.stopPropagation()
                  handleClearLock()
                }}
              >
                🗑️ Clear Lock
              </button>
              <button
                class="rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  background: '#6b7280',
                  color: 'white',
                  opacity: retrying() ? '0.5' : '1',
                  border: 'none',
                  cursor: 'pointer'
                }}
                disabled={retrying()}
                onClick={(e) => {
                  e.stopPropagation()
                  handleStop()
                }}
              >
                ⏹️ Stop
              </button>
              <div class="relative">
                <button
                  class="rounded px-1.5 py-0.5 text-[10px]"
                  style={{
                    background: '#7c3aed',
                    color: 'white',
                    opacity: retrying() ? '0.5' : '1',
                    border: 'none',
                    cursor: 'pointer'
                  }}
                  disabled={retrying()}
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowModelDropdown(!showModelDropdown())
                  }}
                >
                  🔀 Switch Model
                </button>
                <Show when={showModelDropdown()}>
                  <div
                    class="fixed inset-0 z-[299]"
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowModelDropdown(false)
                    }}
                  />
                  <div
                    class="absolute top-full left-0 z-[300] mt-1 w-52 overflow-hidden rounded-lg shadow-lg"
                    style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
                  >
                    <For each={AVAILABLE_MODELS}>
                      {(model) => (
                        <button
                          class="w-full px-3 py-2 text-left text-[11px] transition-colors"
                          style={{
                            color: 'var(--c-text)',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer'
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleSwitchModelRetry(model)
                          }}
                        >
                          {model}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
            {/* Error popover */}
            <Show when={showErrorPopover() && laneErrors().length > 0}>
              <div
                class="mt-1 max-h-32 overflow-y-auto rounded-lg p-2 font-mono text-[9px]"
                style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <For each={laneErrors()}>
                  {(err) => (
                    <div class="py-0.5" style={{ color: '#fca5a5' }}>
                      <span style={{ color: 'var(--c-text-muted)' }}>
                        {new Date(err.timestamp).toLocaleTimeString()}
                      </span>{' '}
                      {err.error}
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
          {/* Fork progress indicator */}
          <Show when={forkState()}>
            <div class="mt-0.5 flex items-center gap-1.5">
              <Show when={forkState()!.progress !== 'error' && forkState()!.progress !== 'done'}>
                <div class="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--c-accent)' }} />
              </Show>
              <Show when={forkState()!.progress === 'done'}>
                <div class="h-1.5 w-1.5 rounded-full" style={{ background: '#4aff8a' }} />
              </Show>
              <Show when={forkState()!.progress === 'error'}>
                <div class="h-1.5 w-1.5 rounded-full" style={{ background: '#ef4444' }} />
              </Show>
              <span
                class="text-[10px]"
                style={{
                  color:
                    forkState()!.progress === 'error'
                      ? '#ef4444'
                      : forkState()!.progress === 'done'
                        ? '#4aff8a'
                        : 'var(--c-accent)'
                }}
              >
                {forkStatusLabel()}
              </span>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={viewMode() !== 'chat'}>
        <div class="min-w-0 flex-1 px-2 py-1">
          <span class="overflow-hidden text-base font-semibold text-ellipsis whitespace-nowrap">
            {viewMode() === 'logs'
              ? 'Logs'
              : viewMode() === 'voice'
                ? 'Voice'
                : viewMode() === 'recording'
                  ? 'Recording'
                  : viewMode() === 'dashboard'
                    ? 'Dashboard'
                    : viewMode() === 'architecture'
                      ? 'Architecture'
                      : viewMode() === 'files'
                        ? 'Files'
                        : viewMode() === 'plans'
                          ? 'Plans'
                          : viewMode() === 'events'
                            ? 'Events'
                            : 'Hex'}
          </span>
        </div>
      </Show>

      {/* Thread recovery menu (chat view, any thread) */}
      <Show when={viewMode() === 'chat' && isThread()}>
        <div class="relative shrink-0">
          <button
            class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border bg-transparent text-sm transition-all"
            style={{
              'border-color': showRecoveryMenu() ? 'var(--c-accent)' : threadStuck() ? '#ef4444' : 'var(--c-border)',
              color: showRecoveryMenu() ? 'var(--c-accent)' : threadStuck() ? '#ef4444' : 'var(--c-text-muted)'
            }}
            onClick={() => setShowRecoveryMenu(!showRecoveryMenu())}
            title="Thread recovery"
          >
            🔧
          </button>

          <Show when={showRecoveryMenu()}>
            <div class="fixed inset-0 z-[199]" onClick={() => setShowRecoveryMenu(false)} />
            <div
              class="absolute top-full right-0 z-[200] mt-1 w-48 overflow-hidden rounded-lg shadow-lg"
              style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
            >
              <div
                class="px-3 py-2 text-[11px] font-semibold tracking-wider uppercase"
                style={{ 'border-bottom': '1px solid var(--c-border)', color: 'var(--c-text-muted)' }}
              >
                Thread Recovery
              </div>
              <button
                class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] transition-colors"
                style={{ color: 'var(--c-text)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                disabled={retrying()}
                onClick={() => {
                  setShowRecoveryMenu(false)
                  handleRetry()
                }}
              >
                🔄 Retry
              </button>
              <button
                class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] transition-colors"
                style={{ color: 'var(--c-text)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                disabled={retrying()}
                onClick={() => {
                  setShowRecoveryMenu(false)
                  handleClearLock()
                }}
              >
                🗑️ Clear Lock
              </button>
              <button
                class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] transition-colors"
                style={{ color: '#ef4444', background: 'transparent', border: 'none', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                disabled={retrying()}
                onClick={() => {
                  setShowRecoveryMenu(false)
                  handleStop()
                }}
              >
                ⏹️ Stop
              </button>
              <div style={{ 'border-top': '1px solid var(--c-border)' }}>
                <button
                  class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] transition-colors"
                  style={{ color: 'var(--c-accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  disabled={!!forkState()}
                  onClick={() => handleForkThread()}
                >
                  🍴 Fork Thread
                </button>
              </div>
              <div style={{ 'border-top': '1px solid var(--c-border)' }}>
                <div
                  class="px-3 py-2 text-[10px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--c-text-muted)' }}
                >
                  Switch Model & Retry
                </div>
                <For each={AVAILABLE_MODELS}>
                  {(model) => (
                    <button
                      class="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors"
                      style={{ color: 'var(--c-text)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                      disabled={retrying()}
                      onClick={() => {
                        setShowRecoveryMenu(false)
                        handleSwitchModelRetry(model)
                      }}
                    >
                      🔀 {model}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      {/* Sub-agents dropdown (chat view) */}
      <Show when={viewMode() === 'chat'}>
        <div class="relative shrink-0">
          <button
            class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border bg-transparent text-sm transition-all"
            style={{
              'border-color': subagentOpen() ? 'var(--c-accent)' : 'var(--c-border)',
              color: subagentOpen() ? 'var(--c-accent)' : 'var(--c-text-muted)'
            }}
            onClick={async () => {
              const next = !subagentOpen()
              setSubagentOpen(next)
              if (next) {
                const list = await fetchSubagents(threadKey())
                setSubagentList(list)
              }
            }}
            title="Sub-agents"
          >
            🤖
          </button>

          <Show when={subagentOpen()}>
            <div class="fixed inset-0 z-[199]" onClick={() => setSubagentOpen(false)} />
            <div
              class="absolute top-full right-0 z-[200] mt-1 flex max-h-80 w-64 flex-col overflow-hidden rounded-lg shadow-lg"
              style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
            >
              <div
                class="px-3 py-2 text-[11px] font-semibold tracking-wider uppercase"
                style={{ 'border-bottom': '1px solid var(--c-border)', color: 'var(--c-text-muted)' }}
              >
                Sub-agents
              </div>
              <div class="flex-1 overflow-y-auto overscroll-contain">
                <Show when={subagentList().length === 0}>
                  <div class="px-4 py-6 text-center text-[13px]" style={{ color: 'var(--c-text-muted)' }}>
                    No sub-agent sessions
                  </div>
                </Show>
                <For each={subagentList()}>
                  {(sa) => (
                    <button
                      class="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors"
                      style={{
                        background:
                          threadKey() === sa.sessionKey
                            ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)'
                            : undefined
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = e.currentTarget.style.background || 'var(--c-hover-bg)')
                      }
                      onMouseLeave={(e) => {
                        if (threadKey() !== sa.sessionKey) e.currentTarget.style.background = ''
                      }}
                      onClick={() => {
                        switchThread(sa.sessionKey, sa.label)
                        setSubagentOpen(false)
                      }}
                    >
                      <span class="mt-0.5 shrink-0 text-xs">🔀</span>
                      <div class="min-w-0 flex-1">
                        <div class="overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap">
                          {sa.label}
                        </div>
                        <div class="mt-0.5 text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                          {sa.updatedAt ? formatRelativeTime(sa.updatedAt) : ''}
                          {sa.totalTokens > 0 && ` · ${Math.round(sa.totalTokens / 1000)}k tokens`}
                        </div>
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      {/* Status badge */}
      <span class="shrink-0 rounded-[10px] px-2 py-[3px] text-[11px] whitespace-nowrap" style={statusStyle()}>
        {statusLabel()}
      </span>

      {/* Stop/interrupt button */}
      <Show when={isAudioPlaying()}>
        <button
          class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border transition-all"
          style={{ 'border-color': 'var(--c-danger)', background: 'var(--c-rec-bg)', color: 'var(--c-danger)' }}
          onClick={interruptPlayback}
          title="Stop audio"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      </Show>

      {/* Hamburger menu button */}
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
              classList={{ 'warning-badge-pulse': warningCount() > 0 }}
              style={{ background: warningCount() > 0 ? '#ef4444' : 'var(--c-danger)' }}
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
            {/* Top-level views */}
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
                <span class="text-base">{item.icon}</span>
                <span class="flex-1">{item.label}</span>
                <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                  {item.shortcut}
                </span>
              </button>
            ))}
            {/* Workspace sub-views */}
            <div style={{ 'border-top': '1px solid var(--c-border)' }}>
              <div
                class="px-4 py-1.5 text-[10px] font-semibold tracking-wider uppercase"
                style={{ color: 'var(--c-text-muted)' }}
              >
                Workspace
              </div>
              {menuItems.map((item) => (
                <button
                  class="flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] transition-colors"
                  style={{
                    color:
                      activeView() === 'workspace' && viewMode() === item.mode ? 'var(--c-accent)' : 'var(--c-text)',
                    background:
                      activeView() === 'workspace' && viewMode() === item.mode ? 'var(--c-hover-bg)' : undefined
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background =
                      activeView() === 'workspace' && viewMode() === item.mode ? 'var(--c-hover-bg)' : '')
                  }
                  onClick={() => selectMode(item.mode)}
                >
                  <span class="text-sm">{item.icon}</span>
                  <span class="flex-1">{item.label}</span>
                </button>
              ))}
            </div>
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
                <span class="text-base">⚙️</span>
                <span class="flex-1">Settings</span>
              </button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

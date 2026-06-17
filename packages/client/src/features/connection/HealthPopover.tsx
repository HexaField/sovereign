import { createSignal, createMemo, onMount, onCleanup, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { connectionStatus, wsStatus, backendStatus } from './store.js'
import { threadKey } from '../threads/store.js'
import { wsStore } from '../../ws/index.js'

export interface McpHealth {
  status: 'ok' | 'down' | 'unknown'
  sessions: number
  tools: number
}

export interface CozempicHealth {
  healthy: boolean | null
  reason: string | null
}

export type OverallHealth = 'ok' | 'degraded' | 'error'

const [mcpHealth, setMcpHealth] = createSignal<McpHealth>({ status: 'unknown', sessions: 0, tools: 0 })
const [cozempicHealth, setCozempicHealth] = createSignal<CozempicHealth>({ healthy: null, reason: null })
const [cozempicRestoring, setCozempicRestoring] = createSignal(false)

export const overallHealth = (): OverallHealth => {
  const conn = connectionStatus()
  if (conn === 'error' || conn === 'disconnected') return 'error'

  const mcp = mcpHealth()
  if (mcp.status === 'down') return 'error'

  const coz = cozempicHealth()
  if (coz.healthy === false) return 'degraded'

  if (conn === 'connecting' || conn === 'authenticating' || mcp.status === 'unknown') return 'degraded'
  return 'ok'
}

export function initHealthPolling(): () => void {
  let cozTimer: ReturnType<typeof setInterval> | undefined

  wsStore.subscribe(['system'])
  const offHealth = wsStore.on('system.health', (msg: Record<string, unknown>) => {
    const services = msg.services as { mcp?: McpHealth } | undefined
    if (services?.mcp) setMcpHealth(services.mcp)
  })

  function pollCozempic() {
    const key = threadKey()
    if (!key) {
      setCozempicHealth({ healthy: null, reason: null })
      return
    }
    fetch(`/api/threads/${encodeURIComponent(key)}/cozempic-health`, {
      signal: AbortSignal.timeout(3000)
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setCozempicHealth({ healthy: data.healthy, reason: data.reason })
      })
      .catch(() => {})
  }

  pollCozempic()
  cozTimer = setInterval(pollCozempic, 15_000)

  return () => {
    offHealth()
    wsStore.unsubscribe(['system'])
    if (cozTimer) clearInterval(cozTimer)
  }
}

function StatusRow(props: {
  label: string
  status: 'ok' | 'warning' | 'error' | 'unknown'
  detail: string
  action?: { label: string; onClick: () => void; loading?: boolean }
}) {
  const dotColor = () => {
    if (props.status === 'ok') return '#4aff8a'
    if (props.status === 'warning' || props.status === 'unknown') return 'var(--c-amber, #f59e0b)'
    return 'var(--c-danger, #ff4a6a)'
  }
  return (
    <div class="flex items-center gap-2 py-1.5">
      <span class="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: dotColor() }} />
      <span class="flex-1 text-xs font-medium">{props.label}</span>
      <span class="text-xs opacity-60">{props.detail}</span>
      <Show when={props.action}>
        {(act) => (
          <button
            class="ml-1 cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors"
            style={{ background: 'var(--c-hover-bg)', color: 'var(--c-accent)' }}
            onClick={act().onClick}
            disabled={act().loading}
          >
            {act().loading ? '...' : act().label}
          </button>
        )}
      </Show>
    </div>
  )
}

export function HealthPopover(props: { open: boolean; onClose: () => void; anchorRef?: HTMLElement }) {
  let popoverRef: HTMLDivElement | undefined

  function handleClickOutside(e: MouseEvent) {
    if (popoverRef && !popoverRef.contains(e.target as Node) && !props.anchorRef?.contains(e.target as Node)) {
      props.onClose()
    }
  }

  onMount(() => document.addEventListener('mousedown', handleClickOutside))
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))

  const connRow = createMemo(() => {
    const ws = wsStatus()
    const backend = backendStatus()
    if (ws !== 'connected') return { status: 'error' as const, detail: `WS: ${ws}` }
    if (backend !== 'connected') return { status: 'warning' as const, detail: `backend: ${backend}` }
    return { status: 'ok' as const, detail: 'connected' }
  })

  const mcpRow = createMemo(() => {
    const h = mcpHealth()
    if (h.status === 'ok') return { status: 'ok' as const, detail: `${h.sessions} session(s), ${h.tools} tools` }
    if (h.status === 'unknown') return { status: 'unknown' as const, detail: 'checking...' }
    return { status: 'error' as const, detail: 'unreachable' }
  })

  const cozRow = createMemo(() => {
    const h = cozempicHealth()
    if (h.healthy === null)
      return { status: 'unknown' as const, detail: h.reason === 'no-session' ? 'no active session' : 'n/a' }
    if (h.healthy) return { status: 'ok' as const, detail: 'guard active' }
    const reasons: Record<string, string> = {
      'guard-exited': 'guard crashed',
      'no-pid-file': 'not started',
      'context-bloat': 'context overflow',
      'invalid-pid': 'invalid state'
    }
    return { status: 'error' as const, detail: reasons[h.reason ?? ''] ?? h.reason ?? 'unhealthy' }
  })

  async function restoreCozempic() {
    const key = threadKey()
    if (!key) return
    setCozempicRestoring(true)
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(key)}/cozempic-restore`, { method: 'POST' })
      if (res.ok) {
        setTimeout(() => {
          fetch(`/api/threads/${encodeURIComponent(key)}/cozempic-health`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (data) setCozempicHealth({ healthy: data.healthy, reason: data.reason })
            })
            .catch(() => {})
        }, 2000)
      }
    } finally {
      setCozempicRestoring(false)
    }
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={popoverRef}
          class="fixed z-[999] w-64 rounded-lg border p-3 shadow-lg"
          style={{
            background: 'var(--c-bg-raised)',
            'border-color': 'var(--c-border)',
            top: '44px',
            right: '48px'
          }}
        >
          <div class="mb-2 text-xs font-semibold tracking-wide uppercase opacity-60">Service Health</div>
          <div class="divide-y" style={{ 'border-color': 'var(--c-border)' }}>
            <StatusRow label="Connection" status={connRow().status} detail={connRow().detail} />
            <StatusRow label="MCP Sidecar" status={mcpRow().status} detail={mcpRow().detail} />
            <StatusRow
              label="Cozempic"
              status={cozRow().status}
              detail={cozRow().detail}
              action={
                cozRow().status === 'error'
                  ? { label: 'Restore', onClick: restoreCozempic, loading: cozempicRestoring() }
                  : undefined
              }
            />
          </div>
        </div>
      </Portal>
    </Show>
  )
}

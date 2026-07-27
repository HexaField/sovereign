import { createSignal, createMemo, onMount, onCleanup, Show, For } from 'solid-js'
import { Portal } from 'solid-js/web'
import { connectionStatus, wsStatus, backendStatus } from './store.js'
import { threadKey } from '../threads/store.js'
import { wsStore } from '../../ws/index.js'
import { ExternalLinkIcon } from '../../ui/icons.js'

export interface McpHealth {
  status: 'ok' | 'down' | 'unknown'
  sessions: number
  tools: number
}

export interface SembleHealth {
  status: 'ok' | 'down' | 'unknown'
  version: string
}

export interface AgentsCensusHealth {
  status: 'ok' | 'down' | 'unknown'
  interactive: number
  background: number
}

export interface ExternalServiceHealth {
  name: string
  label: string
  port: number
  path: string
  status: 'ok' | 'down' | 'unknown'
}

export interface CozempicHealth {
  healthy: boolean | null
  reason: string | null
}

export type OverallHealth = 'ok' | 'degraded' | 'error'

const [mcpHealth, setMcpHealth] = createSignal<McpHealth>({ status: 'unknown', sessions: 0, tools: 0 })
const [sembleHealth, setSembleHealth] = createSignal<SembleHealth>({ status: 'unknown', version: '' })
const [agentsHealth, setAgentsHealth] = createSignal<AgentsCensusHealth>({
  status: 'unknown',
  interactive: 0,
  background: 0
})
const [externalHealth, setExternalHealth] = createSignal<ExternalServiceHealth[]>([])
const [cozempicHealth, setCozempicHealth] = createSignal<CozempicHealth>({ healthy: null, reason: null })
const [cozempicRestoring, setCozempicRestoring] = createSignal(false)

export const overallHealth = (): OverallHealth => {
  const conn = connectionStatus()
  if (conn === 'error' || conn === 'disconnected') return 'error'

  const mcp = mcpHealth()
  if (mcp.status === 'down') return 'error'

  // Any external service being down degrades overall health but does not
  // hard-error — the Sovereign UI is still usable when AD4M or WE is offline.
  const ext = externalHealth()
  const anyExtDown = ext.some((s) => s.status === 'down')

  // Semble is an auxiliary code-search tool; missing degrades but doesn't error.
  const semble = sembleHealth()

  const coz = cozempicHealth()
  if (coz.healthy === false) return 'degraded'

  if (
    conn === 'connecting' ||
    conn === 'authenticating' ||
    mcp.status === 'unknown' ||
    semble.status === 'down' ||
    anyExtDown
  )
    return 'degraded'
  return 'ok'
}

export function initHealthPolling(): () => void {
  let cozTimer: ReturnType<typeof setInterval> | undefined

  wsStore.subscribe(['system'])
  const offHealth = wsStore.on('system.health', (msg: Record<string, unknown>) => {
    const services = msg.services as
      | {
          mcp?: McpHealth
          semble?: SembleHealth
          agents?: AgentsCensusHealth
          external?: ExternalServiceHealth[]
        }
      | undefined
    if (services?.mcp) setMcpHealth(services.mcp)
    if (services?.semble) setSembleHealth(services.semble)
    if (services?.agents) setAgentsHealth(services.agents)
    if (Array.isArray(services?.external)) setExternalHealth(services.external)
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
  port?: number | string
  openUrl?: string
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
      <Show when={props.port !== undefined}>
        <span
          class="rounded px-1 py-0.5 font-mono text-[10px]"
          style={{ background: 'var(--c-hover-bg)', color: 'var(--c-text-muted)' }}
          title="port"
        >
          :{props.port}
        </span>
      </Show>
      <span class="text-xs opacity-60">{props.detail}</span>
      <Show when={props.openUrl}>
        {(url) => (
          <a
            class="ml-0.5 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors"
            style={{ color: 'var(--c-accent)' }}
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${props.label} in new tab (${url()})`}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <ExternalLinkIcon class="h-3 w-3" />
          </a>
        )}
      </Show>
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

/**
 * Build the outward-facing URL for an external service. External services live
 * on the same host as Sovereign (adjacent Docker containers / systemd units on
 * Arcadia) — the browser reaches them via `hostname:port`. Force plain HTTP:
 * these run behind Tailscale, not TLS, so honouring the outer `window.location.protocol`
 * would break the link when Sovereign is fronted by HTTPS.
 */
export function buildOpenUrl(port: number, path: string, hostname?: string): string {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1')
  const p = path.startsWith('/') ? path : `/${path}`
  return `http://${host}:${port}${p}`
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

  // Sovereign's own origin port — whatever the browser reached us on. Empty
  // for default ports (80/443), in which case we omit the port badge entirely.
  const sovereignPort = createMemo(() => {
    if (typeof window === 'undefined') return undefined
    const p = window.location.port
    if (p) return p
    return window.location.protocol === 'https:' ? '443' : '80'
  })

  const connRow = createMemo(() => {
    const ws = wsStatus()
    const backend = backendStatus()
    if (ws !== 'connected') return { status: 'error' as const, detail: `WS: ${ws}` }
    if (backend !== 'connected') return { status: 'warning' as const, detail: `backend: ${backend}` }
    return { status: 'ok' as const, detail: 'connected' }
  })

  const mcpRow = createMemo(() => {
    const h = mcpHealth()
    if (h.status === 'ok') return { status: 'ok' as const, detail: `${h.sessions} sess · ${h.tools} tools` }
    if (h.status === 'unknown') return { status: 'unknown' as const, detail: 'checking...' }
    return { status: 'error' as const, detail: 'unreachable' }
  })

  const sembleRow = createMemo(() => {
    const h = sembleHealth()
    if (h.status === 'ok') return { status: 'ok' as const, detail: h.version ? `v${h.version}` : 'available' }
    if (h.status === 'unknown') return { status: 'unknown' as const, detail: 'checking...' }
    // `uv tool install semble` is the standard fix — surfaced in the tooltip.
    return { status: 'error' as const, detail: 'not installed' }
  })

  const agentsRow = createMemo(() => {
    const h = agentsHealth()
    if (h.status === 'unknown') return { status: 'unknown' as const, detail: 'checking...' }
    if (h.status === 'down') return { status: 'unknown' as const, detail: 'unavailable' }
    const bg = h.background > 0 ? ` · ${h.background} bg` : ''
    return { status: 'ok' as const, detail: `${h.interactive} session${h.interactive === 1 ? '' : 's'}${bg}` }
  })

  const externalRowStatus = (s: 'ok' | 'down' | 'unknown'): 'ok' | 'error' | 'unknown' => {
    if (s === 'ok') return 'ok'
    if (s === 'unknown') return 'unknown'
    return 'error'
  }
  const externalRowDetail = (s: 'ok' | 'down' | 'unknown'): string => {
    if (s === 'ok') return 'reachable'
    if (s === 'unknown') return 'checking...'
    return 'unreachable'
  }

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
          class="fixed z-[999] w-80 rounded-lg border p-3 shadow-lg"
          style={{
            background: 'var(--c-bg-raised)',
            'border-color': 'var(--c-border)',
            color: 'var(--c-text)',
            top: '44px',
            right: '48px'
          }}
        >
          <div class="mb-2 text-xs font-semibold tracking-wide uppercase opacity-60">Service Health</div>
          {/* Health rows render in order: Sovereign origin, MCP sidecar, per-thread Cozempic guard,
              then any externally-configured LAN services (AD4M dapp, WE launcher, …). */}
          <div class="divide-y" style={{ 'border-color': 'var(--c-border)' }}>
            <StatusRow label="Sovereign" status={connRow().status} detail={connRow().detail} port={sovereignPort()} />
            <StatusRow label="MCP Sidecar" status={mcpRow().status} detail={mcpRow().detail} />
            <StatusRow label="Semble" status={sembleRow().status} detail={sembleRow().detail} />
            <StatusRow label="Agent Sessions" status={agentsRow().status} detail={agentsRow().detail} />
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
            <For each={externalHealth()}>
              {(svc) => (
                <StatusRow
                  label={svc.label}
                  status={externalRowStatus(svc.status)}
                  detail={externalRowDetail(svc.status)}
                  port={svc.port}
                  openUrl={buildOpenUrl(svc.port, svc.path)}
                />
              )}
            </For>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

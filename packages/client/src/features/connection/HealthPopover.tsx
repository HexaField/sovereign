import { createSignal, createMemo, onMount, onCleanup, Show, For } from 'solid-js'
import { Portal } from 'solid-js/web'
import { connectionStatus, wsStatus, backendStatus } from './store.js'
import { threadKey } from '../threads/store.js'
import { wsStore } from '../../ws/index.js'
import { ExternalLinkIcon } from '../../ui/icons.js'
import { formatBytes } from '../system/HealthTab.js'

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

/** Layer 1/2/3 built-in context-management status — replaces the retired
 *  Cozempic guard-daemon health check. */
export interface ContextManagementHealth {
  healthy: boolean | null
  layer1: {
    enabled: boolean
    trimCount: number
    trimBytesReclaimed: number
    dedupCount: number
    dedupBytesReclaimed: number
  }
  layer2: { enabled: boolean; lastRecycleAt: number | null; recycleCount: number }
  layer3: { enabled: boolean }
}

export interface McpHealth {
  status: 'ok' | 'degraded' | 'down' | 'unknown'
  servers: Array<{ name: string; status: 'connected' | 'disconnected' | 'unknown' }>
  backendKind: string | null
}

export type OverallHealth = 'ok' | 'degraded' | 'error'

const CONTEXT_MGMT_HEALTH_UNKNOWN: ContextManagementHealth = {
  healthy: null,
  layer1: { enabled: false, trimCount: 0, trimBytesReclaimed: 0, dedupCount: 0, dedupBytesReclaimed: 0 },
  layer2: { enabled: false, lastRecycleAt: null, recycleCount: 0 },
  layer3: { enabled: false }
}

const [sembleHealth, setSembleHealth] = createSignal<SembleHealth>({ status: 'unknown', version: '' })
const [agentsHealth, setAgentsHealth] = createSignal<AgentsCensusHealth>({
  status: 'unknown',
  interactive: 0,
  background: 0
})
const [externalHealth, setExternalHealth] = createSignal<ExternalServiceHealth[]>([])
const [contextMgmtHealth, setContextMgmtHealth] = createSignal<ContextManagementHealth>(CONTEXT_MGMT_HEALTH_UNKNOWN)
const [mcpHealth, setMcpHealth] = createSignal<McpHealth>({ status: 'unknown', servers: [], backendKind: null })
const [mcpChecking, setMcpChecking] = createSignal(false)
const [mcpReconnecting, setMcpReconnecting] = createSignal(false)

/** User-triggered MCP status check for the current thread. */
export function checkMcpStatus(): void {
  const key = threadKey()
  if (!key || mcpChecking()) return
  setMcpChecking(true)
  fetch(`/api/threads/${encodeURIComponent(key)}/mcp-status`, {
    signal: AbortSignal.timeout(5000)
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) {
        setMcpHealth({ status: 'unknown', servers: [], backendKind: null })
        return
      }
      const servers: McpHealth['servers'] = data.servers ?? []
      const allConnected = servers.length > 0 && servers.every((s: any) => s.status === 'connected')
      const anyDisconnected = servers.some((s: any) => s.status === 'disconnected')
      const status: McpHealth['status'] = allConnected
        ? 'ok'
        : anyDisconnected
          ? servers.every((s: any) => s.status === 'disconnected')
            ? 'down'
            : 'degraded'
          : 'unknown'
      setMcpHealth({ status, servers, backendKind: data.backendKind ?? null })
    })
    .catch(() => setMcpHealth({ status: 'unknown', servers: [], backendKind: null }))
    .finally(() => setMcpChecking(false))
}

/** User-triggered MCP reconnect for the current thread. */
export function reconnectMcp(): void {
  const key = threadKey()
  if (!key || mcpReconnecting()) return
  setMcpReconnecting(true)
  fetch(`/api/threads/${encodeURIComponent(key)}/mcp-reconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000)
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.ok) {
        // Re-check status after reconnect
        setTimeout(checkMcpStatus, 1000)
      }
    })
    .catch(() => {})
    .finally(() => setMcpReconnecting(false))
}

export const overallHealth = (): OverallHealth => {
  const conn = connectionStatus()
  if (conn === 'error' || conn === 'disconnected') return 'error'

  // Any external service being down degrades overall health but does not
  // hard-error — the Sovereign UI is still usable when AD4M or WE is offline.
  const ext = externalHealth()
  const anyExtDown = ext.some((s) => s.status === 'down')

  // Semble is an auxiliary code-search tool; missing degrades but doesn't error.
  const semble = sembleHealth()

  const ctxMgmt = contextMgmtHealth()
  if (ctxMgmt.healthy === false) return 'degraded'

  if (conn === 'connecting' || conn === 'authenticating' || semble.status === 'down' || anyExtDown) return 'degraded'
  return 'ok'
}

export function initHealthPolling(): () => void {
  let ctxMgmtTimer: ReturnType<typeof setInterval> | undefined

  wsStore.subscribe(['system'])
  const offHealth = wsStore.on('system.health', (msg: Record<string, unknown>) => {
    const services = msg.services as
      | {
          semble?: SembleHealth
          agents?: AgentsCensusHealth
          external?: ExternalServiceHealth[]
        }
      | undefined
    if (services?.semble) setSembleHealth(services.semble)
    if (services?.agents) setAgentsHealth(services.agents)
    if (Array.isArray(services?.external)) setExternalHealth(services.external)
  })

  function pollContextHealth() {
    const key = threadKey()
    if (!key) {
      setContextMgmtHealth(CONTEXT_MGMT_HEALTH_UNKNOWN)
      return
    }
    fetch(`/api/threads/${encodeURIComponent(key)}/context-health`, {
      signal: AbortSignal.timeout(3000)
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return
        setContextMgmtHealth({
          healthy: data.healthy ?? null,
          layer1: {
            enabled: !!data.layer1?.enabled,
            trimCount: data.layer1?.trimCount ?? 0,
            trimBytesReclaimed: data.layer1?.trimBytesReclaimed ?? 0,
            dedupCount: data.layer1?.dedupCount ?? 0,
            dedupBytesReclaimed: data.layer1?.dedupBytesReclaimed ?? 0
          },
          layer2: {
            enabled: !!data.layer2?.enabled,
            lastRecycleAt: data.layer2?.lastRecycleAt ?? null,
            recycleCount: data.layer2?.recycleCount ?? 0
          },
          layer3: { enabled: !!data.layer3?.enabled }
        })
      })
      .catch(() => {})
  }

  pollContextHealth()
  ctxMgmtTimer = setInterval(pollContextHealth, 15_000)

  return () => {
    offHealth()
    wsStore.unsubscribe(['system'])
    if (ctxMgmtTimer) clearInterval(ctxMgmtTimer)
  }
}

function StatusRow(props: {
  label: string
  status: 'ok' | 'warning' | 'error' | 'unknown'
  detail: string
  port?: number | string
  openUrl?: string
  action?: { label: string; onClick: () => void; loading?: boolean }
  /** Native tooltip shown on hover — used for rows with more detail than fits inline. */
  title?: string
}) {
  const dotColor = () => {
    if (props.status === 'ok') return '#4aff8a'
    if (props.status === 'warning' || props.status === 'unknown') return 'var(--c-amber, #f59e0b)'
    return 'var(--c-danger, #ff4a6a)'
  }
  return (
    <div class="flex items-center gap-2 py-1.5" title={props.title}>
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
 * the primary host) — the browser reaches them via `hostname:port`. Force plain HTTP:
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

  const ctxMgmtRow = createMemo(() => {
    const h = contextMgmtHealth()
    if (h.healthy === null) return { status: 'unknown' as const, detail: 'checking...' }
    const enabledCount = [h.layer1.enabled, h.layer2.enabled, h.layer3.enabled].filter(Boolean).length
    if (enabledCount === 3) return { status: 'ok' as const, detail: 'all layers active' }
    if (enabledCount === 0) return { status: 'error' as const, detail: 'disabled' }
    return { status: 'warning' as const, detail: `${enabledCount}/3 layers active` }
  })

  // Hover tooltip — trim/dedup counts and reclaim totals don't fit the
  // single-line detail column, so they surface on hover instead.
  const mcpRow = createMemo(() => {
    const h = mcpHealth()
    if (h.status === 'unknown') return { status: 'unknown' as const, detail: 'not checked' }
    if (h.status === 'ok') {
      return { status: 'ok' as const, detail: `${h.servers.length} server${h.servers.length === 1 ? '' : 's'}` }
    }
    const disconnected = h.servers.filter((s) => s.status === 'disconnected')
    if (h.status === 'down') return { status: 'error' as const, detail: 'disconnected' }
    return { status: 'warning' as const, detail: `${disconnected.length} disconnected` }
  })

  const mcpTooltip = createMemo(() => {
    const h = mcpHealth()
    if (h.servers.length === 0) return 'Click "Check" to query MCP connection status'
    return h.servers.map((s) => `${s.name}: ${s.status}`).join('\n')
  })

  const mcpAction = createMemo(() => {
    const h = mcpHealth()
    const checking = mcpChecking()
    const reconnecting = mcpReconnecting()
    // Show "Reconnect" when any server disconnected; otherwise show "Check"
    if (h.status === 'down' || h.status === 'degraded') {
      return { label: 'Reconnect', onClick: reconnectMcp, loading: reconnecting }
    }
    return { label: 'Check', onClick: checkMcpStatus, loading: checking }
  })

  const ctxMgmtTooltip = createMemo(() => {
    const h = contextMgmtHealth()
    const l1 = h.layer1.enabled
      ? `Layer 1 filter: ${h.layer1.trimCount} trims, ${h.layer1.dedupCount} dedups, ` +
        `${formatBytes(h.layer1.trimBytesReclaimed + h.layer1.dedupBytesReclaimed)} reclaimed`
      : 'Layer 1 filter: disabled'
    const l2 = h.layer2.enabled
      ? `Layer 2 recycle: ${h.layer2.recycleCount} run${h.layer2.recycleCount === 1 ? '' : 's'}` +
        (h.layer2.lastRecycleAt ? `, last ${new Date(h.layer2.lastRecycleAt).toLocaleTimeString()}` : '')
      : 'Layer 2 recycle: disabled'
    const l3 = h.layer3.enabled ? 'Layer 3 cleanup: scheduled' : 'Layer 3 cleanup: disabled'
    return [l1, l2, l3].join('\n')
  })

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
          {/* Health rows: Sovereign origin, code search, agent sessions,
              per-thread context management (Layers 1/2/3), then any
              externally-configured LAN services (AD4M dapp, WE launcher, …). */}
          <div class="divide-y" style={{ 'border-color': 'var(--c-border)' }}>
            <StatusRow label="Sovereign" status={connRow().status} detail={connRow().detail} port={sovereignPort()} />
            <StatusRow label="Semble" status={sembleRow().status} detail={sembleRow().detail} />
            <StatusRow label="Agent Sessions" status={agentsRow().status} detail={agentsRow().detail} />
            <StatusRow
              label="Context Management"
              status={ctxMgmtRow().status}
              detail={ctxMgmtRow().detail}
              title={ctxMgmtTooltip()}
            />
            <StatusRow
              label="MCP Servers"
              status={mcpRow().status}
              detail={mcpRow().detail}
              title={mcpTooltip()}
              action={mcpAction()}
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

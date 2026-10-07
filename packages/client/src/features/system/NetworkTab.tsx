// Network Tab — live map of the tailnet and LAN: every device with its
// hardware, the services it runs, and the connections between them.
// Data: GET /api/system/network (server scans every device over SSH).

import { createSignal, createEffect, createMemo, on, onMount, onCleanup, For, Show, type Component } from 'solid-js'

// ── Types (mirror packages/system/src/network-map.ts) ──────────────────

type Exposure = 'loopback' | 'tailnet' | 'network'

export interface NetService {
  id: string
  name: string
  ports: number[]
  exposure?: Exposure
  unit?: string
}

export interface NetDevice {
  id: string
  label: string
  kind: 'host' | 'phone' | 'lan' | 'gateway' | 'internet'
  os?: string
  online: boolean
  hub?: boolean
  tailscaleIP?: string
  lanIPs: string[]
  mac?: string
  hardware?: {
    cpu?: string
    cores?: number
    memoryBytes?: number
    gpus: string[]
    disks: Array<{ name: string; bytes: number; model?: string }>
    peripherals: string[]
  }
  usage?: { cpuPercent?: number; memoryPercent?: number; gpuPercent?: number }
  traffic?: { rxBps: number; txBps: number }
  services: NetService[]
  error?: string
}

export interface NetLink {
  id: string
  from: string
  to: string
  kind: 'tcp' | 'tailnet' | 'lan' | 'wan' | 'proxy'
  connections?: number
  path?: string
  active?: boolean
  rateBps?: number
}

export interface NetworkMap {
  collectedAt: number
  devices: NetDevice[]
  links: NetLink[]
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type OnFocus = (id: string | null, sticky: boolean) => void

const POLL_MS = 10_000

// ── Helpers ────────────────────────────────────────────────────────────

/** The device a node id belongs to: service ids read `<device>/<name>`. */
export function deviceOf(id: string): string {
  const i = id.indexOf('/')
  return i < 0 ? id : id.slice(0, i)
}

/** tailscaled's peer API and bare port numbers say little; hidden unless asked for. */
export function isUnnamed(s: NetService): boolean {
  return /^port \d+$/.test(s.name) || s.name === 'Tailscale'
}

/** Links between whole devices: the LAN, the uplink and tailnet paths. */
const isDeviceLink = (l: NetLink) => l.kind === 'lan' || l.kind === 'wan' || l.kind === 'tailnet'

/** A link ends at the node: the service itself, or anything on the device. */
const touches = (l: NetLink, id: string) =>
  id.includes('/') ? l.from === id || l.to === id : deviceOf(l.from) === id || deviceOf(l.to) === id

/**
 * The links to draw. Without a focus: device-level links and service links
 * across devices, except the Internet ones (most processes have some). With a
 * focus: every link that touches it, inside a machine too.
 */
export function visibleLinks(links: NetLink[], focus: string | null): NetLink[] {
  return links.filter((l) => {
    if (isDeviceLink(l)) return true
    if (!focus) return deviceOf(l.from) !== deviceOf(l.to) && l.from !== 'internet' && l.to !== 'internet'
    return touches(l, focus)
  })
}

/** A curve from one box to another: vertical when stacked, a side loop when level. */
export function edgePath(a: Rect, b: Rect): string {
  const ax = a.x + a.w / 2
  const bx = b.x + b.w / 2
  if (b.y >= a.y + a.h) {
    const y1 = a.y + a.h
    const y2 = b.y
    const k = Math.max(30, (y2 - y1) / 2)
    return `M ${ax} ${y1} C ${ax} ${y1 + k}, ${bx} ${y2 - k}, ${bx} ${y2}`
  }
  if (a.y >= b.y + b.h) {
    const y1 = a.y
    const y2 = b.y + b.h
    const k = Math.max(30, (y1 - y2) / 2)
    return `M ${ax} ${y1} C ${ax} ${y1 - k}, ${bx} ${y2 + k}, ${bx} ${y2}`
  }
  // Side by side (or one inside the other): loop out past the right edge.
  const x1 = a.x + a.w
  const x2 = b.x + b.w
  const ay = a.y + a.h / 2
  const by = b.y + b.h / 2
  const bulge = Math.max(x1, x2) + 24 + Math.abs(ay - by) / 4
  return `M ${x1} ${ay} C ${bulge} ${ay}, ${bulge} ${by}, ${x2} ${by}`
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`
  if (bytes >= 1e9) return `${Math.round(bytes / 1e9)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

function fmtRate(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} KB/s`
  return `${Math.round(bps)} B/s`
}

const EXPOSURE: Record<Exposure, { label: string; color: string; title: string }> = {
  loopback: { label: 'local', color: '#6b7280', title: 'Listens on this machine only' },
  tailnet: { label: 'tailnet', color: '#3b82f6', title: 'Listens on the tailnet address' },
  network: { label: 'LAN', color: '#f59e0b', title: 'Listens on every interface (LAN and tailnet)' }
}

const LINK_COLOR: Record<NetLink['kind'], string> = {
  tcp: '#22c55e',
  proxy: '#a855f7',
  tailnet: '#3b82f6',
  lan: 'var(--c-text-muted)',
  wan: 'var(--c-text-muted)'
}

/**
 * Hover (mouse only: a touch screen never sends the leave, so focus would
 * stick) and tap to pin. Leaving a chip hands the hover back to its card.
 */
export function focusHandlers(id: () => string, onFocus: () => OnFocus, leaveTo: () => string | null = () => null) {
  return {
    onPointerEnter: (e: PointerEvent) => e.pointerType === 'mouse' && onFocus()(id(), false),
    onPointerLeave: (e: PointerEvent) => e.pointerType === 'mouse' && onFocus()(leaveTo(), false),
    onClick: (e: MouseEvent) => {
      e.stopPropagation()
      onFocus()(id(), true)
    }
  }
}

// ── Small parts ────────────────────────────────────────────────────────

function Meter(props: { pct?: number }) {
  return (
    <Show when={props.pct !== undefined}>
      <span
        class="ml-1 inline-block h-1.5 w-12 overflow-hidden rounded-full align-middle"
        style={{ background: 'var(--c-border)' }}
      >
        <span
          class="block h-full rounded-full transition-all duration-700"
          style={{
            width: `${Math.min(props.pct!, 100)}%`,
            background: props.pct! > 90 ? '#ef4444' : props.pct! > 75 ? '#f59e0b' : '#22c55e'
          }}
        />
      </span>
      <span class="ml-1 font-mono" style={{ color: 'var(--c-text-muted)' }}>
        {Math.round(props.pct!)}%
      </span>
    </Show>
  )
}

interface CardProps {
  dev: NetDevice
  services: NetService[]
  focus: string | null
  related: Set<string>
  onFocus: OnFocus
  tailnetPath?: string
}

function ServiceChip(props: { svc: NetService } & Pick<CardProps, 'focus' | 'related' | 'onFocus'>) {
  const exp = () => (props.svc.exposure ? EXPOSURE[props.svc.exposure] : undefined)
  const focused = () => props.focus === props.svc.id
  const dim = () => props.focus !== null && !focused() && !props.related.has(props.svc.id)
  return (
    <button
      data-node={props.svc.id}
      class="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-opacity"
      style={{
        background: focused() ? 'var(--c-accent)' : 'var(--c-bg)',
        color: focused() ? '#fff' : 'var(--c-text)',
        'border-color': props.related.has(props.svc.id) ? '#22c55e' : 'var(--c-border)',
        opacity: dim() ? 0.35 : 1
      }}
      title={[props.svc.unit, exp()?.title, props.svc.ports.length > 3 ? props.svc.ports.join(', ') : '']
        .filter(Boolean)
        .join(' · ')}
      {...focusHandlers(
        () => props.svc.id,
        () => props.onFocus,
        () => deviceOf(props.svc.id)
      )}
    >
      <span class="font-medium">{props.svc.name}</span>
      <Show when={props.svc.ports.length}>
        <span class="font-mono opacity-70">
          {props.svc.ports.length <= 3
            ? props.svc.ports.map((p) => `:${p}`).join(' ')
            : `${props.svc.ports.length} ports`}
        </span>
      </Show>
      <Show when={exp()}>
        <span
          class="rounded px-1 text-[9px] font-semibold uppercase"
          style={{ color: exp()!.color, border: `1px solid ${exp()!.color}` }}
        >
          {exp()!.label}
        </span>
      </Show>
      <Show when={!props.svc.ports.length}>
        <span class="text-[9px] uppercase opacity-60">client</span>
      </Show>
    </button>
  )
}

function HostCard(props: CardProps & { wide?: boolean }) {
  const d = () => props.dev
  const hw = () => d().hardware
  const muted = { color: 'var(--c-text-muted)' }
  return (
    <div
      data-node={d().id}
      class="rounded-lg border p-3"
      classList={{ 'w-full': !!props.wide, 'min-w-[min(260px,100%)] max-w-[440px] flex-1': !props.wide }}
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': props.focus === d().id ? 'var(--c-accent)' : d().hub ? '#22c55e' : 'var(--c-border)',
        opacity: d().online ? 1 : 0.55
      }}
      {...focusHandlers(
        () => d().id,
        () => props.onFocus
      )}
    >
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: d().online ? '#22c55e' : '#6b7280', opacity: d().online ? 1 : 0.5 }}
        />
        <span class="text-sm font-semibold">{d().label}</span>
        <Show when={d().hub}>
          <span
            class="rounded px-1.5 text-[10px] font-semibold uppercase"
            style={{ background: '#22c55e22', color: '#22c55e' }}
          >
            Sovereign
          </span>
        </Show>
        <span class="text-[11px]" style={muted}>
          {d().os}
        </span>
        <Show when={d().traffic}>
          <span class="ml-auto font-mono text-[11px]" style={muted}>
            ↓ {fmtRate(d().traffic!.rxBps)} ↑ {fmtRate(d().traffic!.txBps)}
          </span>
        </Show>
      </div>

      <div class="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px]" style={muted}>
        <For each={d().lanIPs}>{(ip) => <span>LAN {ip}</span>}</For>
        <Show when={d().tailscaleIP}>
          <span>tailnet {d().tailscaleIP}</span>
        </Show>
        <Show when={props.tailnetPath}>
          <span>via {props.tailnetPath}</span>
        </Show>
      </div>

      <Show when={d().error}>
        <div class="mt-1 text-[11px]" style={{ color: '#ef4444' }}>
          {d().error}
        </div>
      </Show>

      <Show when={hw()}>
        <div class="mt-2 grid gap-0.5 text-[11px]" style={{ 'grid-template-columns': 'auto 1fr' }}>
          <Show when={hw()!.cpu}>
            <span class="pr-2" style={muted}>
              CPU
            </span>
            <span>
              {hw()!.cpu}
              <Show when={hw()!.cores}> · {hw()!.cores} threads</Show>
              <Meter pct={d().usage?.cpuPercent} />
            </span>
          </Show>
          <Show when={hw()!.memoryBytes}>
            <span class="pr-2" style={muted}>
              Memory
            </span>
            <span>
              {Math.round(hw()!.memoryBytes! / 1024 ** 3)} GB
              <Meter pct={d().usage?.memoryPercent} />
            </span>
          </Show>
          <For each={hw()!.gpus}>
            {(gpu, i) => (
              <>
                <span class="pr-2" style={muted}>
                  {i() === 0 ? 'GPU' : ''}
                </span>
                <span>
                  {gpu}
                  <Show when={i() === 0}>
                    <Meter pct={d().usage?.gpuPercent} />
                  </Show>
                </span>
              </>
            )}
          </For>
          <Show when={hw()!.disks.length}>
            <span class="pr-2" style={muted}>
              Storage
            </span>
            <span>
              {hw()!
                .disks.map((k) => `${fmtBytes(k.bytes)} ${k.model ?? k.name}`)
                .join(' · ')}
            </span>
          </Show>
          <Show when={hw()!.peripherals.length}>
            <span class="pr-2" style={muted}>
              Devices
            </span>
            <span>{hw()!.peripherals.join(' · ')}</span>
          </Show>
        </div>
      </Show>

      <Show when={props.services.length}>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <For each={props.services}>
            {(svc) => <ServiceChip svc={svc} focus={props.focus} related={props.related} onFocus={props.onFocus} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

function SmallNode(props: { dev: NetDevice; focus: string | null; onFocus: OnFocus; sub?: string }) {
  const icon = () => ({ internet: '🌐', gateway: '📡', phone: '📱', lan: '▣', host: '🖥' })[props.dev.kind]
  return (
    <div
      data-node={props.dev.id}
      class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': props.focus === props.dev.id ? 'var(--c-accent)' : 'var(--c-border)',
        opacity: props.dev.online ? 1 : 0.55
      }}
      {...focusHandlers(
        () => props.dev.id,
        () => props.onFocus
      )}
      title={props.dev.mac ? `MAC ${props.dev.mac}` : undefined}
    >
      <span>{icon()}</span>
      <div>
        <div class="font-medium">{props.dev.label}</div>
        <Show when={props.sub}>
          <div class="font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            {props.sub}
          </div>
        </Show>
      </div>
    </div>
  )
}

// ── Tab ────────────────────────────────────────────────────────────────

const NetworkTab: Component = () => {
  const [map, setMap] = createSignal<NetworkMap | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [live, setLive] = createSignal(true)
  const [showUnnamed, setShowUnnamed] = createSignal(false)
  const [pinned, setPinned] = createSignal<string | null>(null)
  const [hovered, setHovered] = createSignal<string | null>(null)
  const [rects, setRects] = createSignal<Record<string, Rect>>({})
  const [now, setNow] = createSignal(Date.now())
  let canvas: HTMLDivElement | undefined
  let frame = 0

  const focus = () => hovered() ?? pinned()

  async function load() {
    if (loading()) return
    setLoading(true)
    try {
      const res = await fetch('/api/system/network')
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      setMap(body)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'failed to load')
    } finally {
      setLoading(false)
    }
  }

  /** Edge anchors: every [data-node] box, relative to the canvas. Runs after layout. */
  function measure() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      if (!canvas) return
      const base = canvas.getBoundingClientRect()
      const out: Record<string, Rect> = {}
      canvas.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => {
        const r = el.getBoundingClientRect()
        out[el.dataset.node!] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }
      })
      setRects(out)
    })
  }

  onMount(() => {
    void load()
    const poll = setInterval(() => {
      if (live() && !document.hidden) void load()
    }, POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const ro = new ResizeObserver(measure)
    ro.observe(canvas!)
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(tick)
      ro.disconnect()
      cancelAnimationFrame(frame)
    })
  })

  // A pinned hidden service shows its chip, so pinning can change the layout too.
  createEffect(on([map, showUnnamed, pinned], measure))

  const devices = () => map()?.devices ?? []
  const hub = () => devices().find((d) => d.hub)
  const top = () => devices().filter((d) => d.kind === 'internet' || d.kind === 'gateway' || d.kind === 'lan')
  const others = () => devices().filter((d) => (d.kind === 'host' && !d.hub) || d.kind === 'phone')
  const byId = createMemo(() => {
    const out = new Map<string, { label: string; device: string }>()
    for (const d of devices()) {
      out.set(d.id, { label: d.label, device: d.label })
      for (const s of d.services) out.set(s.id, { label: s.name, device: d.label })
    }
    return out
  })
  const tailnetPath = (id: string) => {
    const l = map()?.links.find((k) => k.kind === 'tailnet' && k.to === id)
    if (!l?.path) return undefined
    return [l.path, l.active ? (l.rateBps ? fmtRate(l.rateBps) : 'active') : 'idle'].join(' · ')
  }

  const servicesOf = (d: NetDevice) =>
    d.services
      .filter((s) => showUnnamed() || !isUnnamed(s) || s.id === pinned())
      .sort((a, b) => Number(!a.ports.length) - Number(!b.ports.length) || a.name.localeCompare(b.name))

  const drawn = createMemo(() => visibleLinks(map()?.links ?? [], focus()))
  // Node ids at the far end of the focused node's links.
  const related = createMemo(() => {
    const f = focus()
    const out = new Set<string>()
    if (!f) return out
    for (const l of drawn()) {
      if (l.from === f || deviceOf(l.from) === f) out.add(l.to)
      if (l.to === f || deviceOf(l.to) === f) out.add(l.from)
    }
    return out
  })

  // A hidden service draws from its device's card.
  const anchor = (id: string): Rect | undefined => rects()[id] ?? rects()[deviceOf(id)]

  const onFocus: OnFocus = (id, sticky) => {
    if (sticky) setPinned((p) => (p === id ? null : id))
    else setHovered(id)
  }

  const counts = createMemo(() => {
    const hosts = devices().filter((d) => d.kind === 'host' || d.kind === 'phone')
    return {
      online: hosts.filter((d) => d.online).length,
      hosts: hosts.length,
      services: hosts.reduce((n, d) => n + d.services.filter((s) => s.ports.length).length, 0),
      connections: (map()?.links ?? []).reduce((n, l) => n + (l.connections ?? 0), 0)
    }
  })

  const selected = createMemo(() => {
    const id = pinned()
    const m = map()
    if (!id || !m) return null
    const service = id.includes('/')
    const links = m.links.filter((l) => touches(l, id))
    return {
      id,
      service: devices()
        .flatMap((d) => d.services)
        .find((s) => s.id === id),
      inbound: links.filter((l) => l.to === id || (!service && deviceOf(l.to) === id && deviceOf(l.from) !== id)),
      outbound: links.filter((l) => l.from === id || (!service && deviceOf(l.from) === id && deviceOf(l.to) !== id))
    }
  })

  const nodeName = (id: string) => {
    const info = byId().get(id)
    if (!info) return id
    return id.includes('/') ? `${info.label} · ${info.device}` : info.label
  }

  /** Edges for one layer: `over` draws a focused node's links above the cards. */
  const Edges = (props: { links: NetLink[]; over?: boolean }) => (
    <For each={props.links}>
      {(l) => {
        const a = () => anchor(l.from)
        const b = () => anchor(l.to)
        const dim = () =>
          !props.over && focus() !== null && ![l.from, l.to].some((id) => id === focus() || related().has(id))
        return (
          <Show when={a() && b()}>
            <path
              d={edgePath(a()!, b()!)}
              fill="none"
              stroke={LINK_COLOR[l.kind]}
              stroke-width={l.kind === 'tailnet' ? 1.5 : 1 + Math.log2(l.connections ?? 1)}
              opacity={props.over ? 0.95 : dim() ? 0.15 : l.kind === 'lan' || l.kind === 'wan' ? 0.4 : 0.8}
              class={
                l.kind === 'lan' || l.kind === 'wan' ? '' : l.kind === 'tailnet' && !l.active ? 'net-idle' : 'net-flow'
              }
            />
            <Show when={props.over && l.kind === 'tcp' && (l.connections ?? 0) > 1}>
              <text
                x={(a()!.x + a()!.w / 2 + b()!.x + b()!.w / 2) / 2}
                y={(a()!.y + a()!.h / 2 + b()!.y + b()!.h / 2) / 2}
                font-size="10"
                text-anchor="middle"
                fill={LINK_COLOR[l.kind]}
                style={{ 'paint-order': 'stroke', stroke: 'var(--c-bg)', 'stroke-width': '3px' }}
              >
                ×{l.connections}
              </text>
            </Show>
          </Show>
        )
      }}
    </For>
  )

  const buttonStyle = { background: 'transparent', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }

  return (
    <div class="flex flex-col gap-3" onClick={() => setPinned(null)}>
      <style>{`
        @keyframes net-flow { to { stroke-dashoffset: -16; } }
        .net-flow { stroke-dasharray: 6 4; animation: net-flow 1.2s linear infinite; }
        .net-idle { stroke-dasharray: 2 6; }
      `}</style>

      <div class="flex flex-wrap items-center gap-3 text-xs">
        <span class="flex items-center gap-1.5">
          <span
            class="inline-block h-2 w-2 rounded-full"
            classList={{ 'animate-pulse': live() && !error() }}
            style={{ background: error() ? '#ef4444' : live() ? '#22c55e' : '#6b7280' }}
          />
          {live() ? 'Live' : 'Paused'}
        </span>
        <Show when={map()}>
          <span style={{ color: 'var(--c-text-muted)' }}>
            {counts().online}/{counts().hosts} devices online · {counts().services} services · {counts().connections}{' '}
            connections · updated {Math.max(0, Math.round((now() - map()!.collectedAt) / 1000))}s ago
          </span>
        </Show>
        <div class="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <label class="flex cursor-pointer items-center gap-1" style={{ color: 'var(--c-text-muted)' }}>
            <input type="checkbox" checked={showUnnamed()} onChange={(e) => setShowUnnamed(e.currentTarget.checked)} />
            Unnamed ports
          </label>
          <button
            class="cursor-pointer rounded-md border px-2 py-1"
            style={buttonStyle}
            onClick={() => {
              setLive(!live())
              if (live()) void load()
            }}
          >
            {live() ? 'Pause' : 'Resume'}
          </button>
          <button
            class="cursor-pointer rounded-md border px-2 py-1"
            style={buttonStyle}
            disabled={loading()}
            onClick={() => void load()}
          >
            {loading() ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
      </div>

      <Show when={error()}>
        <div class="text-xs" style={{ color: '#ef4444' }}>
          {error()}
        </div>
      </Show>
      <Show when={!map() && loading()}>
        <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
          Scanning devices…
        </div>
      </Show>

      <div ref={canvas} class="relative flex flex-col gap-12 pr-10 pb-6">
        {/* Device-level links sit behind the cards; so do service links until something has focus. */}
        <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" style={{ 'z-index': 0 }}>
          <Edges links={focus() ? drawn().filter(isDeviceLink) : drawn()} />
        </svg>

        <div class="relative flex flex-wrap items-center justify-center gap-3" style={{ 'z-index': 1 }}>
          <For each={top()}>
            {(d) => (
              <SmallNode
                dev={d}
                focus={focus()}
                onFocus={onFocus}
                sub={d.kind === 'internet' ? undefined : [d.lanIPs[0], d.mac].filter(Boolean).join(' · ')}
              />
            )}
          </For>
        </div>

        <Show when={hub()}>
          <div class="relative" style={{ 'z-index': 1 }}>
            <HostCard
              dev={hub()!}
              services={servicesOf(hub()!)}
              focus={focus()}
              related={related()}
              onFocus={onFocus}
              wide
            />
          </div>
        </Show>

        <div class="relative flex flex-wrap items-start gap-4" style={{ 'z-index': 1 }}>
          <For each={others()}>
            {(d) =>
              d.kind === 'phone' ? (
                <SmallNode
                  dev={d}
                  focus={focus()}
                  onFocus={onFocus}
                  sub={[d.tailscaleIP, tailnetPath(d.id)].filter(Boolean).join(' · ')}
                />
              ) : (
                <HostCard
                  dev={d}
                  services={servicesOf(d)}
                  focus={focus()}
                  related={related()}
                  onFocus={onFocus}
                  tailnetPath={tailnetPath(d.id)}
                />
              )
            }
          </For>
        </div>

        <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" style={{ 'z-index': 2 }}>
          <Edges links={focus() ? drawn().filter((l) => !isDeviceLink(l)) : []} over />
        </svg>
      </div>

      <Show when={selected()}>
        {(sel) => (
          <div
            class="rounded-lg border p-3 text-xs"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div class="mb-1 text-sm font-semibold">{nodeName(sel().id)}</div>
            <Show when={sel().service}>
              {(svc) => (
                <div class="mb-2 font-mono text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                  {[
                    svc().ports.length ? `ports ${svc().ports.join(', ')}` : 'connects out only',
                    svc().exposure ? EXPOSURE[svc().exposure!].title : '',
                    svc().unit ?? ''
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </Show>
            <div class="grid gap-3 sm:grid-cols-2">
              <For
                each={
                  [
                    ['Inbound', sel().inbound, 'from'],
                    ['Outbound', sel().outbound, 'to']
                  ] as const
                }
              >
                {([title, links, end]) => (
                  <div>
                    <div class="mb-1 font-semibold" style={{ color: 'var(--c-text-muted)' }}>
                      {title}
                    </div>
                    <Show when={links.length} fallback={<div style={{ color: 'var(--c-text-muted)' }}>none</div>}>
                      <For each={links}>
                        {(l) => (
                          <button
                            class="block cursor-pointer border-none bg-transparent p-0 text-left text-xs"
                            style={{ color: 'var(--c-text)' }}
                            onClick={() => setPinned(l[end])}
                          >
                            <span style={{ color: LINK_COLOR[l.kind] }}>●</span> {nodeName(l[end])}
                            <span style={{ color: 'var(--c-text-muted)' }}>
                              {' '}
                              {l.kind === 'tcp' ? `${l.connections} conn` : l.kind}
                              {l.path ? ` · ${l.path}` : ''}
                            </span>
                          </button>
                        )}
                      </For>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>

      <div class="flex flex-wrap gap-3 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
        <span>
          <span style={{ color: LINK_COLOR.tcp }}>━</span> TCP connection (width = count)
        </span>
        <span>
          <span style={{ color: LINK_COLOR.proxy }}>━</span> Tailscale Serve proxy
        </span>
        <span>
          <span style={{ color: LINK_COLOR.tailnet }}>┅</span> tailnet path
        </span>
        <span>━ LAN / internet uplink</span>
        <span>Hover or tap a service to see all its links, including ones inside a machine.</span>
      </div>
    </div>
  )
}

export default NetworkTab

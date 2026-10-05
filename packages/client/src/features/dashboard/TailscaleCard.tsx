import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { selectedDeviceIp, setSelectedDeviceIp } from './device-selection.js'

interface TailscaleNode {
  hostname: string
  os: string
  online: boolean
  tailscaleIPs: string[]
  lastSeen?: string | null
  relay?: string
}

interface TailscaleData {
  self: TailscaleNode | null
  peers: TailscaleNode[]
  error?: string
}

function osIcon(os: string): string {
  const l = os.toLowerCase()
  if (l.includes('linux')) return 'L'
  if (l.includes('macos') || l.includes('darwin')) return 'M'
  if (l.includes('android')) return 'A'
  if (l.includes('ios')) return 'i'
  if (l.includes('windows')) return 'W'
  return '?'
}

/** One node; clicking it shows that device in the Device card. */
function NodeRow(props: { node: TailscaleNode; isSelf?: boolean }) {
  const ip = () => props.node.tailscaleIPs?.[0] ?? null
  const selected = () => (props.isSelf ? selectedDeviceIp() === null : !!ip() && selectedDeviceIp() === ip())
  return (
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 rounded border-none px-2 py-1.5 text-left transition-colors"
      style={{ background: selected() ? 'var(--c-hover-bg)' : 'transparent' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = selected() ? 'var(--c-hover-bg)' : 'transparent')}
      onClick={() => setSelectedDeviceIp(props.isSelf ? null : ip())}
      title={`Show ${props.node.hostname || 'this device'} in the Device card`}
    >
      <span
        class="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{
          background: props.node.online ? '#4aff8a' : 'var(--c-text-muted)',
          opacity: props.node.online ? 1 : 0.3
        }}
      />
      <span
        class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold"
        style={{ background: 'var(--c-border)', color: 'var(--c-text-muted)' }}
      >
        {osIcon(props.node.os)}
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-1">
          <span class="truncate text-[11px] font-medium" style={{ color: 'var(--c-text)' }}>
            {props.node.hostname || 'unknown'}
          </span>
          <Show when={props.isSelf}>
            <span class="text-[9px]" style={{ color: 'var(--c-text-muted)' }}>
              (this)
            </span>
          </Show>
        </div>
        <Show when={ip()}>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            {ip()}
          </span>
        </Show>
      </div>
    </button>
  )
}

export default function TailscaleCard() {
  const [data, setData] = createSignal<TailscaleData | null>(null)

  let interval: ReturnType<typeof setInterval> | undefined

  async function load() {
    try {
      const res = await fetch('/api/system/tailscale')
      if (res.ok) setData(await res.json())
    } catch {
      /* ignore */
    }
  }

  onMount(() => {
    load()
    interval = setInterval(load, 30_000)
  })

  onCleanup(() => clearInterval(interval))

  const onlineCount = () => {
    const d = data()
    if (!d) return 0
    return (d.self ? 1 : 0) + d.peers.filter((p) => p.online).length
  }

  const totalCount = () => {
    const d = data()
    if (!d) return 0
    return (d.self ? 1 : 0) + d.peers.length
  }

  return (
    <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          Tailscale
        </h3>
        <Show when={data()}>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            {onlineCount()}/{totalCount()} online
          </span>
        </Show>
      </div>

      <Show when={data()} fallback={<p class="text-[11px] opacity-40">Loading...</p>}>
        {(d) => (
          <Show when={!d().error} fallback={<p class="text-[11px] opacity-40">{d().error}</p>}>
            <div class="space-y-0.5">
              <Show when={d().self}>{(self) => <NodeRow node={self()} isSelf />}</Show>
              <For each={d().peers.sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1))}>
                {(peer) => <NodeRow node={peer} />}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </div>
  )
}

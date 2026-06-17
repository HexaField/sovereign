import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'

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

function NodeRow(props: { node: TailscaleNode; isSelf?: boolean }) {
  return (
    <div
      class="flex items-center gap-2 rounded px-2 py-1.5"
      style={{ background: props.isSelf ? 'var(--c-hover-bg)' : 'transparent' }}
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
        <Show when={props.node.tailscaleIPs?.length}>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            {props.node.tailscaleIPs[0]}
          </span>
        </Show>
      </div>
    </div>
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

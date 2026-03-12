import { createSignal, onCleanup, onMount, type Component, Show, For } from 'solid-js'

interface ModuleInfo {
  name: string
  status: 'ok' | 'degraded' | 'error'
}

interface StatusState {
  connection: 'connected' | 'disconnected' | 'reconnecting'
  activeJobs: number
  unreadNotifications: number
  org?: string
  project?: string
  modules: ModuleInfo[]
}

const statusColors = {
  connected: 'bg-green-500',
  disconnected: 'bg-red-500',
  reconnecting: 'bg-yellow-500'
}

const moduleStatusColors = {
  ok: 'bg-green-400',
  degraded: 'bg-yellow-400',
  error: 'bg-red-400'
}

const StatusBar: Component = () => {
  const [status, setStatus] = createSignal<StatusState>({
    connection: 'disconnected',
    activeJobs: 0,
    unreadNotifications: 0,
    modules: []
  })
  const [expanded, setExpanded] = createSignal(false)

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 1000
  const MAX_RECONNECT_DELAY = 30000

  const connect = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/ws`)

    ws.onopen = () => {
      setStatus((s) => ({ ...s, connection: 'connected' }))
      reconnectDelay = 1000
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'status.update') {
          setStatus(msg.payload)
        }
      } catch {
        // ignore malformed messages
      }
    }

    ws.onclose = () => {
      setStatus((s) => ({ ...s, connection: 'disconnected' }))
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  const scheduleReconnect = () => {
    setStatus((s) => ({ ...s, connection: 'reconnecting' }))
    reconnectTimer = setTimeout(() => {
      connect()
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
    }, reconnectDelay)
  }

  onMount(() => {
    connect()
  })

  onCleanup(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
  })

  return (
    <div class="fixed right-0 bottom-0 left-0 z-50 border-t border-zinc-700 bg-zinc-900 text-xs text-zinc-300">
      {/* Main bar — always visible */}
      <div
        class="flex cursor-pointer items-center justify-between px-3 py-1.5 select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        <div class="flex items-center gap-3">
          {/* Connection indicator */}
          <div class="flex items-center gap-1.5">
            <div class={`h-2 w-2 rounded-full ${statusColors[status().connection]}`} />
            <span class="hidden sm:inline">{status().connection}</span>
          </div>

          {/* Org / Project context */}
          <Show when={status().org}>
            <span class="text-zinc-500">
              {status().org}
              <Show when={status().project}>
                <span class="text-zinc-400"> / {status().project}</span>
              </Show>
            </span>
          </Show>
        </div>

        <div class="flex items-center gap-3">
          {/* Active jobs */}
          <Show when={status().activeJobs > 0}>
            <div class="flex items-center gap-1">
              <div class="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
              <span>
                {status().activeJobs} job{status().activeJobs !== 1 ? 's' : ''}
              </span>
            </div>
          </Show>

          {/* Notifications badge */}
          <Show when={status().unreadNotifications > 0}>
            <div class="flex items-center gap-1">
              <span class="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] leading-none font-medium text-white">
                {status().unreadNotifications}
              </span>
            </div>
          </Show>

          {/* Module indicators (compact) */}
          <div class="flex items-center gap-1">
            <For each={status().modules}>
              {(mod) => (
                <div
                  class={`h-2 w-2 rounded-full ${moduleStatusColors[mod.status]}`}
                  title={`${mod.name}: ${mod.status}`}
                />
              )}
            </For>
          </div>
        </div>
      </div>

      {/* Expanded detail — progressive disclosure */}
      <Show when={expanded()}>
        <div class="space-y-1 border-t border-zinc-700 px-3 py-2">
          <For each={status().modules}>
            {(mod) => (
              <div class="flex items-center gap-2">
                <div class={`h-2 w-2 rounded-full ${moduleStatusColors[mod.status]}`} />
                <span>{mod.name}</span>
                <span class="text-zinc-500">{mod.status}</span>
              </div>
            )}
          </For>
          <Show when={status().modules.length === 0}>
            <span class="text-zinc-500">No modules registered</span>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default StatusBar

import { createSignal, createMemo, onMount, onCleanup, Show, For } from 'solid-js'
import { wsStore } from '../../ws/index.js'
import { threadKey, setThreadKey } from '../threads/store.js'
import { closeDashboardModal } from '../nav/store.js'

interface ThreadEntry {
  id: string
  label: string
  membraneId?: string
  agentStatus: string
  lastActivity: number
  archived: boolean
}

interface MembraneMeta {
  id: string
  name: string
  color: string
  icon: string
}

interface PreviewData {
  lastMessage: string
  agentStatus: string
}

/** Age of `ts` at `now`, in the list's compact form: now, 5m, 3h, 2d. */
export function shortRelativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 60_000) return 'now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`
  return `${Math.floor(diff / 86400_000)}d`
}

/**
 * Apply a `thread.updated` payload ({ threadId, patch } or { thread }) to the list.
 * `lastActivity` only moves forward: the list's value may come from the backend's
 * on-disk activity overlay, which can be newer than the registry's.
 */
export function applyThreadUpdate(list: ThreadEntry[], payload: any): ThreadEntry[] {
  const id = payload?.thread?.id ?? payload?.threadId ?? payload?.id
  if (!id) return list
  const patch = payload?.patch ?? payload?.thread ?? {}
  return list.map((t) =>
    t.id === id
      ? { ...t, ...patch, lastActivity: Math.max(t.lastActivity ?? 0, patch.lastActivity ?? 0) || t.lastActivity }
      : t
  )
}

// Re-render ages this often so "now" turns into "1m" without new data.
const CLOCK_MS = 30_000

export default function ThreadList() {
  const [threads, setThreads] = createSignal<ThreadEntry[]>([])
  const [membranes, setMembranes] = createSignal<MembraneMeta[]>([])
  const [previews, setPreviews] = createSignal<Record<string, PreviewData>>({})
  const [search, setSearch] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [now, setNow] = createSignal(Date.now())

  const membraneMap = createMemo(() => {
    const m = new Map<string, MembraneMeta>()
    for (const mb of membranes()) m.set(mb.id, mb)
    return m
  })

  const filtered = createMemo(() => {
    const q = search().toLowerCase().trim()
    let list = threads().filter((t) => !t.archived)
    if (q) {
      list = list.filter((t) => {
        const mb = t.membraneId ? membraneMap().get(t.membraneId) : null
        return (
          t.label.toLowerCase().includes(q) ||
          (mb?.name ?? '').toLowerCase().includes(q) ||
          (previews()[t.id]?.lastMessage ?? '').toLowerCase().includes(q)
        )
      })
    }
    return list.sort((a, b) => b.lastActivity - a.lastActivity)
  })

  async function loadThreads() {
    try {
      const [threadsRes, membranesRes] = await Promise.all([fetch('/api/threads'), fetch('/api/membranes')])
      if (threadsRes.ok) {
        const data = await threadsRes.json()
        setThreads(Array.isArray(data) ? data : (data.threads ?? []))
      }
      if (membranesRes.ok) {
        const data = await membranesRes.json()
        setMembranes(data.membranes ?? [])
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }

  async function loadPreviews(threadIds: string[]) {
    const batch = threadIds.slice(0, 30)
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const res = await fetch(`/api/threads/${encodeURIComponent(id)}/preview`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) return null
        const data = await res.json()
        return { id, preview: data as PreviewData }
      })
    )
    const next: Record<string, PreviewData> = { ...previews() }
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        next[r.value.id] = r.value.preview
      }
    }
    setPreviews(next)
  }

  onMount(() => {
    loadThreads().then(() => {
      const ids = threads()
        .filter((t) => !t.archived)
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .slice(0, 30)
        .map((t) => t.id)
      if (ids.length) loadPreviews(ids)
    })

    // The server sends `thread.updated` when a turn finishes (lastActivity) and on
    // renames/status changes; creations and deletions change membership, so reload.
    wsStore.subscribe(['threads'])
    const offs = [
      wsStore.on('thread.updated', (msg: any) => setThreads((prev) => applyThreadUpdate(prev, msg?.payload ?? msg))),
      wsStore.on('thread.created', () => loadThreads()),
      wsStore.on('thread.deleted', () => loadThreads())
    ]
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS)
    // Events missed while the tab slept (phone locked, socket reconnecting): catch up on return.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setNow(Date.now())
      void loadThreads()
    }
    document.addEventListener('visibilitychange', onVisible)
    onCleanup(() => {
      for (const off of offs) off()
      wsStore.unsubscribe(['threads'])
      clearInterval(clock)
      document.removeEventListener('visibilitychange', onVisible)
    })
  })

  function selectThread(id: string) {
    setThreadKey(id)
    window.location.hash = `#thread=${id}`
    closeDashboardModal()
  }

  return (
    <div class="flex h-full flex-col">
      <div class="shrink-0 px-3 pt-3 pb-2">
        <input
          type="text"
          placeholder="Search threads..."
          class="w-full rounded border px-2.5 py-1.5 text-xs outline-none"
          style={{
            background: 'var(--c-bg)',
            'border-color': 'var(--c-border)',
            color: 'var(--c-text)'
          }}
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      <div class="flex-1 overflow-y-auto px-1">
        <Show when={!loading()} fallback={<div class="px-3 py-4 text-xs opacity-40">Loading...</div>}>
          <Show when={filtered().length > 0} fallback={<div class="px-3 py-4 text-xs opacity-40">No threads</div>}>
            <For each={filtered()}>
              {(thread) => {
                const mb = () => (thread.membraneId ? membraneMap().get(thread.membraneId) : null)
                const preview = () => previews()[thread.id]
                const isActive = () => thread.agentStatus === 'working' || thread.agentStatus === 'thinking'
                const isCurrent = () => threadKey() === thread.id

                return (
                  <button
                    class="flex w-full cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors"
                    style={{
                      background: isCurrent() ? 'var(--c-hover-bg-strong)' : 'transparent',
                      color: 'var(--c-text)'
                    }}
                    onMouseEnter={(e) => {
                      if (!isCurrent()) e.currentTarget.style.background = 'var(--c-hover-bg)'
                    }}
                    onMouseLeave={(e) => {
                      if (!isCurrent()) e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => selectThread(thread.id)}
                  >
                    {/* Activity indicator */}
                    <span
                      class="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{
                        background: isActive() ? '#4aff8a' : 'var(--c-text-muted)',
                        opacity: isActive() ? 1 : 0.3
                      }}
                    />

                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5">
                        {/* Membrane badge */}
                        <Show when={mb()}>
                          {(m) => (
                            <span
                              class="inline-flex shrink-0 items-center rounded px-1 py-0.5 text-[9px] leading-none font-medium"
                              style={{ background: `${m().color}20`, color: m().color }}
                            >
                              {m().name}
                            </span>
                          )}
                        </Show>

                        <span class="truncate text-xs font-medium">{thread.label || thread.id.slice(0, 8)}</span>

                        <span class="ml-auto shrink-0 text-[10px] opacity-40">
                          {shortRelativeTime(thread.lastActivity, now())}
                        </span>
                      </div>

                      <Show when={preview()?.lastMessage}>
                        <p class="mt-0.5 truncate text-[11px] opacity-50">{preview()!.lastMessage}</p>
                      </Show>
                    </div>
                  </button>
                )
              }}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}

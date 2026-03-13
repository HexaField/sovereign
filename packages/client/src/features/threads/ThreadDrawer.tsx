import { createSignal, For, Show, createMemo } from 'solid-js'
import type { ThreadInfo } from './store.js'
import { getThreadDisplayName, getEntityIcon, groupThreadsByWorkspace, formatRelativeTime } from './helpers.js'

export const HIDDEN_THREADS_KEY = 'sovereign:hidden-threads'

export function getHiddenThreads(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_THREADS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function setHiddenThreads(keys: string[]): void {
  localStorage.setItem(HIDDEN_THREADS_KEY, JSON.stringify(keys))
}

export function hideThread(key: string): void {
  const hidden = getHiddenThreads()
  if (!hidden.includes(key)) {
    setHiddenThreads([...hidden, key])
  }
}

export function unhideThread(key: string): void {
  setHiddenThreads(getHiddenThreads().filter((k) => k !== key))
}

export function filterThreads(threads: ThreadInfo[], query: string): ThreadInfo[] {
  if (!query.trim()) return threads
  const q = query.toLowerCase()
  return threads.filter((t) => {
    const name = getThreadDisplayName(t).toLowerCase()
    if (name.includes(q)) return true
    if (t.label && t.label.toLowerCase().includes(q)) return true
    if (t.entities?.some((e) => e.entityRef.toLowerCase().includes(q))) return true
    return false
  })
}

export interface ThreadDrawerProps {
  open: () => boolean
  onClose: () => void
  threads: () => ThreadInfo[]
  activeKey: () => string
  onSwitchThread: (key: string) => void
  onNewThread?: () => void
}

export function ThreadDrawer(props: ThreadDrawerProps) {
  const [search, setSearch] = createSignal('')
  const [showHidden, setShowHidden] = createSignal(false)
  const [expandedThreads, setExpandedThreads] = createSignal<Set<string>>(new Set())

  const hiddenKeys = createMemo(() => getHiddenThreads())

  const visibleThreads = createMemo(() => {
    const all = props.threads()
    const filtered = filterThreads(all, search())
    if (showHidden()) return filtered
    return filtered.filter((t) => !hiddenKeys().includes(t.key))
  })

  const grouped = createMemo(() => groupThreadsByWorkspace(visibleThreads()))

  const toggleExpand = (key: string) => {
    const s = new Set(expandedThreads())
    if (s.has(key)) s.delete(key)
    else s.add(key)
    setExpandedThreads(s)
  }

  return (
    <div
      class="fixed inset-y-0 left-0 z-50 flex w-80 flex-col"
      style={{
        background: 'var(--c-bg-raised)',
        'border-right': '1px solid var(--c-border)',
        transform: props.open() ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 300ms ease'
      }}
    >
      <div class="border-b p-3" style={{ 'border-color': 'var(--c-border)' }}>
        <input
          type="text"
          placeholder="Search threads…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          class="w-full rounded px-3 py-2 text-sm"
          style={{ background: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
        />
      </div>

      <div class="flex-1 overflow-y-auto">
        <For each={[...grouped().entries()]}>
          {([groupKey, threads]) => (
            <div class="py-2">
              <div class="px-4 py-1 text-xs font-semibold uppercase" style={{ color: 'var(--c-text-muted)' }}>
                {groupKey === 'global' ? 'Global' : groupKey}
              </div>
              <Show when={groupKey === 'global'}>
                <button
                  class="w-full px-4 py-1 text-left text-sm"
                  style={{ color: 'var(--c-accent)' }}
                  onClick={() => props.onNewThread?.()}
                >
                  + New thread
                </button>
              </Show>
              <For each={threads}>
                {(thread) => {
                  const isHidden = () => hiddenKeys().includes(thread.key)
                  const isExpanded = () => expandedThreads().has(thread.key)
                  return (
                    <div
                      class="flex cursor-pointer items-center gap-2 px-4 py-2"
                      style={{
                        background: props.activeKey() === thread.key ? 'var(--c-bg-active)' : 'transparent',
                        opacity: isHidden() ? '0.5' : '1'
                      }}
                      onClick={() => props.onSwitchThread(thread.key)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        hideThread(thread.key)
                      }}
                    >
                      <Show when={thread.entities?.length > 0}>
                        <span>{getEntityIcon(thread.entities[0].entityType)}</span>
                      </Show>
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm" style={{ color: 'var(--c-text)' }}>
                          {getThreadDisplayName(thread)}
                        </div>
                        <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                          {formatRelativeTime(thread.lastActivity)}
                        </div>
                        <Show when={thread.entities?.length > 1}>
                          <button
                            class="text-xs"
                            style={{ color: 'var(--c-accent)' }}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleExpand(thread.key)
                            }}
                          >
                            +{thread.entities.length - 1}
                          </button>
                          <Show when={isExpanded()}>
                            <For each={thread.entities.slice(1)}>
                              {(entity) => (
                                <div class="pl-4 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                                  {getEntityIcon(entity.entityType)} {entity.entityRef}
                                </div>
                              )}
                            </For>
                          </Show>
                        </Show>
                      </div>
                      <Show when={thread.unreadCount > 0}>
                        <span
                          class="rounded-full px-1.5 py-0.5 text-xs"
                          style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
                        >
                          {thread.unreadCount}
                        </span>
                      </Show>
                      <Show when={isHidden()}>
                        <button
                          class="text-xs"
                          style={{ color: 'var(--c-accent)' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            unhideThread(thread.key)
                          }}
                        >
                          Unhide
                        </button>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          )}
        </For>
      </div>

      <div class="border-t p-3" style={{ 'border-color': 'var(--c-border)' }}>
        <button class="text-xs" style={{ color: 'var(--c-text-muted)' }} onClick={() => setShowHidden(!showHidden())}>
          {showHidden() ? 'Hide hidden threads' : 'Show hidden'}
        </button>
      </div>
    </div>
  )
}

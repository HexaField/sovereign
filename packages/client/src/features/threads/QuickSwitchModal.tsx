// Thread Quick Switch — Cmd+K / Ctrl+K modal with fuzzy search

import { createSignal, For, Show, onMount } from 'solid-js'
import { threads, switchThread, type ThreadInfo } from '../threads/store.js'
import { createThreadActions } from './thread-actions.js'
import { PinMark, ThreadActionsButton, ThreadActionsMenu, ThreadRenameInput } from './ThreadActions.js'
import { listedThreads } from './thread-order.js'

export const [quickSwitchOpen, setQuickSwitchOpen] = createSignal(false)

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}

export function QuickSwitchModal() {
  const [query, setQuery] = createSignal('')
  const [selectedIdx, setSelectedIdx] = createSignal(0)
  // Pin / Rename / Archive per thread (⋯ or right-click); the store updates `threads()`.
  const actions = createThreadActions()
  let inputRef: HTMLInputElement | undefined

  const filtered = () => {
    const q = query()
    const all = listedThreads(threads())
    if (!q) return all
    return all.filter((t) => {
      const label = t.label || t.id
      const workspace = t.workspaceIds?.[0] ?? ''
      const membrane = t.membraneId ?? ''
      return fuzzyMatch(q, label) || fuzzyMatch(q, workspace) || fuzzyMatch(q, membrane)
    })
  }

  const handleSelect = (thread: ThreadInfo) => {
    switchThread(thread.id)
    setQuickSwitchOpen(false)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const items = filtered()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[selectedIdx()]
      if (item) handleSelect(item)
    } else if (e.key === 'Escape') {
      if (actions.menuKey()) actions.closeMenu()
      else setQuickSwitchOpen(false)
    }
  }

  onMount(() => {
    setQuery('')
    setSelectedIdx(0)
    setTimeout(() => inputRef?.focus(), 0)
  })

  return (
    <Show when={quickSwitchOpen()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
        style={{ background: 'rgba(0,0,0,0.5)', 'backdrop-filter': 'blur(2px)' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            actions.closeMenu()
            actions.stopRename()
            setQuickSwitchOpen(false)
          }
        }}
      >
        <div
          class="w-full max-w-md overflow-hidden rounded-xl shadow-2xl"
          style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
        >
          <div class="border-b p-3" style={{ 'border-color': 'var(--c-border)' }}>
            <input
              ref={inputRef}
              type="text"
              class="w-full bg-transparent text-sm outline-none"
              style={{ color: 'var(--c-text)' }}
              placeholder="Search threads…"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value)
                setSelectedIdx(0)
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div class="max-h-64 overflow-y-auto">
            <For
              each={filtered()}
              fallback={
                <div class="p-3 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  No threads found
                </div>
              }
            >
              {(thread, idx) => (
                <>
                  <div
                    role="option"
                    aria-selected={idx() === selectedIdx()}
                    class="flex w-full cursor-pointer items-center gap-1 py-2 pr-1 pl-3 text-left transition-colors"
                    style={{
                      background: idx() === selectedIdx() ? 'var(--c-bg-hover)' : 'transparent',
                      color: 'var(--c-text)'
                    }}
                    onClick={() => {
                      if (!actions.isRenaming(thread.id)) handleSelect(thread)
                    }}
                    onMouseEnter={() => setSelectedIdx(idx())}
                    onContextMenu={(e) => actions.onContextMenu(thread.id, e)}
                  >
                    <div class="flex min-w-0 flex-1 flex-col">
                      <Show
                        when={actions.isRenaming(thread.id)}
                        fallback={
                          <span class="flex min-w-0 items-center gap-1.5">
                            <span class="truncate text-sm font-medium">{thread.label || thread.id}</span>
                            <PinMark thread={thread} />
                          </span>
                        }
                      >
                        <ThreadRenameInput
                          initial={thread.label ?? ''}
                          onSave={(label) => actions.saveRename(thread.id, label)}
                          onDone={() => {
                            actions.stopRename()
                            inputRef?.focus()
                          }}
                        />
                      </Show>
                      <Show when={thread.membraneId || thread.workspaceIds?.[0]}>
                        <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                          {thread.membraneId ?? thread.workspaceIds?.[0]}
                        </span>
                      </Show>
                    </div>
                    <ThreadActionsButton actions={actions} threadId={thread.id} />
                  </div>
                  <ThreadActionsMenu actions={actions} thread={thread} />
                </>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}

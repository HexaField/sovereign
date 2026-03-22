// Thread Quick Switch — Cmd+K / Ctrl+K modal with fuzzy search

import { createSignal, For, Show, onMount, onCleanup } from 'solid-js'
import { threads, switchThread, type ThreadInfo } from '../threads/store.js'

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
  let inputRef: HTMLInputElement | undefined

  const filtered = () => {
    const q = query()
    const all = threads()
    if (!q) return all
    return all.filter((t) => {
      const label = t.label || t.key
      return fuzzyMatch(q, label) || fuzzyMatch(q, t.orgId || '')
    })
  }

  const handleSelect = (thread: ThreadInfo) => {
    switchThread(thread.key)
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
      setQuickSwitchOpen(false)
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
        onClick={(e) => { if (e.target === e.currentTarget) setQuickSwitchOpen(false) }}
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
              onInput={(e) => { setQuery(e.currentTarget.value); setSelectedIdx(0) }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div class="max-h-64 overflow-y-auto">
            <For each={filtered()} fallback={
              <div class="p-3 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>No threads found</div>
            }>
              {(thread, idx) => (
                <button
                  class="flex w-full cursor-pointer flex-col px-3 py-2 text-left transition-colors"
                  style={{
                    background: idx() === selectedIdx() ? 'var(--c-bg-hover)' : 'transparent',
                    border: 'none',
                    color: 'var(--c-text)'
                  }}
                  onClick={() => handleSelect(thread)}
                  onMouseEnter={() => setSelectedIdx(idx())}
                >
                  <span class="text-sm font-medium">{thread.label || thread.key}</span>
                  <Show when={thread.orgId}>
                    <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>{thread.orgId}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}

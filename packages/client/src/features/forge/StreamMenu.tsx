// Work-stream side menu: one click focuses the canvas on a stream (its
// members and their direct neighbours); "New stream" creates one.

import { createMemo, createSignal, For, Show, type Component } from 'solid-js'
import type { WorkStream } from '@sovereign/core'
import { orderStreams } from './layout.js'

export interface StreamMenuProps {
  streams: WorkStream[]
  focused: string | null
  onFocus: (id: string | null) => void
  onCreate: (name: string, parentId?: string) => Promise<void>
}

const StreamMenu: Component<StreamMenuProps> = (props) => {
  const ordered = createMemo(() => {
    const list = orderStreams(props.streams)
    const byId = new Map(list.map((s) => [s.id, s]))
    const depth = (s: WorkStream): number => {
      let d = 0
      let cur = s.parentId ? byId.get(s.parentId) : undefined
      const seen = new Set<string>([s.id])
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id)
        d++
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      }
      return d
    }
    return list.map((s) => ({ s, depth: depth(s) }))
  })
  const [name, setName] = createSignal('')
  const [parent, setParent] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const create = async (): Promise<void> => {
    const n = name().trim()
    if (!n) return
    setBusy(true)
    setError(null)
    try {
      await props.onCreate(n, parent() || undefined)
      setName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      class="flex h-full w-56 shrink-0 flex-col border-r text-xs"
      style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-raised)', color: 'var(--c-text)' }}
      data-testid="forge-streams"
    >
      <div
        class="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider uppercase"
        style={{ color: 'var(--c-text-muted)' }}
      >
        Work streams
      </div>
      <div class="flex-1 overflow-y-auto">
        <Show when={ordered().length} fallback={<div class="px-3 py-2 opacity-60">No streams yet</div>}>
          <For each={ordered()}>
            {({ s, depth }) => (
              <button
                class="flex w-full items-center gap-1 py-1 pr-2 text-left hover:bg-[var(--c-hover-bg)]"
                style={{
                  'padding-left': `${12 + depth * 12}px`,
                  color: props.focused === s.id ? 'var(--c-accent)' : 'var(--c-text)',
                  background: props.focused === s.id ? 'var(--c-hover-bg)' : undefined
                }}
                onClick={() => props.onFocus(props.focused === s.id ? null : s.id)}
                data-testid="forge-stream"
              >
                <span>◆</span>
                <span class="flex-1 truncate">{s.name}</span>
                <span style={{ color: 'var(--c-text-muted)' }}>{s.memberCount}</span>
              </button>
            )}
          </For>
        </Show>
      </div>
      <div class="flex flex-col gap-1 border-t p-2" style={{ 'border-color': 'var(--c-border)' }}>
        <input
          class="rounded border px-1.5 py-0.5"
          style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-text)' }}
          placeholder="New stream"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
          data-testid="forge-stream-name"
        />
        <Show when={props.streams.length}>
          <select
            class="rounded border px-1 py-0.5"
            style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-text)' }}
            value={parent()}
            onChange={(e) => setParent(e.currentTarget.value)}
          >
            <option value="">Top level</option>
            <For each={ordered()}>{({ s }) => <option value={s.id}>Inside {s.name}</option>}</For>
          </select>
        </Show>
        <button
          class="rounded border px-2 py-0.5 disabled:opacity-40"
          style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
          disabled={busy() || !name().trim()}
          onClick={() => void create()}
          data-testid="forge-stream-create"
        >
          New stream
        </button>
        <Show when={error()}>
          <div style={{ color: 'var(--c-error, #ef4444)' }}>{error()}</div>
        </Show>
      </div>
    </div>
  )
}

export default StreamMenu

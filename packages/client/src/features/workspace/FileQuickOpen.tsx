// File quick-open — Cmd+P / Ctrl+P. Fuzzy-searches the files of the active
// workspace's root (server side, GET /api/files/search) and opens the pick in
// the file panel, the same way a file chip's "open in workspace" does.

import { createSignal, createEffect, For, Show, on, onCleanup } from 'solid-js'
import { activeWorkspace, openFileTabs } from './store.js'

export const [quickOpenOpen, setQuickOpenOpen] = createSignal(false)

interface FileRoot {
  id: string
  name: string
  path: string
}

export interface QuickOpenResult {
  path: string
  rel: string
  positions: number[]
}

/** Split `text` into runs of matched / unmatched characters; `positions` index into `text` from `offset`. */
export function highlightSegments(
  text: string,
  positions: number[],
  offset = 0
): Array<{ text: string; hit: boolean }> {
  const hits = new Set(positions.map((p) => p - offset))
  const out: Array<{ text: string; hit: boolean }> = []
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i)
    const last = out[out.length - 1]
    if (last && last.hit === hit) last.text += text[i]
    else out.push({ text: text[i], hit })
  }
  return out
}

/** The root to search: the one whose id matches the active workspace, else the global root, else the first. */
export function pickRoot(roots: FileRoot[], orgId: string | undefined): FileRoot | undefined {
  return roots.find((r) => r.id === orgId) ?? roots.find((r) => r.id === '_global') ?? roots[0]
}

export function openFileFromQuickOpen(path: string): void {
  setQuickOpenOpen(false)
  window.dispatchEvent(new CustomEvent('sovereign:open-file', { detail: { path } }))
}

let rootsCache: FileRoot[] | null = null

async function loadRoots(): Promise<FileRoot[]> {
  if (rootsCache) return rootsCache
  const res = await fetch('/api/files/roots')
  if (!res.ok) throw new Error(`roots: ${res.status}`)
  rootsCache = ((await res.json()) as { roots: FileRoot[] }).roots
  return rootsCache
}

function Highlighted(props: { text: string; positions: number[]; offset: number; hitColor: string }) {
  return (
    <For each={highlightSegments(props.text, props.positions, props.offset)}>
      {(seg) => <span style={seg.hit ? { color: props.hitColor, 'font-weight': '700' } : undefined}>{seg.text}</span>}
    </For>
  )
}

export function FileQuickOpen() {
  const [query, setQuery] = createSignal('')
  const [root, setRoot] = createSignal<FileRoot | undefined>()
  const [results, setResults] = createSignal<QuickOpenResult[]>([])
  const [total, setTotal] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)
  const [selectedIdx, setSelectedIdx] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  /** Recently opened files, newest first, shown before the user types. */
  const recents = (): QuickOpenResult[] => {
    const r = root()
    return [...openFileTabs()]
      .reverse()
      .slice(0, 10)
      .map((t) => ({
        path: t.path,
        rel: r && t.path.startsWith(r.path + '/') ? t.path.slice(r.path.length + 1) : t.path,
        positions: []
      }))
  }

  const items = () => (query().trim() ? results() : recents())

  async function search(q: string): Promise<void> {
    const r = root()
    if (!r || !q.trim()) {
      setResults([])
      setTotal(0)
      return
    }
    const mine = ++seq
    try {
      const res = await fetch(`/api/files/search?root=${encodeURIComponent(r.id)}&q=${encodeURIComponent(q)}&limit=50`)
      const body = await res.json()
      if (mine !== seq) return
      if (!res.ok) throw new Error(body.error ?? `search: ${res.status}`)
      setResults(body.results)
      setTotal(body.total)
      setError(null)
    } catch (e) {
      if (mine === seq) setError((e as Error).message)
    }
  }

  // Reset and focus on every open; pick the root for the current workspace.
  createEffect(
    on(quickOpenOpen, (open) => {
      if (!open) return
      setQuery('')
      setResults([])
      setTotal(0)
      setSelectedIdx(0)
      setError(null)
      setTimeout(() => inputRef?.focus(), 0)
      loadRoots()
        .then((roots) => setRoot(pickRoot(roots, activeWorkspace()?.orgId)))
        .catch((e) => setError((e as Error).message))
    })
  )

  onCleanup(() => clearTimeout(timer))

  const onInput = (value: string) => {
    setQuery(value)
    setSelectedIdx(0)
    clearTimeout(timer)
    timer = setTimeout(() => void search(value), 60)
  }

  const scrollSelected = () => {
    const el = listRef?.children[selectedIdx()] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const list = items()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, list.length - 1))
      scrollSelected()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
      scrollSelected()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = list[selectedIdx()]
      if (item) openFileFromQuickOpen(item.path)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setQuickOpenOpen(false)
    }
  }

  return (
    <Show when={quickOpenOpen()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
        style={{ background: 'rgba(0,0,0,0.5)', 'backdrop-filter': 'blur(2px)' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setQuickOpenOpen(false)
        }}
        data-testid="file-quick-open"
      >
        <div
          class="mx-3 w-full max-w-xl overflow-hidden rounded-xl shadow-2xl"
          style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
        >
          <div class="border-b p-3" style={{ 'border-color': 'var(--c-border)' }}>
            <input
              ref={inputRef}
              type="text"
              class="w-full bg-transparent text-sm outline-none"
              style={{ color: 'var(--c-text)' }}
              placeholder={root() ? `Search files in ${root()!.name}…` : 'Search files…'}
              value={query()}
              onInput={(e) => onInput(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              spellcheck={false}
              autocomplete="off"
            />
          </div>
          <div ref={listRef} class="max-h-[50vh] overflow-y-auto">
            <For
              each={items()}
              fallback={
                <div class="p-3 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  {error() ?? (query().trim() ? 'No matching files' : 'Type to search files')}
                </div>
              }
            >
              {(item, idx) => {
                const base = item.rel.lastIndexOf('/') + 1
                return (
                  <button
                    class="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left"
                    style={{
                      background: idx() === selectedIdx() ? 'var(--c-bg-hover)' : 'transparent',
                      border: 'none',
                      color: 'var(--c-text)'
                    }}
                    onClick={() => openFileFromQuickOpen(item.path)}
                    onMouseEnter={() => setSelectedIdx(idx())}
                    title={item.path}
                  >
                    <span class="shrink-0 text-sm">
                      <Highlighted
                        text={item.rel.slice(base)}
                        positions={item.positions}
                        offset={base}
                        hitColor="var(--c-accent)"
                      />
                    </span>
                    <span class="min-w-0 truncate text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                      <Highlighted
                        text={item.rel.slice(0, Math.max(base - 1, 0))}
                        positions={item.positions}
                        offset={0}
                        hitColor="var(--c-accent)"
                      />
                    </span>
                  </button>
                )
              }}
            </For>
          </div>
          <Show when={query().trim() && total() > results().length}>
            <div
              class="border-t px-3 py-1 text-[10px]"
              style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text-muted)' }}
            >
              {results().length} of {total()} matches
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}

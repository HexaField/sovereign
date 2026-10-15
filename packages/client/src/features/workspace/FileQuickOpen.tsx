// File quick-open — Cmd+P on macOS, Ctrl+P elsewhere. Fuzzy-searches the files of the active
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

/** The selection index kept inside a list of `length` items (0 when it is empty). */
export function clampIndex(i: number, length: number): number {
  return Math.max(0, Math.min(i, length - 1))
}

let lastRoots: FileRoot[] | null = null

/** Fetched on every open, so an org added since the last one shows up; the last good list covers a failed fetch. */
export async function loadRoots(): Promise<FileRoot[]> {
  try {
    const res = await fetch('/api/files/roots')
    if (!res.ok) throw new Error(`roots: ${res.status}`)
    lastRoots = ((await res.json()) as { roots: FileRoot[] }).roots
  } catch (e) {
    if (!lastRoots) throw e
  }
  return lastRoots
}

function Highlighted(props: { text: string; positions: number[]; offset: number; hitColor: string }) {
  return (
    <For each={highlightSegments(props.text, props.positions, props.offset)}>
      {(seg) => <span style={seg.hit ? { color: props.hitColor, 'font-weight': '700' } : undefined}>{seg.text}</span>}
    </For>
  )
}

export type SearchOutcome = { results: QuickOpenResult[]; total: number } | { error: string }

/** Runs searches, applying only the newest one's outcome; `cancel()` drops any still in flight. */
export function createFileSearcher(apply: (outcome: SearchOutcome) => void, fetchImpl: typeof fetch = fetch) {
  let seq = 0
  return {
    cancel(): void {
      seq++
    },
    async run(rootId: string, q: string): Promise<void> {
      const mine = ++seq
      try {
        const res = await fetchImpl(
          `/api/files/search?root=${encodeURIComponent(rootId)}&q=${encodeURIComponent(q)}&limit=50`
        )
        const body = await res.json().catch(() => ({}))
        if (mine !== seq) return
        if (!res.ok) throw new Error(body.error ?? `search: ${res.status}`)
        apply({ results: body.results, total: body.total })
      } catch (e) {
        if (mine === seq) apply({ error: (e as Error).message })
      }
    }
  }
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

  /** The selected row, kept inside the list as it shrinks or grows. */
  const selected = () => clampIndex(selectedIdx(), items().length)

  const searcher = createFileSearcher((outcome) => {
    if ('error' in outcome) return setError(outcome.error)
    setResults(outcome.results)
    setTotal(outcome.total)
    setSelectedIdx(0)
    setError(null)
  })

  function search(q: string): void {
    clearTimeout(timer)
    const r = root()
    if (!r || !q.trim()) {
      searcher.cancel()
      setResults([])
      setTotal(0)
      setError(null)
      return
    }
    void searcher.run(r.id, q)
  }

  // Reset and focus on every open; pick the root for the current workspace.
  createEffect(
    on(quickOpenOpen, (open) => {
      clearTimeout(timer)
      searcher.cancel()
      if (!open) return
      setQuery('')
      setResults([])
      setTotal(0)
      setSelectedIdx(0)
      setError(null)
      setTimeout(() => inputRef?.focus(), 0)
      loadRoots()
        .then((roots) => {
          setRoot(pickRoot(roots, activeWorkspace()?.orgId))
          // Typed before the roots arrived: that query found no root to search.
          if (quickOpenOpen() && query().trim()) search(query())
        })
        .catch((e) => setError((e as Error).message))
    })
  )

  onCleanup(() => clearTimeout(timer))

  const onInput = (value: string) => {
    setQuery(value)
    setSelectedIdx(0)
    clearTimeout(timer)
    timer = setTimeout(() => search(value), 60)
  }

  const select = (i: number) => {
    setSelectedIdx(clampIndex(i, items().length))
    const el = listRef?.children[selected()] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      select(selected() + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      select(selected() - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items()[selected()]
      if (item) openFileFromQuickOpen(item.path)
    } else if (e.key === 'Escape') {
      // Stop here, so a modal underneath that also closes on Escape stays open.
      e.preventDefault()
      e.stopPropagation()
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
          role="dialog"
          aria-modal="true"
          aria-label="Go to file"
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
              on:keydown={handleKeyDown}
              role="combobox"
              aria-label="File name"
              aria-expanded="true"
              aria-controls="file-quick-open-list"
              aria-activedescendant={items().length ? `file-quick-open-${selected()}` : undefined}
              spellcheck={false}
              autocomplete="off"
            />
          </div>
          <div ref={listRef} id="file-quick-open-list" role="listbox" class="max-h-[50vh] overflow-y-auto">
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
                    id={`file-quick-open-${idx()}`}
                    role="option"
                    aria-selected={idx() === selected()}
                    tabIndex={-1}
                    class="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left"
                    style={{
                      background: idx() === selected() ? 'var(--c-bg-hover)' : 'transparent',
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

// File system viewer for one tailnet device: browse directories, see what
// takes up space (folder sizes fill in as the server counts them), and
// download a file or a whole directory (tar.gz) to this device.

import { createSignal, createMemo, onCleanup, Show, For } from 'solid-js'

interface FsEntry {
  name: string
  type: 'dir' | 'file' | 'link' | 'other'
  size: number
  mtime: number
}

interface DirSizes {
  sizes: Record<string, number>
  total?: number
  done: boolean
  partial: boolean
  error?: string
}

const PAGE = 200

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`
}

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

export function FileBrowser(props: { device: string }) {
  const base = () => `/api/system/devices/${encodeURIComponent(props.device)}/fs`
  const [path, setPath] = createSignal('/')
  const [entries, setEntries] = createSignal<FsEntry[]>([])
  const [sizes, setSizes] = createSignal<DirSizes | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [showAll, setShowAll] = createSignal(false)
  // A newer navigation cancels the older one's requests and size polling.
  let generation = 0
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    generation++
    clearTimeout(pollTimer)
  })

  const pollSizes = async (dir: string, gen: number) => {
    try {
      const res = await fetch(`${base()}/sizes?path=${encodeURIComponent(dir)}`)
      if (gen !== generation || !res.ok) return
      const s = (await res.json()) as DirSizes
      setSizes(s)
      if (!s.done) pollTimer = setTimeout(() => void pollSizes(dir, gen), 1500)
    } catch {
      /* sizes are a bonus: the listing still works without them */
    }
  }

  const open = async (dir: string) => {
    const gen = ++generation
    clearTimeout(pollTimer)
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${base()}?path=${encodeURIComponent(dir)}`)
      const body = await res.json()
      if (gen !== generation) return
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      setPath(body.path)
      setEntries(body.entries)
      setSizes(null)
      setShowAll(false)
      void pollSizes(body.path, gen)
    } catch (err) {
      if (gen === generation) setError((err as Error).message)
    } finally {
      if (gen === generation) setLoading(false)
    }
  }
  void open('/')

  /** A directory's size: known, still counting (undefined), or unknown once du ends (null). */
  const sizeOf = (e: FsEntry): number | undefined | null => {
    if (e.type !== 'dir') return e.size
    const s = sizes()
    const known = s?.sizes[e.name]
    if (known !== undefined) return known
    return s?.done ? null : undefined
  }

  const rows = createMemo(() =>
    [...entries()].sort((a, b) => {
      const sa = sizeOf(a) ?? -1
      const sb = sizeOf(b) ?? -1
      return sb - sa || a.name.localeCompare(b.name)
    })
  )
  const largest = createMemo(() => rows().reduce((m, e) => Math.max(m, sizeOf(e) ?? 0), 0))
  const crumbs = createMemo(() => {
    const parts = path().split('/').filter(Boolean)
    return [
      { name: '/', path: '/' },
      ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))
    ]
  })
  const counting = () => {
    const s = sizes()
    const dirs = entries().filter((e) => e.type === 'dir').length
    return s && !s.done && dirs > 0 ? `${Object.keys(s.sizes).length} of ${dirs} folders counted` : null
  }

  return (
    <div class="mt-1.5 space-y-1.5" data-testid="file-browser">
      {/* Breadcrumb */}
      <div class="flex flex-wrap items-center gap-0.5 font-mono text-[11px]">
        <For each={crumbs()}>
          {(c, i) => (
            <>
              <Show when={i() > 1}>
                <span style={{ color: 'var(--c-text-muted)' }}>/</span>
              </Show>
              <button
                class="rounded px-1 hover:underline"
                style={{ color: i() === crumbs().length - 1 ? 'var(--c-text)' : 'var(--c-accent, #a855f7)' }}
                onClick={() => void open(c.path)}
              >
                {c.name}
              </button>
            </>
          )}
        </For>
        <span class="ml-auto flex items-center gap-2 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
          <Show when={sizes()?.total !== undefined}>
            <span>{fmtSize(sizes()!.total!)}</span>
          </Show>
          <Show when={counting()}>{(text) => <span>{text()}…</span>}</Show>
          <button class="hover:underline" title="Reload" onClick={() => void open(path())}>
            ↻
          </button>
        </span>
      </div>

      <Show when={error()}>
        <div class="text-[11px]" style={{ color: '#ef4444' }}>
          {error()}
        </div>
      </Show>
      <Show when={loading() && !entries().length}>
        <div class="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
          Loading…
        </div>
      </Show>

      <div class="max-h-96 space-y-px overflow-y-auto" style={{ opacity: loading() ? 0.6 : 1 }}>
        <Show when={path() !== '/'}>
          <button
            class="w-full rounded px-1 text-left font-mono text-[11px] hover:bg-[var(--c-hover)]"
            style={{ color: 'var(--c-text-muted)' }}
            onClick={() => void open(path().replace(/\/[^/]+$/, '') || '/')}
          >
            ..
          </button>
        </Show>
        <For each={showAll() ? rows() : rows().slice(0, PAGE)}>
          {(e) => {
            const size = () => sizeOf(e)
            const pct = () => (largest() > 0 ? ((size() ?? 0) / largest()) * 100 : 0)
            return (
              <div class="flex items-center gap-2 rounded px-1 hover:bg-[var(--c-hover)]" data-testid="fs-row">
                <span class="w-4 shrink-0 text-center text-[11px]" aria-hidden="true">
                  {e.type === 'dir' ? '📁' : e.type === 'link' ? '↪' : '📄'}
                </span>
                {/* A link may point at a directory: opening one that does not shows the error. */}
                <Show
                  when={e.type === 'dir' || e.type === 'link'}
                  fallback={
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px]" title={e.name}>
                      {e.name}
                    </span>
                  }
                >
                  <button
                    class="min-w-0 flex-1 truncate text-left font-mono text-[11px] hover:underline"
                    title={e.name}
                    onClick={() => void open(join(path(), e.name))}
                  >
                    {e.name}
                  </button>
                </Show>
                <div
                  class="h-1 w-12 shrink-0 overflow-hidden rounded-full sm:w-24"
                  style={{ background: 'var(--c-border)' }}
                >
                  <div class="h-full rounded-full" style={{ width: `${pct()}%`, background: '#a855f7' }} />
                </div>
                <span class="w-16 shrink-0 text-right font-mono text-[10px]" style={{ color: 'var(--c-text)' }}>
                  {size() === undefined ? '…' : size() === null ? '—' : fmtSize(size()!)}
                </span>
                <Show when={e.type !== 'other'} fallback={<span class="w-5 shrink-0" />}>
                  <a
                    class="w-5 shrink-0 text-center text-[11px] hover:opacity-70"
                    href={`${base()}/download?path=${encodeURIComponent(join(path(), e.name))}`}
                    download=""
                    title={e.type === 'dir' ? `Download ${e.name} as .tar.gz` : `Download ${e.name}`}
                    data-testid="fs-download"
                  >
                    ⬇
                  </a>
                </Show>
              </div>
            )
          }}
        </For>
        <Show when={!showAll() && rows().length > PAGE}>
          <button class="px-1 text-[10px] hover:underline" onClick={() => setShowAll(true)}>
            Show all {rows().length}
          </button>
        </Show>
      </div>

      <Show when={sizes()?.error}>
        {(err) => (
          <div class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            Folder sizes unavailable: {err()}
          </div>
        )}
      </Show>
      <Show when={sizes()?.partial}>
        <div class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
          Some folders could not be read (permissions): their sizes are lower bounds. "—" marks folders on another disk
          or unreadable.
        </div>
      </Show>
    </div>
  )
}

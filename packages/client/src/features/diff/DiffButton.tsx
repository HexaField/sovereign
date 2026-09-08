// DiffButton — header icon that shows changed-file count badge and opens the diff viewer.

import { createSignal, createMemo, onMount, onCleanup, Show } from 'solid-js'
import { threadKey } from '../threads/store.js'
import { openDiffViewer, fetchGitContext, type ThreadGitContext } from './store.js'

const POLL_INTERVAL = 30_000

export function DiffButton() {
  const [contexts, setContexts] = createSignal<ThreadGitContext[] | null>(null)
  let timer: ReturnType<typeof setInterval> | undefined

  const poll = async () => {
    const tid = threadKey()
    if (!tid) {
      setContexts(null)
      return
    }
    const result = await fetchGitContext(tid)
    setContexts(result)
  }

  // Poll on mount and on interval
  onMount(() => {
    poll()
    timer = setInterval(poll, POLL_INTERVAL)
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  // Re-poll when thread changes
  createMemo(() => {
    threadKey() // subscribe
    poll()
  })

  const totalFiles = createMemo(() => {
    const ctxs = contexts()
    if (!ctxs) return 0
    let n = 0
    for (const c of ctxs) n += c.files.length
    return n
  })

  const repoCount = createMemo(() => contexts()?.length ?? 0)

  // Hide when no git context available
  const visible = createMemo(() => {
    const ctxs = contexts()
    return ctxs !== null && ctxs.length > 0
  })

  const handleClick = () => {
    const tid = threadKey()
    if (tid) openDiffViewer(tid)
  }

  return (
    <Show when={visible()}>
      <button
        onClick={handleClick}
        title={`View changes${totalFiles() > 0 ? ` (${totalFiles()} file${totalFiles() !== 1 ? 's' : ''}` + (repoCount() > 1 ? ` across ${repoCount()} repos)` : ')') : ''}`}
        style={{
          position: 'relative',
          display: 'inline-flex',
          'align-items': 'center',
          'justify-content': 'center',
          width: '28px',
          height: '28px',
          background: 'transparent',
          border: '1px solid var(--c-border)',
          'border-radius': '6px',
          cursor: 'pointer',
          color: 'var(--c-text-muted)',
          'font-size': '14px',
          padding: '0',
          transition: 'all 0.15s ease'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--c-hover-bg)'
          e.currentTarget.style.color = 'var(--c-text)'
          e.currentTarget.style.borderColor = 'var(--c-accent)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = 'var(--c-text-muted)'
          e.currentTarget.style.borderColor = 'var(--c-border)'
        }}
      >
        {/* Git diff icon — simplified branch/merge glyph */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M5 3v10M11 3v4" stroke-linecap="round" />
          <circle cx="5" cy="3" r="1.5" fill="currentColor" />
          <circle cx="5" cy="13" r="1.5" fill="currentColor" />
          <circle cx="11" cy="3" r="1.5" fill="currentColor" />
          <circle cx="11" cy="9" r="1.5" fill="currentColor" />
          <path d="M11 9c0 2.5-2 4-6 4" stroke-linecap="round" />
        </svg>

        {/* Badge */}
        <Show when={totalFiles() > 0}>
          <span
            style={{
              position: 'absolute',
              top: '-5px',
              right: '-5px',
              'min-width': '16px',
              height: '16px',
              'border-radius': '8px',
              background: 'var(--c-accent)',
              color: '#fff',
              'font-size': '9px',
              'font-weight': '700',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '0 3px',
              'line-height': '1'
            }}
          >
            {totalFiles() > 99 ? '99+' : totalFiles()}
          </span>
        </Show>
      </button>
    </Show>
  )
}

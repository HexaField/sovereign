// Full-screen diff viewer overlay — shows branch changes for a thread's repos.
// Supports unified + split (side-by-side) view modes and commit-level exploration.

import { createResource, createSignal, createMemo, createEffect, Show, For, onMount, onCleanup } from 'solid-js'
import {
  diffThreadId,
  diffViewerOpen,
  closeDiffViewer,
  selectedFile,
  setSelectedFile,
  selectedRepo,
  setSelectedRepo,
  selectedCommit,
  setSelectedCommit,
  diffViewMode,
  setDiffViewMode,
  fetchGitContext,
  fetchFileDiff,
  type ThreadGitContext,
  type CommitInfo,
  type DiffViewMode
} from './store.js'
import {
  parseDiff,
  countAdditions,
  countDeletions,
  type ParsedDiffFile,
  type DiffHunk,
  type DiffLine
} from './diff-parser.js'
import { highlightLine, preloadHighlighter } from './highlight.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function statusIcon(status: string): string {
  switch (status) {
    case 'added':
      return '+'
    case 'deleted':
      return '−'
    case 'renamed':
      return '→'
    default:
      return '~'
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'added':
      return '#22c55e'
    case 'deleted':
      return '#ef4444'
    case 'renamed':
      return '#a78bfa'
    default:
      return '#eab308'
  }
}

function prStateColor(state: string): string {
  switch (state) {
    case 'open':
      return '#22c55e'
    case 'merged':
      return '#a78bfa'
    case 'draft':
      return '#6b7280'
    case 'closed':
      return '#ef4444'
    default:
      return 'var(--c-text-muted)'
  }
}

function lineBg(type: string): string {
  switch (type) {
    case 'add':
      return 'rgba(34, 197, 94, 0.12)'
    case 'del':
      return 'rgba(239, 68, 68, 0.12)'
    default:
      return 'transparent'
  }
}

function lineGutterBg(type: string): string {
  switch (type) {
    case 'add':
      return 'rgba(34, 197, 94, 0.22)'
    case 'del':
      return 'rgba(239, 68, 68, 0.22)'
    default:
      return 'transparent'
  }
}

function fileNamePart(path: string): string {
  return path.split('/').pop() ?? path
}

function dirNamePart(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/') + '/'
}

function contextFileCount(ctx: ThreadGitContext): number {
  return ctx.files?.length ?? 0
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffH = diffMs / (1000 * 60 * 60)
    if (diffH < 1) return `${Math.max(1, Math.round(diffMs / (1000 * 60)))}m ago`
    if (diffH < 24) return `${Math.round(diffH)}h ago`
    if (diffH < 48) return 'yesterday'
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return dateStr
  }
}

// ── Split-view line pairing ──────────────────────────────────────────────

export interface SplitLinePair {
  left: DiffLine | null // old side (del or context)
  right: DiffLine | null // new side (add or context)
}

/** Transform hunk lines into side-by-side pairs for split view. */
export function pairLinesForSplit(lines: DiffLine[]): SplitLinePair[] {
  const pairs: SplitLinePair[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.type === 'context' || line.type === 'header') {
      pairs.push({ left: line, right: line })
      i++
      continue
    }

    // Collect consecutive del lines
    const dels: DiffLine[] = []
    while (i < lines.length && lines[i].type === 'del') {
      dels.push(lines[i])
      i++
    }

    // Collect consecutive add lines immediately following
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].type === 'add') {
      adds.push(lines[i])
      i++
    }

    // Pair them up — longer side gets null on the shorter side
    const maxLen = Math.max(dels.length, adds.length)
    for (let j = 0; j < maxLen; j++) {
      pairs.push({
        left: j < dels.length ? dels[j] : null,
        right: j < adds.length ? adds[j] : null
      })
    }
  }

  return pairs
}

// ── Main component ───────────────────────────────────────────────────────

export function DiffViewer() {
  const [commitsExpanded, setCommitsExpanded] = createSignal(true)
  const [mobilePane, setMobilePane] = createSignal<'sidebar' | 'diff'>('sidebar')
  const [isMobile, setIsMobile] = createSignal(false)
  const [collapsedFiles, setCollapsedFiles] = createSignal<Set<string>>(new Set())

  const toggleFileCollapsed = (filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  // Preload syntax highlighter so grammars load before diffs render
  preloadHighlighter()

  // Detect mobile via matchMedia
  onMount(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    setIsMobile(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    onCleanup(() => mq.removeEventListener('change', handler))
  })

  // Swipe detection
  let touchStartX = 0
  let touchStartY = 0
  const handleTouchStart = (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX
    touchStartY = e.touches[0].clientY
  }
  const handleTouchEnd = (e: TouchEvent) => {
    if (!isMobile()) return
    const dx = e.changedTouches[0].clientX - touchStartX
    const dy = e.changedTouches[0].clientY - touchStartY
    // Only trigger on mostly-horizontal swipes > 60px
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return
    if (dx < 0) setMobilePane('diff') // swipe left → show diff
    if (dx > 0) setMobilePane('sidebar') // swipe right → show sidebar
  }

  // On mobile, selecting a file or commit auto-switches to diff pane
  const mobileSelectFile = (path: string | null) => {
    setSelectedFile(path)
    if (isMobile()) setMobilePane('diff')
  }

  // Fetch git context for the active thread
  const [contexts] = createResource(diffThreadId, async (tid) => {
    if (!tid) return null
    return fetchGitContext(tid)
  })

  // Sort contexts: repos with changes first, then by file count descending
  const sortedContexts = createMemo<ThreadGitContext[]>(() => {
    const ctxs = contexts()
    if (!ctxs?.length) return []
    return [...ctxs].sort((a, b) => contextFileCount(b) - contextFileCount(a))
  })

  // Auto-select best repo when contexts load
  createEffect(() => {
    const sorted = sortedContexts()
    if (!sorted.length) return
    const sel = selectedRepo()
    if (!sel || !sorted.find((c) => c.repoRoot === sel)) {
      setSelectedRepo(sorted[0].repoRoot)
      setSelectedFile(null)
      setSelectedCommit(null)
    }
  })

  const activeContext = createMemo<ThreadGitContext | null>(() => {
    const ctxs = sortedContexts()
    if (!ctxs.length) return null
    const sel = selectedRepo()
    return ctxs.find((c) => c.repoRoot === sel) ?? ctxs[0]
  })

  const hasMultipleRepos = createMemo(() => sortedContexts().length > 1)

  const commits = createMemo<CommitInfo[]>(() => activeContext()?.commits ?? [])

  // Fetch full commit diff (no file filter) to derive per-commit file list
  const [commitFullDiff] = createResource(
    () => {
      const tid = diffThreadId()
      const ctx = activeContext()
      const commit = selectedCommit()
      if (!tid || !ctx || !commit) return null
      return { threadId: tid, repo: ctx.repoRoot, commit }
    },
    async (params) => {
      if (!params) return null
      return fetchFileDiff(params.threadId, params.repo, undefined, params.commit)
    }
  )

  // Derive file list from the selected commit's full diff.
  // Must check selectedCommit() — createResource retains its last value when the source returns null.
  const commitFiles = createMemo(() => {
    if (!selectedCommit()) return null
    const raw = commitFullDiff()
    if (!raw) return null
    const parsed = parseDiff(raw)
    return parsed.map((f) => {
      const adds = countAdditions(f)
      const dels = countDeletions(f)
      const status: 'added' | 'deleted' | 'renamed' | 'modified' = f.renamed
        ? 'renamed'
        : dels === 0 && adds > 0
          ? 'added'
          : adds === 0 && dels > 0
            ? 'deleted'
            : 'modified'
      return {
        path: f.to,
        status,
        additions: adds,
        deletions: dels,
        ...(f.renamed ? { oldPath: f.from } : {})
      }
    })
  })

  // Files shown in the sidebar — commit-scoped when a commit selected, else branch-level
  const displayFiles = createMemo(() => commitFiles() ?? activeContext()?.files ?? [])

  // Fetch diff for the main content pane — branch diff or commit-scoped, optionally file-filtered
  const [diffContent] = createResource(
    () => {
      const tid = diffThreadId()
      const ctx = activeContext()
      if (!tid || !ctx) return null
      return {
        threadId: tid,
        repo: ctx.repoRoot,
        file: selectedFile() ?? undefined,
        commit: selectedCommit() ?? undefined
      }
    },
    async (params) => {
      if (!params) return null
      return fetchFileDiff(params.threadId, params.repo, params.file, params.commit)
    }
  )

  const parsedDiff = createMemo<ParsedDiffFile[]>(() => {
    const raw = diffContent()
    if (!raw) return []
    return parseDiff(raw)
  })

  const totalFiles = createMemo(() => displayFiles().length)

  const totalStats = createMemo(() => {
    const files = displayFiles()
    let adds = 0
    let dels = 0
    for (const f of files) {
      adds += f.additions
      dels += f.deletions
    }
    return { additions: adds, deletions: dels }
  })

  // Escape closes viewer
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeDiffViewer()
  }
  onMount(() => document.addEventListener('keydown', handleKeyDown))
  onCleanup(() => document.removeEventListener('keydown', handleKeyDown))

  const switchRepo = (repoRoot: string) => {
    setSelectedRepo(repoRoot)
    setSelectedFile(null)
    setSelectedCommit(null)
  }

  const selectCommit = (hash: string) => {
    const current = selectedCommit()
    if (current === hash) {
      // Deselect — back to full branch diff
      setSelectedCommit(null)
    } else {
      setSelectedCommit(hash)
      if (isMobile()) setMobilePane('diff')
    }
    setSelectedFile(null)
  }

  const viewLabel = createMemo(() => {
    const commit = selectedCommit()
    if (commit === 'uncommitted') return 'Uncommitted'
    if (commit) return `Commit ${commit.slice(0, 7)}`
    return 'Branch diff'
  })

  return (
    <Show when={diffViewerOpen()}>
      <div
        style={{
          position: 'fixed',
          inset: '0',
          'z-index': '1000',
          background: 'var(--c-bg)',
          display: 'flex',
          'flex-direction': 'column',
          animation: 'diffSlideUp 0.2s ease-out'
        }}
      >
        <style>{`
          @keyframes diffSlideUp {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
        `}</style>

        {/* ── Header bar ─────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '12px',
            padding: '8px 16px',
            'border-bottom': '1px solid var(--c-border)',
            background: 'var(--c-bg-raised)',
            'flex-shrink': '0',
            'min-height': '44px',
            'flex-wrap': 'wrap'
          }}
        >
          <Show when={activeContext()} keyed>
            {(ctx) => (
              <>
                <span style={{ 'font-weight': '600', color: 'var(--c-text-heading)', 'font-size': '14px' }}>
                  {ctx.repoName}
                </span>
                <span
                  style={{
                    background: 'rgba(99, 102, 241, 0.15)',
                    color: '#818cf8',
                    padding: '2px 8px',
                    'border-radius': '10px',
                    'font-size': '12px',
                    'font-family': 'monospace'
                  }}
                >
                  {ctx.branch}
                </span>
                <Show when={ctx.branch !== ctx.baseBranch}>
                  <span style={{ color: 'var(--c-text-muted)', 'font-size': '11px' }}>← {ctx.baseBranch}</span>
                </Show>
                <Show when={ctx.aheadBy > 0}>
                  <span style={{ color: 'var(--c-text-muted)', 'font-size': '11px' }}>
                    {ctx.aheadBy} commit{ctx.aheadBy !== 1 ? 's' : ''} ahead
                  </span>
                </Show>
                <Show when={ctx.pr}>
                  <a
                    href={ctx.pr!.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      'align-items': 'center',
                      gap: '4px',
                      background: 'rgba(99, 102, 241, 0.1)',
                      padding: '2px 8px',
                      'border-radius': '10px',
                      'font-size': '12px',
                      'text-decoration': 'none',
                      color: prStateColor(ctx.pr!.state)
                    }}
                  >
                    <span style={{ 'font-size': '10px' }}>●</span>#{ctx.pr!.number} {ctx.pr!.state}
                  </a>
                </Show>
              </>
            )}
          </Show>

          {/* Right side: mobile pane toggle, view mode, scope label, stats, close */}
          <div style={{ 'margin-left': 'auto', display: 'flex', 'align-items': 'center', gap: '12px' }}>
            {/* Mobile pane switcher */}
            <Show when={isMobile()}>
              <MobilePaneToggle pane={mobilePane()} setPane={setMobilePane} />
            </Show>

            {/* View scope indicator */}
            <Show when={selectedCommit()}>
              <span
                style={{
                  background: 'rgba(234, 179, 8, 0.15)',
                  color: '#eab308',
                  padding: '2px 8px',
                  'border-radius': '10px',
                  'font-size': '11px',
                  'font-family': 'monospace'
                }}
              >
                {viewLabel()}
              </span>
            </Show>

            {/* Unified / Split toggle — hide on mobile (too narrow for split) */}
            <Show when={!isMobile()}>
              <ViewModeToggle />
            </Show>

            <span class="diff-desktop-only" style={{ 'font-size': '12px', color: 'var(--c-text-muted)' }}>
              {totalFiles()} file{totalFiles() !== 1 ? 's' : ''}
            </span>
            <Show when={totalStats().additions > 0}>
              <span class="diff-desktop-only" style={{ 'font-size': '12px', color: '#22c55e' }}>
                +{totalStats().additions}
              </span>
            </Show>
            <Show when={totalStats().deletions > 0}>
              <span class="diff-desktop-only" style={{ 'font-size': '12px', color: '#ef4444' }}>
                −{totalStats().deletions}
              </span>
            </Show>
            <Show when={selectedFile() || selectedCommit()}>
              <button
                onClick={() => {
                  setSelectedFile(null)
                  setSelectedCommit(null)
                }}
                style={{
                  background: 'var(--c-hover-bg)',
                  border: '1px solid var(--c-border)',
                  color: 'var(--c-text)',
                  padding: '2px 8px',
                  'border-radius': '6px',
                  cursor: 'pointer',
                  'font-size': '11px'
                }}
              >
                View all
              </button>
            </Show>
            <button
              onClick={closeDiffViewer}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--c-text-muted)',
                cursor: 'pointer',
                'font-size': '20px',
                padding: '0 4px',
                'line-height': '1'
              }}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Repo picker bar (only when multiple repos) ──────────────── */}
        <Show when={hasMultipleRepos()}>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '4px',
              padding: '4px 16px',
              'border-bottom': '1px solid var(--c-border)',
              background: 'var(--c-bg)',
              'flex-shrink': '0',
              'overflow-x': 'auto'
            }}
          >
            <span
              style={{ 'font-size': '11px', color: 'var(--c-text-muted)', 'flex-shrink': '0', 'margin-right': '4px' }}
            >
              Repos:
            </span>
            <For each={sortedContexts()}>
              {(ctx) => {
                const active = () => selectedRepo() === ctx.repoRoot
                const fileCount = contextFileCount(ctx)
                return (
                  <button
                    onClick={() => switchRepo(ctx.repoRoot)}
                    style={{
                      display: 'inline-flex',
                      'align-items': 'center',
                      gap: '6px',
                      padding: '3px 10px',
                      'border-radius': '6px',
                      border: active() ? '1px solid var(--c-accent)' : '1px solid var(--c-border)',
                      background: active() ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                      color: active() ? 'var(--c-accent)' : 'var(--c-text)',
                      cursor: 'pointer',
                      'font-size': '12px',
                      'flex-shrink': '0',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <span style={{ 'font-weight': active() ? '600' : '400' }}>{ctx.repoName}</span>
                    <Show when={fileCount > 0}>
                      <span
                        style={{
                          'min-width': '16px',
                          height: '16px',
                          'border-radius': '8px',
                          background: active() ? 'var(--c-accent)' : 'var(--c-text-muted)',
                          color: '#fff',
                          'font-size': '9px',
                          'font-weight': '700',
                          display: 'inline-flex',
                          'align-items': 'center',
                          'justify-content': 'center',
                          padding: '0 4px'
                        }}
                      >
                        {fileCount}
                      </span>
                    </Show>
                    <Show when={ctx.branch !== ctx.baseBranch}>
                      <span style={{ 'font-size': '10px', color: 'var(--c-text-muted)', 'font-family': 'monospace' }}>
                        {ctx.branch}
                      </span>
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </Show>

        {/* ── Body: sidebar + diff pane ───────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            flex: '1',
            overflow: 'hidden',
            position: 'relative'
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {/* Mobile sliding container — on desktop, acts as normal flex */}
          <div
            style={{
              display: 'flex',
              flex: '1',
              ...(isMobile()
                ? {
                    width: '200%',
                    transform: `translateX(${mobilePane() === 'sidebar' ? '0' : '-50%'})`,
                    transition: 'transform 0.25s ease'
                  }
                : {})
            }}
          >
            {/* Sidebar — commit list + file list */}
            <div
              style={{
                ...(isMobile()
                  ? { width: '50%', 'flex-shrink': '0' }
                  : { width: '280px', 'min-width': '200px', 'max-width': '360px', 'flex-shrink': '0' }),
                'border-right': '1px solid var(--c-border)',
                overflow: 'auto',
                background: 'var(--c-bg)',
                display: 'flex',
                'flex-direction': 'column'
              }}
            >
              {/* Commit list — collapsible, above file list */}
              <Show when={commits().length > 0}>
                <div style={{ 'border-bottom': '1px solid var(--c-border)', 'flex-shrink': '0' }}>
                  <button
                    onClick={() => setCommitsExpanded(!commitsExpanded())}
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '6px',
                      width: '100%',
                      padding: '8px 12px',
                      background: 'var(--c-bg-raised)',
                      border: 'none',
                      'border-bottom': '1px solid var(--c-border)',
                      color: 'var(--c-text-muted)',
                      cursor: 'pointer',
                      'font-size': '11px',
                      'text-align': 'left',
                      'font-weight': '600',
                      'text-transform': 'uppercase',
                      'letter-spacing': '0.5px'
                    }}
                  >
                    <span>{commitsExpanded() ? '▾' : '▸'}</span>
                    <span>Commits ({commits().length})</span>
                  </button>

                  <Show when={commitsExpanded()}>
                    <div style={{ padding: '2px 0', 'max-height': '35vh', overflow: 'auto' }}>
                      {/* "All commits" — deselect back to full branch diff */}
                      <button
                        onClick={() => {
                          setSelectedCommit(null)
                          setSelectedFile(null)
                        }}
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '6px',
                          width: '100%',
                          padding: '5px 12px',
                          background: !selectedCommit() ? 'var(--c-hover-bg)' : 'transparent',
                          border: 'none',
                          'border-left': !selectedCommit() ? '2px solid var(--c-accent)' : '2px solid transparent',
                          color: !selectedCommit() ? 'var(--c-accent)' : 'var(--c-text-muted)',
                          cursor: 'pointer',
                          'font-size': '12px',
                          'text-align': 'left'
                        }}
                      >
                        All commits
                      </button>
                      <For each={commits()}>
                        {(commit) => {
                          const active = () => selectedCommit() === commit.hash
                          return (
                            <button
                              onClick={() => selectCommit(commit.hash)}
                              style={{
                                display: 'flex',
                                'flex-direction': 'column',
                                gap: '2px',
                                width: '100%',
                                padding: '6px 12px',
                                background: active() ? 'var(--c-hover-bg)' : 'transparent',
                                border: 'none',
                                'border-left': active() ? '2px solid var(--c-accent)' : '2px solid transparent',
                                color: 'var(--c-text)',
                                cursor: 'pointer',
                                'text-align': 'left',
                                transition: 'all 0.1s ease'
                              }}
                              title={`${commit.hash}\n${commit.author} — ${commit.date}`}
                            >
                              <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                                <span
                                  style={{
                                    'font-family': 'monospace',
                                    'font-size': '11px',
                                    color: active() ? 'var(--c-accent)' : '#818cf8',
                                    'flex-shrink': '0'
                                  }}
                                >
                                  {commit.shortHash}
                                </span>
                                <span
                                  style={{
                                    'font-size': '12px',
                                    overflow: 'hidden',
                                    'text-overflow': 'ellipsis',
                                    'white-space': 'nowrap',
                                    'font-weight': active() ? '500' : '400'
                                  }}
                                >
                                  {commit.message}
                                </span>
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  'align-items': 'center',
                                  gap: '8px',
                                  'font-size': '10px',
                                  color: 'var(--c-text-muted)'
                                }}
                              >
                                <span>{commit.author}</span>
                                <span>{formatDate(commit.date)}</span>
                              </div>
                            </button>
                          )
                        }}
                      </For>

                      {/* Uncommitted changes — at the bottom of the commit list */}
                      <button
                        onClick={() => selectCommit('uncommitted')}
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '6px',
                          width: '100%',
                          padding: '5px 12px',
                          background: selectedCommit() === 'uncommitted' ? 'var(--c-hover-bg)' : 'transparent',
                          border: 'none',
                          'border-top': '1px solid var(--c-border)',
                          'border-left':
                            selectedCommit() === 'uncommitted' ? '2px solid var(--c-accent)' : '2px solid transparent',
                          color: selectedCommit() === 'uncommitted' ? 'var(--c-accent)' : 'var(--c-text-muted)',
                          cursor: 'pointer',
                          'font-size': '12px',
                          'text-align': 'left',
                          'font-style': 'italic'
                        }}
                      >
                        Uncommitted changes
                      </button>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* File list — shows commit-scoped files when a commit selected */}
              <div style={{ padding: '4px 0', 'flex-shrink': '0' }}>
                <Show when={displayFiles().length > 0}>
                  <div
                    style={{
                      padding: '4px 12px 2px',
                      'font-size': '11px',
                      color: 'var(--c-text-muted)',
                      'font-weight': '600',
                      'text-transform': 'uppercase',
                      'letter-spacing': '0.5px'
                    }}
                  >
                    Files ({displayFiles().length})
                  </div>
                </Show>

                <button
                  onClick={() => mobileSelectFile(null)}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '6px',
                    width: '100%',
                    padding: '6px 12px',
                    background: !selectedFile() ? 'var(--c-hover-bg)' : 'transparent',
                    border: 'none',
                    color: !selectedFile() ? 'var(--c-accent)' : 'var(--c-text-muted)',
                    cursor: 'pointer',
                    'font-size': '12px',
                    'text-align': 'left'
                  }}
                >
                  All files
                </button>

                <Show when={!selectedCommit() || !commitFullDiff.loading}>
                  <For each={displayFiles()}>
                    {(file) => (
                      <button
                        onClick={() => mobileSelectFile(file.path)}
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '6px',
                          width: '100%',
                          padding: '5px 12px',
                          background: selectedFile() === file.path ? 'var(--c-hover-bg)' : 'transparent',
                          border: 'none',
                          color: 'var(--c-text)',
                          cursor: 'pointer',
                          'font-size': '12px',
                          'text-align': 'left',
                          'line-height': '1.4'
                        }}
                        title={file.path}
                      >
                        <span
                          style={{
                            color: statusColor(file.status),
                            'font-weight': '700',
                            'font-family': 'monospace',
                            'font-size': '13px',
                            width: '14px',
                            'text-align': 'center',
                            'flex-shrink': '0'
                          }}
                        >
                          {statusIcon(file.status)}
                        </span>
                        <span style={{ 'min-width': '0', overflow: 'hidden' }}>
                          <span style={{ color: 'var(--c-text-muted)', 'font-size': '11px' }}>
                            {dirNamePart(file.path)}
                          </span>
                          <span style={{ 'font-weight': '500' }}>{fileNamePart(file.path)}</span>
                        </span>
                        <span
                          style={{
                            'margin-left': 'auto',
                            'flex-shrink': '0',
                            'font-size': '10px',
                            'font-family': 'monospace',
                            display: 'flex',
                            gap: '4px'
                          }}
                        >
                          <Show when={file.additions > 0}>
                            <span style={{ color: '#22c55e' }}>+{file.additions}</span>
                          </Show>
                          <Show when={file.deletions > 0}>
                            <span style={{ color: '#ef4444' }}>-{file.deletions}</span>
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
                <Show when={selectedCommit() && commitFullDiff.loading}>
                  <div style={{ padding: '8px 12px', color: 'var(--c-text-muted)', 'font-size': '11px' }}>
                    Loading files…
                  </div>
                </Show>
              </div>
            </div>

            {/* Diff content pane */}
            <div
              style={{
                ...(isMobile() ? { width: '50%', 'flex-shrink': '0' } : { flex: '1' }),
                overflow: 'auto',
                background: 'var(--c-bg)'
              }}
            >
              <Show when={contexts.loading || diffContent.loading}>
                <div
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    padding: '40px',
                    color: 'var(--c-text-muted)'
                  }}
                >
                  Loading…
                </div>
              </Show>

              <Show when={!contexts.loading && !diffContent.loading && totalFiles() === 0}>
                <div
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    padding: '40px',
                    color: 'var(--c-text-muted)',
                    'flex-direction': 'column',
                    gap: '8px'
                  }}
                >
                  <span style={{ 'font-size': '32px' }}>∅</span>
                  <span>No changes in {activeContext()?.repoName ?? 'this repo'}</span>
                </div>
              </Show>

              <Show when={!diffContent.loading && parsedDiff().length > 0}>
                <div style={{ 'font-family': "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" }}>
                  <For each={parsedDiff()}>
                    {(file) => (
                      <div style={{ 'margin-bottom': '2px' }}>
                        {/* File header — click to collapse/expand */}
                        <div
                          onClick={() => toggleFileCollapsed(file.to)}
                          style={{
                            padding: '8px 16px',
                            background: 'var(--c-bg-raised)',
                            'border-bottom': '1px solid var(--c-border)',
                            'border-top': '1px solid var(--c-border)',
                            display: 'flex',
                            'align-items': 'center',
                            gap: '8px',
                            position: 'sticky',
                            top: '0',
                            'z-index': '10',
                            cursor: 'pointer',
                            'user-select': 'none'
                          }}
                        >
                          <span
                            style={{
                              color: 'var(--c-text-muted)',
                              'font-size': '10px',
                              width: '12px',
                              'flex-shrink': '0',
                              transition: 'transform 0.15s ease',
                              transform: collapsedFiles().has(file.to) ? 'rotate(-90deg)' : 'rotate(0)'
                            }}
                          >
                            ▾
                          </span>
                          <Show when={file.binary}>
                            <span
                              style={{
                                background: 'rgba(107, 114, 128, 0.2)',
                                padding: '1px 6px',
                                'border-radius': '4px',
                                'font-size': '10px',
                                color: 'var(--c-text-muted)'
                              }}
                            >
                              BINARY
                            </span>
                          </Show>
                          <Show when={file.renamed}>
                            <span style={{ color: '#a78bfa', 'font-size': '12px' }}>
                              {file.from} → {file.to}
                            </span>
                          </Show>
                          <Show when={!file.renamed}>
                            <span style={{ 'font-size': '12px', color: 'var(--c-text)' }}>{file.to}</span>
                          </Show>
                        </div>

                        <Show when={!collapsedFiles().has(file.to)}>
                          <Show when={!file.binary}>
                            <Show
                              when={diffViewMode() === 'unified'}
                              fallback={<SplitDiffFileView hunks={file.hunks} filePath={file.to} />}
                            >
                              <For each={file.hunks}>
                                {(hunk) => (
                                  <div>
                                    <div
                                      style={{
                                        padding: '4px 16px',
                                        background: 'rgba(99, 102, 241, 0.06)',
                                        color: 'var(--c-text-muted)',
                                        'font-size': '11px',
                                        'border-bottom': '1px solid var(--c-border)'
                                      }}
                                    >
                                      @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@{' '}
                                      {hunk.header}
                                    </div>
                                    <For each={hunk.lines}>
                                      {(line: DiffLine) => <UnifiedLineRow line={line} filePath={file.to} />}
                                    </For>
                                  </div>
                                )}
                              </For>
                            </Show>
                          </Show>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={!diffContent.loading && parsedDiff().length === 0 && totalFiles() > 0 && !!diffContent()}>
                <div style={{ padding: '40px', 'text-align': 'center', color: 'var(--c-text-muted)' }}>
                  No diff content (file may have only whitespace changes)
                </div>
              </Show>
            </div>
          </div>
          {/* close sliding wrapper */}
        </div>

        <style>{`
          @media (max-width: 768px) {
            .diff-desktop-only { display: none !important; }
          }
          /* highlight.js token colours — VS Code dark+ inspired */
          .hljs-keyword,
          .hljs-selector-tag { color: #c586c0; }
          .hljs-built_in { color: #4ec9b0; }
          .hljs-type,
          .hljs-title.class_ { color: #4ec9b0; }
          .hljs-title.function_ { color: #dcdcaa; }
          .hljs-string,
          .hljs-template-variable { color: #ce9178; }
          .hljs-number,
          .hljs-literal { color: #b5cea8; }
          .hljs-comment,
          .hljs-quote { color: #6a9955; font-style: italic; }
          .hljs-regexp { color: #d16969; }
          .hljs-variable,
          .hljs-attr { color: #9cdcfe; }
          .hljs-params { color: #9cdcfe; }
          .hljs-meta,
          .hljs-meta .hljs-keyword { color: #569cd6; }
          .hljs-tag { color: #808080; }
          .hljs-name,
          .hljs-selector-id,
          .hljs-selector-class { color: #569cd6; }
          .hljs-attribute { color: #9cdcfe; }
          .hljs-symbol,
          .hljs-bullet { color: #b5cea8; }
          .hljs-addition { color: #22c55e; }
          .hljs-deletion { color: #ef4444; }
          .hljs-operator { color: #d4d4d4; }
          .hljs-punctuation { color: #d4d4d4; }
          .hljs-property { color: #9cdcfe; }
          .hljs-title { color: #dcdcaa; }
          .hljs-section { color: #569cd6; }
          .hljs-subst { color: #d4d4d4; }
        `}</style>
      </div>
    </Show>
  )
}

// ── View mode toggle ─────────────────────────────────────────────────────

function ViewModeToggle() {
  const mode = diffViewMode
  const toggle = (m: DiffViewMode) => setDiffViewMode(m)

  const btnStyle = (active: boolean) => ({
    padding: '2px 8px',
    'border-radius': '4px',
    border: 'none',
    background: active ? 'var(--c-accent)' : 'transparent',
    color: active ? '#fff' : 'var(--c-text-muted)',
    cursor: 'pointer',
    'font-size': '11px',
    'font-weight': active ? '600' : '400',
    transition: 'all 0.15s ease'
  })

  return (
    <div
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '2px',
        background: 'var(--c-bg)',
        'border-radius': '6px',
        padding: '2px',
        border: '1px solid var(--c-border)'
      }}
    >
      <button onClick={() => toggle('unified')} style={btnStyle(mode() === 'unified')} title="Unified diff view">
        Unified
      </button>
      <button onClick={() => toggle('split')} style={btnStyle(mode() === 'split')} title="Side-by-side diff view">
        Split
      </button>
    </div>
  )
}

// ── Mobile pane toggle ───────────────────────────────────────────────────

function MobilePaneToggle(props: { pane: 'sidebar' | 'diff'; setPane: (p: 'sidebar' | 'diff') => void }) {
  const btnStyle = (active: boolean) => ({
    padding: '2px 8px',
    'border-radius': '4px',
    border: 'none',
    background: active ? 'var(--c-accent)' : 'transparent',
    color: active ? '#fff' : 'var(--c-text-muted)',
    cursor: 'pointer',
    'font-size': '11px',
    'font-weight': active ? '600' : '400',
    transition: 'all 0.15s ease'
  })

  return (
    <div
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '2px',
        background: 'var(--c-bg)',
        'border-radius': '6px',
        padding: '2px',
        border: '1px solid var(--c-border)'
      }}
    >
      <button onClick={() => props.setPane('sidebar')} style={btnStyle(props.pane === 'sidebar')}>
        Files
      </button>
      <button onClick={() => props.setPane('diff')} style={btnStyle(props.pane === 'diff')}>
        Diff
      </button>
    </div>
  )
}

// ── Unified line row ─────────────────────────────────────────────────────

function UnifiedLineRow(props: { line: DiffLine; filePath: string }) {
  const prefix = () => {
    switch (props.line.type) {
      case 'add':
        return '+'
      case 'del':
        return '-'
      case 'header':
        return ''
      default:
        return ' '
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        background: lineBg(props.line.type),
        'font-size': '12px',
        'line-height': '20px',
        'white-space': 'pre',
        'overflow-x': 'auto'
      }}
    >
      <span
        style={{
          width: '48px',
          'min-width': '48px',
          'text-align': 'right',
          'padding-right': '8px',
          color: 'var(--c-text-muted)',
          'user-select': 'none',
          background: lineGutterBg(props.line.type),
          'font-size': '11px',
          opacity: '0.7'
        }}
      >
        {props.line.oldLine ?? ''}
      </span>
      <span
        style={{
          width: '48px',
          'min-width': '48px',
          'text-align': 'right',
          'padding-right': '8px',
          color: 'var(--c-text-muted)',
          'user-select': 'none',
          background: lineGutterBg(props.line.type),
          'font-size': '11px',
          opacity: '0.7'
        }}
      >
        {props.line.newLine ?? ''}
      </span>
      <span
        style={{
          width: '16px',
          'min-width': '16px',
          'text-align': 'center',
          color: props.line.type === 'add' ? '#22c55e' : props.line.type === 'del' ? '#ef4444' : 'var(--c-text-muted)',
          'user-select': 'none',
          'font-weight': '700'
        }}
      >
        {prefix()}
      </span>
      <span style={{ 'padding-right': '16px' }} innerHTML={highlightLine(props.line.content, props.filePath)} />
    </div>
  )
}

// ── Split (side-by-side) view ────────────────────────────────────────────

function SplitDiffFileView(props: { hunks: DiffHunk[]; filePath: string }) {
  return (
    <For each={props.hunks}>
      {(hunk) => {
        const pairs = createMemo(() => pairLinesForSplit(hunk.lines))
        return (
          <div>
            <div
              style={{
                padding: '4px 16px',
                background: 'rgba(99, 102, 241, 0.06)',
                color: 'var(--c-text-muted)',
                'font-size': '11px',
                'border-bottom': '1px solid var(--c-border)'
              }}
            >
              @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@ {hunk.header}
            </div>
            <div style={{ display: 'flex' }}>
              {/* Left (old) side */}
              <div style={{ flex: '1', 'min-width': '0', 'border-right': '1px solid var(--c-border)' }}>
                <For each={pairs()}>
                  {(pair) => <SplitHalfRow line={pair.left} side="old" filePath={props.filePath} />}
                </For>
              </div>
              {/* Right (new) side */}
              <div style={{ flex: '1', 'min-width': '0' }}>
                <For each={pairs()}>
                  {(pair) => <SplitHalfRow line={pair.right} side="new" filePath={props.filePath} />}
                </For>
              </div>
            </div>
          </div>
        )
      }}
    </For>
  )
}

function SplitHalfRow(props: { line: DiffLine | null; side: 'old' | 'new'; filePath: string }) {
  // Empty row — filler for unpaired lines
  if (!props.line) {
    return (
      <div
        style={{
          display: 'flex',
          'font-size': '12px',
          'line-height': '20px',
          'white-space': 'pre',
          background: 'rgba(107, 114, 128, 0.04)',
          'min-height': '20px'
        }}
      >
        <span
          style={{
            width: '40px',
            'min-width': '40px',
            'text-align': 'right',
            'padding-right': '8px',
            'user-select': 'none',
            'font-size': '11px'
          }}
        />
        <span style={{ flex: '1' }} />
      </div>
    )
  }

  const lineNum = () => (props.side === 'old' ? props.line!.oldLine : props.line!.newLine)
  const type = () => props.line!.type
  const bg = () => {
    const t = type()
    if (t === 'add') return lineBg('add')
    if (t === 'del') return lineBg('del')
    return 'transparent'
  }

  return (
    <div
      style={{
        display: 'flex',
        background: bg(),
        'font-size': '12px',
        'line-height': '20px',
        'white-space': 'pre',
        'overflow-x': 'auto'
      }}
    >
      <span
        style={{
          width: '40px',
          'min-width': '40px',
          'text-align': 'right',
          'padding-right': '8px',
          color: 'var(--c-text-muted)',
          'user-select': 'none',
          background: lineGutterBg(type()),
          'font-size': '11px',
          opacity: '0.7'
        }}
      >
        {lineNum() ?? ''}
      </span>
      <span
        style={{ 'padding-right': '8px', 'padding-left': '4px' }}
        innerHTML={highlightLine(props.line!.content, props.filePath)}
      />
    </div>
  )
}

import { createResource, createSignal, createMemo, createEffect, Show, For } from 'solid-js'
import { threadKey } from '../threads/store.js'
import {
  selectedFile,
  setSelectedFile,
  selectedRepo,
  setSelectedRepo,
  selectedCommit,
  setSelectedCommit,
  fetchGitContext,
  fetchFileDiff,
  type ThreadGitContext,
  type CommitInfo
} from './store.js'
import { parseDiff, countAdditions, countDeletions } from './diff-parser.js'

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

// ── Main component ───────────────────────────────────────────────────────

export function DiffSidebar() {
  const [commitsExpanded, setCommitsExpanded] = createSignal(true)

  const [contexts] = createResource(threadKey, async (tid) => {
    if (!tid) return null
    return fetchGitContext(tid)
  })

  const sortedContexts = createMemo<ThreadGitContext[]>(() => {
    const ctxs = contexts()
    if (!ctxs?.length) return []
    return [...ctxs].sort((a, b) => contextFileCount(b) - contextFileCount(a))
  })

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

  const [commitFullDiff] = createResource(
    () => {
      const tid = threadKey()
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

  const displayFiles = createMemo(() => commitFiles() ?? activeContext()?.files ?? [])

  const switchRepo = (repoRoot: string) => {
    setSelectedRepo(repoRoot)
    setSelectedFile(null)
    setSelectedCommit(null)
  }

  const selectCommit = (hash: string) => {
    if (selectedCommit() === hash) {
      setSelectedCommit(null)
    } else {
      setSelectedCommit(hash)
    }
    setSelectedFile(null)
  }

  return (
    <div class="flex h-full flex-col overflow-hidden" style={{ background: 'var(--c-bg)' }}>
      {/* Repo info header */}
      <Show when={activeContext()} keyed>
        {(ctx) => (
          <div
            style={{
              padding: '8px 12px',
              'border-bottom': '1px solid var(--c-border)',
              'flex-shrink': '0',
              display: 'flex',
              'flex-direction': 'column',
              gap: '4px'
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'flex-wrap': 'wrap' }}>
              <span style={{ 'font-weight': '600', color: 'var(--c-text-heading)', 'font-size': '13px' }}>
                {ctx.repoName}
              </span>
              <span
                style={{
                  background: 'rgba(99, 102, 241, 0.15)',
                  color: '#818cf8',
                  padding: '1px 6px',
                  'border-radius': '8px',
                  'font-size': '11px',
                  'font-family': 'monospace'
                }}
              >
                {ctx.branch}
              </span>
            </div>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
              <Show when={ctx.branch !== ctx.baseBranch}>
                <span style={{ color: 'var(--c-text-muted)', 'font-size': '10px' }}>← {ctx.baseBranch}</span>
              </Show>
              <Show when={ctx.aheadBy > 0}>
                <span style={{ color: 'var(--c-text-muted)', 'font-size': '10px' }}>
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
                    gap: '3px',
                    background: 'rgba(99, 102, 241, 0.1)',
                    padding: '1px 6px',
                    'border-radius': '8px',
                    'font-size': '10px',
                    'text-decoration': 'none',
                    color: prStateColor(ctx.pr!.state)
                  }}
                >
                  <span style={{ 'font-size': '8px' }}>●</span>#{ctx.pr!.number} {ctx.pr!.state}
                </a>
              </Show>
            </div>
          </div>
        )}
      </Show>

      {/* Repo picker (multiple repos) */}
      <Show when={hasMultipleRepos()}>
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '4px',
            padding: '4px 8px',
            'border-bottom': '1px solid var(--c-border)',
            'flex-shrink': '0',
            'overflow-x': 'auto'
          }}
        >
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
                    gap: '4px',
                    padding: '2px 8px',
                    'border-radius': '6px',
                    border: active() ? '1px solid var(--c-accent)' : '1px solid var(--c-border)',
                    background: active() ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                    color: active() ? 'var(--c-accent)' : 'var(--c-text)',
                    cursor: 'pointer',
                    'font-size': '11px',
                    'flex-shrink': '0'
                  }}
                >
                  <span style={{ 'font-weight': active() ? '600' : '400' }}>{ctx.repoName}</span>
                  <Show when={fileCount > 0}>
                    <span
                      style={{
                        'min-width': '14px',
                        height: '14px',
                        'border-radius': '7px',
                        background: active() ? 'var(--c-accent)' : 'var(--c-text-muted)',
                        color: '#fff',
                        'font-size': '9px',
                        'font-weight': '700',
                        display: 'inline-flex',
                        'align-items': 'center',
                        'justify-content': 'center',
                        padding: '0 3px'
                      }}
                    >
                      {fileCount}
                    </span>
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </Show>

      {/* Scrollable content: commits + files */}
      <div class="flex-1 overflow-auto">
        {/* Loading state */}
        <Show when={contexts.loading}>
          <div style={{ padding: '12px', color: 'var(--c-text-muted)', 'font-size': '12px' }}>Loading…</div>
        </Show>

        {/* Empty state */}
        <Show when={!contexts.loading && sortedContexts().length === 0}>
          <div
            style={{
              padding: '24px 12px',
              color: 'var(--c-text-muted)',
              'font-size': '12px',
              'text-align': 'center',
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
              'align-items': 'center'
            }}
          >
            <span style={{ 'font-size': '24px', opacity: '0.5' }}>∅</span>
            <span>No git activity for this thread</span>
            <span style={{ 'font-size': '11px', opacity: '0.7' }}>Start an agent session that touches a repo</span>
          </div>
        </Show>

        {/* Commit list */}
        <Show when={commits().length > 0}>
          <div style={{ 'border-bottom': '1px solid var(--c-border)', 'flex-shrink': '0' }}>
            <button
              onClick={() => setCommitsExpanded(!commitsExpanded())}
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                width: '100%',
                padding: '6px 12px',
                background: 'var(--c-bg-raised)',
                border: 'none',
                'border-bottom': '1px solid var(--c-border)',
                color: 'var(--c-text-muted)',
                cursor: 'pointer',
                'font-size': '10px',
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
              <div style={{ padding: '2px 0', 'max-height': '40vh', overflow: 'auto' }}>
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
                    padding: '4px 12px',
                    background: !selectedCommit() ? 'var(--c-hover-bg)' : 'transparent',
                    border: 'none',
                    'border-left': !selectedCommit() ? '2px solid var(--c-accent)' : '2px solid transparent',
                    color: !selectedCommit() ? 'var(--c-accent)' : 'var(--c-text-muted)',
                    cursor: 'pointer',
                    'font-size': '11px',
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
                          gap: '1px',
                          width: '100%',
                          padding: '4px 12px',
                          background: active() ? 'var(--c-hover-bg)' : 'transparent',
                          border: 'none',
                          'border-left': active() ? '2px solid var(--c-accent)' : '2px solid transparent',
                          color: 'var(--c-text)',
                          cursor: 'pointer',
                          'text-align': 'left'
                        }}
                        title={`${commit.hash}\n${commit.author} — ${commit.date}`}
                      >
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                          <span
                            style={{
                              'font-family': 'monospace',
                              'font-size': '10px',
                              color: active() ? 'var(--c-accent)' : '#818cf8',
                              'flex-shrink': '0'
                            }}
                          >
                            {commit.shortHash}
                          </span>
                          <span
                            style={{
                              'font-size': '11px',
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
                            gap: '6px',
                            'font-size': '9px',
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

                <button
                  onClick={() => selectCommit('uncommitted')}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '6px',
                    width: '100%',
                    padding: '4px 12px',
                    background: selectedCommit() === 'uncommitted' ? 'var(--c-hover-bg)' : 'transparent',
                    border: 'none',
                    'border-top': '1px solid var(--c-border)',
                    'border-left':
                      selectedCommit() === 'uncommitted' ? '2px solid var(--c-accent)' : '2px solid transparent',
                    color: selectedCommit() === 'uncommitted' ? 'var(--c-accent)' : 'var(--c-text-muted)',
                    cursor: 'pointer',
                    'font-size': '11px',
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

        {/* File list */}
        <div style={{ padding: '2px 0' }}>
          <Show when={displayFiles().length > 0}>
            <div
              style={{
                padding: '4px 12px 2px',
                'font-size': '10px',
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
            onClick={() => setSelectedFile(null)}
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '6px',
              width: '100%',
              padding: '4px 12px',
              background: !selectedFile() ? 'var(--c-hover-bg)' : 'transparent',
              border: 'none',
              color: !selectedFile() ? 'var(--c-accent)' : 'var(--c-text-muted)',
              cursor: 'pointer',
              'font-size': '11px',
              'text-align': 'left'
            }}
          >
            All files
          </button>

          <Show when={!selectedCommit() || !commitFullDiff.loading}>
            <For each={displayFiles()}>
              {(file) => (
                <button
                  onClick={() => setSelectedFile(file.path)}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '4px',
                    width: '100%',
                    padding: '3px 12px',
                    background: selectedFile() === file.path ? 'var(--c-hover-bg)' : 'transparent',
                    border: 'none',
                    color: 'var(--c-text)',
                    cursor: 'pointer',
                    'font-size': '11px',
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
                      'font-size': '12px',
                      width: '12px',
                      'text-align': 'center',
                      'flex-shrink': '0'
                    }}
                  >
                    {statusIcon(file.status)}
                  </span>
                  <span
                    style={{
                      'min-width': '0',
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      'white-space': 'nowrap'
                    }}
                  >
                    <span style={{ color: 'var(--c-text-muted)', 'font-size': '10px' }}>{dirNamePart(file.path)}</span>
                    <span style={{ 'font-weight': '500' }}>{fileNamePart(file.path)}</span>
                  </span>
                  <span
                    style={{
                      'margin-left': 'auto',
                      'flex-shrink': '0',
                      'font-size': '9px',
                      'font-family': 'monospace',
                      display: 'flex',
                      gap: '3px'
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
            <div style={{ padding: '8px 12px', color: 'var(--c-text-muted)', 'font-size': '11px' }}>Loading files…</div>
          </Show>
        </div>
      </div>
    </div>
  )
}

import type { Component } from 'solid-js'
import { Show, For, createSignal, createEffect, onCleanup } from 'solid-js'
import { activeWorkspace } from '../store.js'

export interface GitStatusData {
  branch: string
  ahead: number
  behind: number
  staged: { path: string; status: string }[]
  unstaged: { path: string; status: string }[]
  untracked: string[]
}

const GitPanel: Component = () => {
  const ws = () => activeWorkspace()
  const [status, setStatus] = createSignal<GitStatusData | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [commitMsg, setCommitMsg] = createSignal('')
  const [committing, setCommitting] = createSignal(false)
  const [diffPath, setDiffPath] = createSignal<string | null>(null)
  const [diffText, setDiffText] = createSignal<string | null>(null)
  const [diffLoading, setDiffLoading] = createSignal(false)
  const [actionError, setActionError] = createSignal<string | null>(null)

  const orgId = () => ws()?.orgId
  const projectId = () => ws()?.activeProjectId

  const fetchStatus = async () => {
    const o = orgId()
    const p = projectId()
    if (!o || !p) {
      setStatus(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/git/status?orgId=${encodeURIComponent(o)}&projectId=${encodeURIComponent(p)}`)
      if (!res.ok) {
        setError('Failed to load status')
        setLoading(false)
        return
      }
      const data = await res.json()
      setStatus({
        branch: data.branch ?? 'unknown',
        ahead: data.ahead ?? 0,
        behind: data.behind ?? 0,
        staged: (data.staged ?? []).map((f: any) =>
          typeof f === 'string' ? { path: f, status: 'modified' } : { path: f.path, status: f.status ?? 'modified' }
        ),
        unstaged: (data.modified ?? data.unstaged ?? []).map((f: any) =>
          typeof f === 'string' ? { path: f, status: 'modified' } : { path: f.path, status: f.status ?? 'modified' }
        ),
        untracked: (data.untracked ?? []).map((f: any) => (typeof f === 'string' ? f : f.path))
      })
    } catch {
      setError('Failed to load status')
    } finally {
      setLoading(false)
    }
  }

  // Auto-refresh on workspace change
  createEffect(() => {
    orgId()
    projectId()
    void fetchStatus()
  })

  // Poll every 10s
  const interval = setInterval(() => void fetchStatus(), 10000)
  onCleanup(() => clearInterval(interval))

  const postGit = async (endpoint: string, body: Record<string, unknown>) => {
    setActionError(null)
    const res = await fetch(`/api/git/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: orgId(), projectId: projectId(), ...body })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }))
      throw new Error(err.error || 'Request failed')
    }
    return res.json()
  }

  const stageFile = async (path: string) => {
    try {
      await postGit('stage', { paths: [path] })
      await fetchStatus()
    } catch (e: any) {
      setActionError(e.message)
    }
  }

  const unstageFile = async (path: string) => {
    try {
      await postGit('unstage', { paths: [path] })
      await fetchStatus()
    } catch (e: any) {
      setActionError(e.message)
    }
  }

  const stageAll = async () => {
    const s = status()
    if (!s) return
    const allPaths = [...s.unstaged.map((f) => f.path), ...s.untracked]
    if (allPaths.length === 0) return
    try {
      await postGit('stage', { paths: allPaths })
      await fetchStatus()
    } catch (e: any) {
      setActionError(e.message)
    }
  }

  const unstageAll = async () => {
    const s = status()
    if (!s) return
    const allPaths = s.staged.map((f) => f.path)
    if (allPaths.length === 0) return
    try {
      await postGit('unstage', { paths: allPaths })
      await fetchStatus()
    } catch (e: any) {
      setActionError(e.message)
    }
  }

  const doCommit = async () => {
    const msg = commitMsg().trim()
    if (!msg) return
    setCommitting(true)
    try {
      await postGit('commit', { message: msg })
      setCommitMsg('')
      await fetchStatus()
    } catch (e: any) {
      setActionError(e.message)
    } finally {
      setCommitting(false)
    }
  }

  const showDiff = async (path: string) => {
    if (diffPath() === path) {
      setDiffPath(null)
      setDiffText(null)
      return
    }
    setDiffPath(path)
    setDiffLoading(true)
    setDiffText(null)
    try {
      const o = orgId()
      const p = projectId()
      const res = await fetch(
        `/api/git/diff?orgId=${encodeURIComponent(o!)}&projectId=${encodeURIComponent(p!)}&path=${encodeURIComponent(path)}`
      )
      if (!res.ok) {
        setDiffText('Failed to load diff')
      } else {
        const data = await res.json()
        setDiffText(data.diff || '(no changes)')
      }
    } catch {
      setDiffText('Failed to load diff')
    } finally {
      setDiffLoading(false)
    }
  }

  const fileName = (path: string) => path.split('/').pop() ?? path
  const fileDir = (path: string) => {
    const parts = path.split('/')
    return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : ''
  }

  const statusBadge = (status: string) => {
    switch (status) {
      case 'added':
        return 'A'
      case 'deleted':
        return 'D'
      case 'renamed':
        return 'R'
      default:
        return 'M'
    }
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'added':
        return 'var(--c-success, #22c55e)'
      case 'deleted':
        return 'var(--c-error, #ef4444)'
      default:
        return 'var(--c-warning, #f59e0b)'
    }
  }

  const FileRow: Component<{
    path: string
    status?: string
    color: string
    action: string
    onAction: () => void
    onClickFile: () => void
  }> = (props) => (
    <div
      class="group flex items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-black/10"
      style={{ cursor: 'pointer' }}
    >
      <Show when={props.status}>
        <span
          class="w-4 shrink-0 text-center font-mono text-[10px] font-bold"
          style={{ color: statusColor(props.status!) }}
        >
          {statusBadge(props.status!)}
        </span>
      </Show>
      <div
        class="min-w-0 flex-1 truncate"
        style={{ color: props.color }}
        onClick={props.onClickFile}
        title={props.path}
      >
        <span style={{ color: 'var(--c-text-muted)', 'font-size': '0.6rem' }}>{fileDir(props.path)}</span>
        {fileName(props.path)}
      </div>
      <button
        class="shrink-0 rounded px-1.5 py-0.5 text-[10px] opacity-0 transition-opacity group-hover:opacity-100"
        style={{ background: 'var(--c-bg)', color: 'var(--c-text-muted)', border: '1px solid var(--c-border)' }}
        onClick={(e) => {
          e.stopPropagation()
          props.onAction()
        }}
        title={props.action}
      >
        {props.action}
      </button>
    </div>
  )

  return (
    <div class="flex h-full flex-col">
      {/* Header */}
      <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Git
        </span>
        <button
          class="rounded px-1.5 py-0.5 text-[10px]"
          style={{ color: 'var(--c-text-muted)', background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
          onClick={() => void fetchStatus()}
          title="Refresh"
        >
          ↻
        </button>
      </div>

      <div class="flex-1 overflow-auto">
        <Show
          when={ws()?.activeProjectId}
          fallback={
            <p class="p-3 text-xs" style={{ color: 'var(--c-text-muted)' }}>
              No project selected
            </p>
          }
        >
          <Show
            when={!loading() || status()}
            fallback={
              <p class="p-3 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                Loading…
              </p>
            }
          >
            <Show
              when={status()}
              fallback={
                <p class="p-3 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  {error() || 'Could not load git status'}
                </p>
              }
            >
              {(s) => (
                <div class="flex flex-col gap-1 p-2">
                  {/* Branch */}
                  <div
                    class="flex items-center gap-1.5 rounded px-2 py-1.5"
                    style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
                  >
                    <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      ⎇
                    </span>
                    <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
                      {s().branch}
                    </span>
                    <Show when={s().ahead > 0}>
                      <span class="text-[10px]" style={{ color: 'var(--c-accent)' }}>
                        ↑{s().ahead}
                      </span>
                    </Show>
                    <Show when={s().behind > 0}>
                      <span class="text-[10px]" style={{ color: 'var(--c-warning, #f59e0b)' }}>
                        ↓{s().behind}
                      </span>
                    </Show>
                  </div>

                  {/* Action error */}
                  <Show when={actionError()}>
                    <div
                      class="rounded px-2 py-1 text-xs"
                      style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--c-error, #ef4444)' }}
                    >
                      {actionError()}
                    </div>
                  </Show>

                  {/* Staged changes */}
                  <Show when={s().staged.length > 0}>
                    <div>
                      <div class="flex items-center justify-between px-1 py-1">
                        <span
                          class="text-[10px] font-semibold tracking-wide uppercase"
                          style={{ color: 'var(--c-success, #22c55e)' }}
                        >
                          Staged ({s().staged.length})
                        </span>
                        <button class="text-[10px]" style={{ color: 'var(--c-text-muted)' }} onClick={unstageAll}>
                          Unstage All
                        </button>
                      </div>
                      <For each={s().staged}>
                        {(f) => (
                          <FileRow
                            path={f.path}
                            status={f.status}
                            color="var(--c-text)"
                            action="−"
                            onAction={() => void unstageFile(f.path)}
                            onClickFile={() => void showDiff(f.path)}
                          />
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Unstaged changes */}
                  <Show when={s().unstaged.length > 0}>
                    <div>
                      <div class="flex items-center justify-between px-1 py-1">
                        <span
                          class="text-[10px] font-semibold tracking-wide uppercase"
                          style={{ color: 'var(--c-warning, #f59e0b)' }}
                        >
                          Changes ({s().unstaged.length})
                        </span>
                        <button class="text-[10px]" style={{ color: 'var(--c-text-muted)' }} onClick={stageAll}>
                          Stage All
                        </button>
                      </div>
                      <For each={s().unstaged}>
                        {(f) => (
                          <FileRow
                            path={f.path}
                            status={f.status}
                            color="var(--c-text)"
                            action="+"
                            onAction={() => void stageFile(f.path)}
                            onClickFile={() => void showDiff(f.path)}
                          />
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Untracked files */}
                  <Show when={s().untracked.length > 0}>
                    <div>
                      <div class="flex items-center justify-between px-1 py-1">
                        <span
                          class="text-[10px] font-semibold tracking-wide uppercase"
                          style={{ color: 'var(--c-text-muted)' }}
                        >
                          Untracked ({s().untracked.length})
                        </span>
                      </div>
                      <For each={s().untracked}>
                        {(f) => (
                          <FileRow
                            path={f}
                            color="var(--c-text-muted)"
                            action="+"
                            onAction={() => void stageFile(f)}
                            onClickFile={() => void showDiff(f)}
                          />
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Clean state */}
                  <Show when={s().staged.length === 0 && s().unstaged.length === 0 && s().untracked.length === 0}>
                    <p class="px-1 py-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      ✓ Working tree clean
                    </p>
                  </Show>

                  {/* Commit section */}
                  <Show when={s().staged.length > 0}>
                    <div
                      class="mt-1 flex flex-col gap-1.5 rounded border p-2"
                      style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)' }}
                    >
                      <textarea
                        class="w-full resize-none rounded border px-2 py-1.5 text-xs"
                        style={{
                          background: 'var(--c-bg-raised)',
                          color: 'var(--c-text)',
                          'border-color': 'var(--c-border)',
                          outline: 'none',
                          'font-family': 'inherit',
                          'min-height': '60px'
                        }}
                        placeholder="Commit message…"
                        value={commitMsg()}
                        onInput={(e) => setCommitMsg(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                            e.preventDefault()
                            void doCommit()
                          }
                        }}
                      />
                      <button
                        class="w-full rounded py-1.5 text-xs font-medium transition-colors"
                        style={{
                          background: commitMsg().trim() ? 'var(--c-accent)' : 'var(--c-border)',
                          color: commitMsg().trim() ? 'white' : 'var(--c-text-muted)',
                          cursor: commitMsg().trim() ? 'pointer' : 'default',
                          opacity: committing() ? '0.6' : '1'
                        }}
                        disabled={!commitMsg().trim() || committing()}
                        onClick={() => void doCommit()}
                      >
                        {committing() ? 'Committing…' : 'Commit'}
                        <span class="ml-1 text-[10px] opacity-60">⌘⏎</span>
                      </button>
                    </div>
                  </Show>

                  {/* Inline diff viewer */}
                  <Show when={diffPath()}>
                    <div
                      class="mt-1 rounded border"
                      style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)' }}
                    >
                      <div
                        class="flex items-center justify-between border-b px-2 py-1"
                        style={{ 'border-color': 'var(--c-border)' }}
                      >
                        <span class="truncate text-[10px] font-medium" style={{ color: 'var(--c-text-heading)' }}>
                          {diffPath()}
                        </span>
                        <button
                          class="text-xs"
                          style={{ color: 'var(--c-text-muted)' }}
                          onClick={() => {
                            setDiffPath(null)
                            setDiffText(null)
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      <div class="max-h-[300px] overflow-auto">
                        <Show when={diffLoading()}>
                          <p class="p-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                            Loading…
                          </p>
                        </Show>
                        <Show when={diffText()}>
                          <pre
                            class="m-0 p-2 text-[11px] leading-relaxed"
                            style={{
                              'font-family': 'var(--font-mono, monospace)',
                              'white-space': 'pre-wrap',
                              'word-break': 'break-all',
                              color: 'var(--c-text)'
                            }}
                          >
                            <For each={diffText()!.split('\n')}>
                              {(line) => {
                                const color = line.startsWith('+')
                                  ? 'var(--c-success, #22c55e)'
                                  : line.startsWith('-')
                                    ? 'var(--c-error, #ef4444)'
                                    : line.startsWith('@@')
                                      ? 'var(--c-accent)'
                                      : 'var(--c-text)'
                                const bg = line.startsWith('+')
                                  ? 'rgba(34,197,94,0.08)'
                                  : line.startsWith('-')
                                    ? 'rgba(239,68,68,0.08)'
                                    : 'transparent'
                                return <div style={{ color, background: bg }}>{line}</div>
                              }}
                            </For>
                          </pre>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default GitPanel

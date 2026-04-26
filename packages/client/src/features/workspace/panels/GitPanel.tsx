import type { Component } from 'solid-js'
import { Show, For, createSignal, createEffect, on, onCleanup } from 'solid-js'
import { activeWorkspace } from '../store.js'

// ── Types ────────────────────────────────────────────────────────────

export interface GitStatusData {
  branch: string
  ahead: number
  behind: number
  staged: { path: string; status: string }[]
  unstaged: { path: string; status: string }[]
  untracked: string[]
}

interface Project {
  id: string
  name: string
  repoPath: string
  defaultBranch?: string
}

interface ProjectStatus {
  project: Project
  status: GitStatusData | null
  loading: boolean
  error: string | null
}

interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  refs?: string
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseStatus(data: Record<string, unknown>): GitStatusData {
  return {
    branch: (data.branch as string) ?? 'unknown',
    ahead: (data.ahead as number) ?? 0,
    behind: (data.behind as number) ?? 0,
    staged: ((data.staged as unknown[]) ?? []).map((f: unknown) =>
      typeof f === 'string'
        ? { path: f, status: 'modified' }
        : { path: (f as Record<string, string>).path, status: (f as Record<string, string>).status ?? 'modified' }
    ),
    unstaged: (((data.modified ?? data.unstaged) as unknown[]) ?? []).map((f: unknown) =>
      typeof f === 'string'
        ? { path: f, status: 'modified' }
        : { path: (f as Record<string, string>).path, status: (f as Record<string, string>).status ?? 'modified' }
    ),
    untracked: ((data.untracked as unknown[]) ?? []).map((f: unknown) =>
      typeof f === 'string' ? f : (f as Record<string, string>).path
    )
  }
}

function changeSummary(s: GitStatusData): { text: string; clean: boolean } {
  const parts: string[] = []
  if (s.staged.length > 0) parts.push(`${s.staged.length} staged`)
  if (s.unstaged.length > 0) parts.push(`${s.unstaged.length} modified`)
  if (s.untracked.length > 0) parts.push(`${s.untracked.length} untracked`)
  if (parts.length === 0) return { text: '✓ Clean', clean: true }
  return { text: parts.join(', '), clean: false }
}

// ── Main Component ───────────────────────────────────────────────────

const GitPanel: Component = () => {
  const ws = () => activeWorkspace()

  // View state: null = overview, string = project detail
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
  const [selectedProjectName, setSelectedProjectName] = createSignal<string>('')

  // Overview state
  const [projects, setProjects] = createSignal<Project[]>([])
  const [projectStatuses, setProjectStatuses] = createSignal<Map<string, ProjectStatus>>(new Map())
  const [overviewLoading, setOverviewLoading] = createSignal(false)
  const [overviewError, setOverviewError] = createSignal<string | null>(null)
  const [detecting, setDetecting] = createSignal(false)

  // Detail state
  const [status, setStatus] = createSignal<GitStatusData | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [commitMsg, setCommitMsg] = createSignal('')
  const [committing, setCommitting] = createSignal(false)
  const [diffPath, setDiffPath] = createSignal<string | null>(null)
  const [diffText, setDiffText] = createSignal<string | null>(null)
  const [diffLoading, setDiffLoading] = createSignal(false)
  const [actionError, setActionError] = createSignal<string | null>(null)

  // Detail state - VS Code UX
  const [branches, setBranches] = createSignal<string[]>([])
  const [branchDropdownOpen, setBranchDropdownOpen] = createSignal(false)
  const [branchFilter, setBranchFilter] = createSignal('')
  const [pushing, setPushing] = createSignal(false)
  const [pulling, setPulling] = createSignal(false)
  const [checkingOut, setCheckingOut] = createSignal(false)
  const [commits, setCommits] = createSignal<CommitInfo[]>([])
  const [sectionsCollapsed, setSectionsCollapsed] = createSignal<Record<string, boolean>>({ commits: true })

  const orgId = () => ws()?.orgId
  const activeProjectIdFromStore = () => ws()?.activeProjectId ?? null

  // The effective project ID for detail view: local selection or store
  const effectiveProjectId = () => selectedProjectId() ?? activeProjectIdFromStore()

  // Determine which view to show
  const showDetail = () => effectiveProjectId() !== null

  // ── Overview: fetch projects ──────────────────────────────────────

  const fetchProjects = async () => {
    const o = orgId()
    if (!o) {
      setProjects([])
      return
    }
    setOverviewLoading(true)
    setOverviewError(null)
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(o)}/projects`)
      if (!res.ok) {
        setOverviewError('Failed to load projects')
        setOverviewLoading(false)
        return
      }
      const data: Project[] = await res.json()
      setProjects(data)
    } catch {
      setOverviewError('Failed to load projects')
    } finally {
      setOverviewLoading(false)
    }
  }

  // ── Overview: fetch statuses for all projects ─────────────────────

  const fetchAllStatuses = async () => {
    const o = orgId()
    const projs = projects()
    if (!o || projs.length === 0) return

    const newStatuses = new Map<string, ProjectStatus>()

    await Promise.all(
      projs.map(async (proj) => {
        const entry: ProjectStatus = { project: proj, status: null, loading: true, error: null }
        newStatuses.set(proj.id, entry)
        try {
          const res = await fetch(
            `/api/git/status?orgId=${encodeURIComponent(o)}&projectId=${encodeURIComponent(proj.id)}`
          )
          if (!res.ok) {
            entry.error = 'Failed to load status'
            entry.loading = false
            return
          }
          const data = await res.json()
          entry.status = parseStatus(data)
          entry.loading = false
        } catch {
          entry.error = 'Failed to load status'
          entry.loading = false
        }
      })
    )

    setProjectStatuses(new Map(newStatuses))
  }

  // ── Detect repos ──────────────────────────────────────────────────

  const detectProjects = async () => {
    const o = orgId()
    if (!o) return
    setDetecting(true)
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(o)}/detect-projects`, { method: 'POST' })
      if (!res.ok) {
        setOverviewError('Detection failed')
        return
      }
      await fetchProjects()
    } catch {
      setOverviewError('Detection failed')
    } finally {
      setDetecting(false)
    }
  }

  // ── Detail: fetch status for selected project ─────────────────────

  const fetchDetailStatus = async () => {
    const o = orgId()
    const p = effectiveProjectId()
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
      setStatus(parseStatus(data))
    } catch {
      setError('Failed to load status')
    } finally {
      setLoading(false)
    }
  }

  // ── Git actions (detail view) ─────────────────────────────────────

  const postGit = async (endpoint: string, body: Record<string, unknown>) => {
    setActionError(null)
    const res = await fetch(`/api/git/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: orgId(), projectId: effectiveProjectId(), ...body })
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
      await fetchDetailStatus()
    } catch (e: unknown) {
      setActionError((e as Error).message)
    }
  }

  const unstageFile = async (path: string) => {
    try {
      await postGit('unstage', { paths: [path] })
      await fetchDetailStatus()
    } catch (e: unknown) {
      setActionError((e as Error).message)
    }
  }

  const stageAll = async () => {
    const s = status()
    if (!s) return
    const allPaths = [...s.unstaged.map((f) => f.path), ...s.untracked]
    if (allPaths.length === 0) return
    try {
      await postGit('stage', { paths: allPaths })
      await fetchDetailStatus()
    } catch (e: unknown) {
      setActionError((e as Error).message)
    }
  }

  const unstageAll = async () => {
    const s = status()
    if (!s) return
    const allPaths = s.staged.map((f) => f.path)
    if (allPaths.length === 0) return
    try {
      await postGit('unstage', { paths: allPaths })
      await fetchDetailStatus()
    } catch (e: unknown) {
      setActionError((e as Error).message)
    }
  }

  const doCommit = async () => {
    const msg = commitMsg().trim()
    if (!msg) return
    setCommitting(true)
    try {
      await postGit('commit', { message: msg })
      setCommitMsg('')
      await fetchDetailStatus()
    } catch (e: unknown) {
      setActionError((e as Error).message)
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
      const p = effectiveProjectId()
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

  // ── New actions (VS Code UX) ───────────────────────────────────

  const fetchBranches = async () => {
    const o = orgId()
    const p = effectiveProjectId()
    if (!o || !p) return
    try {
      const res = await fetch(`/api/git/branches?orgId=${encodeURIComponent(o)}&projectId=${encodeURIComponent(p)}`)
      if (res.ok) {
        const data: string[] = await res.json()
        setBranches(data)
      }
    } catch {
      /* ignore */
    }
  }

  const fetchCommits = async () => {
    const o = orgId()
    const p = effectiveProjectId()
    if (!o || !p) return
    try {
      const res = await fetch(`/api/git/log?orgId=${encodeURIComponent(o)}&projectId=${encodeURIComponent(p)}&limit=20`)
      if (res.ok) {
        const data: CommitInfo[] = await res.json()
        setCommits(data)
      }
    } catch {
      /* ignore */
    }
  }

  const doPush = async () => {
    setPushing(true)
    try {
      await postGit('push', {})
      await fetchDetailStatus()
      await fetchCommits()
    } catch (e: unknown) {
      setActionError((e as Error).message)
    } finally {
      setPushing(false)
    }
  }

  const doPull = async () => {
    setPulling(true)
    try {
      await postGit('pull', {})
      await fetchDetailStatus()
      await fetchCommits()
    } catch (e: unknown) {
      setActionError((e as Error).message)
    } finally {
      setPulling(false)
    }
  }

  const doSync = async () => {
    setPulling(true)
    try {
      await postGit('pull', {})
    } catch (e: unknown) {
      setActionError((e as Error).message)
      setPulling(false)
      return
    }
    setPulling(false)
    setPushing(true)
    try {
      await postGit('push', {})
      await fetchDetailStatus()
      await fetchCommits()
    } catch (e: unknown) {
      setActionError((e as Error).message)
    } finally {
      setPushing(false)
    }
  }

  const doCheckout = async (branch: string, create?: boolean) => {
    setCheckingOut(true)
    setBranchDropdownOpen(false)
    setBranchFilter('')
    try {
      await postGit('checkout', { branch, create })
      await fetchDetailStatus()
      await fetchBranches()
      await fetchCommits()
    } catch (e: unknown) {
      setActionError((e as Error).message)
    } finally {
      setCheckingOut(false)
    }
  }

  const toggleSection = (key: string) => {
    setSectionsCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const isSectionCollapsed = (key: string) => !!sectionsCollapsed()[key]

  // ── Navigation ────────────────────────────────────────────────────

  const drillInto = (proj: Project) => {
    setSelectedProjectId(proj.id)
    setSelectedProjectName(proj.name)
    // Reset detail state
    setStatus(null)
    setCommitMsg('')
    setDiffPath(null)
    setDiffText(null)
    setActionError(null)
    setBranches([])
    setCommits([])
    setBranchDropdownOpen(false)
    setBranchFilter('')
    setSectionsCollapsed({ commits: true })
  }

  const goBack = () => {
    setSelectedProjectId(null)
    setSelectedProjectName('')
    setStatus(null)
    setCommitMsg('')
    setDiffPath(null)
    setDiffText(null)
    setActionError(null)
    setBranches([])
    setCommits([])
    setBranchDropdownOpen(false)
    setBranchFilter('')
    setSectionsCollapsed({ commits: true })
  }

  // ── Effects & Polling ─────────────────────────────────────────────

  // When org changes, refetch projects and reset selection
  createEffect(
    on(orgId, () => {
      setSelectedProjectId(null)
      setSelectedProjectName('')
      void fetchProjects()
    })
  )

  // When projects load, fetch all statuses
  createEffect(
    on(projects, () => {
      void fetchAllStatuses()
    })
  )

  // When entering detail view, fetch status + branches + commits
  createEffect(
    on(effectiveProjectId, (pid) => {
      if (pid) {
        void fetchDetailStatus()
        void fetchBranches()
        void fetchCommits()
      }
    })
  )

  // When store sets activeProjectId externally, resolve its name
  createEffect(
    on(activeProjectIdFromStore, (storeProjectId) => {
      if (storeProjectId && !selectedProjectId()) {
        // Try to find name from loaded projects
        const proj = projects().find((p) => p.id === storeProjectId)
        if (proj) {
          setSelectedProjectName(proj.name)
        } else {
          setSelectedProjectName(ws()?.activeProjectName ?? storeProjectId)
        }
      }
    })
  )

  // Polling: overview polls every 15s, detail polls every 10s
  let pollInterval: ReturnType<typeof setInterval> | null = null

  const setupPolling = () => {
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
    if (showDetail()) {
      pollInterval = setInterval(() => void fetchDetailStatus(), 10_000)
    } else {
      pollInterval = setInterval(() => void fetchAllStatuses(), 15_000)
    }
  }

  createEffect(
    on(showDetail, () => {
      setupPolling()
    })
  )

  onCleanup(() => {
    if (pollInterval) clearInterval(pollInterval)
  })

  // ── File display helpers ──────────────────────────────────────────

  const fileName = (path: string) => path.split('/').pop() ?? path
  const fileDir = (path: string) => {
    const parts = path.split('/')
    return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : ''
  }

  const statusBadge = (s: string) => {
    switch (s) {
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

  const statusColor = (s: string) => {
    switch (s) {
      case 'added':
        return 'var(--c-success, #22c55e)'
      case 'deleted':
        return 'var(--c-error, #ef4444)'
      default:
        return 'var(--c-warning, #f59e0b)'
    }
  }

  const relativeTime = (dateStr: string) => {
    const now = Date.now()
    const then = new Date(dateStr).getTime()
    const diffSec = Math.floor((now - then) / 1000)
    if (diffSec < 60) return 'just now'
    const diffMin = Math.floor(diffSec / 60)
    if (diffMin < 60) return `${diffMin}m ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `${diffH}h ago`
    const diffD = Math.floor(diffH / 24)
    if (diffD < 30) return `${diffD}d ago`
    const diffMo = Math.floor(diffD / 30)
    if (diffMo < 12) return `${diffMo}mo ago`
    return `${Math.floor(diffMo / 12)}y ago`
  }

  // ── Sub-components ────────────────────────────────────────────────

  const FileRow: Component<{
    path: string
    status?: string
    color: string
    staged?: boolean
    onStage?: () => void
    onUnstage?: () => void
    onClickFile: () => void
  }> = (props) => (
    <div
      class="group flex items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-black/10"
      style={{ cursor: 'pointer' }}
      onClick={props.onClickFile}
    >
      <Show when={props.status}>
        <span
          class="w-4 shrink-0 text-center font-mono text-[10px] font-bold"
          style={{ color: statusColor(props.status!) }}
        >
          {statusBadge(props.status!)}
        </span>
      </Show>
      <div class="min-w-0 flex-1 truncate" style={{ color: props.color }} title={props.path}>
        <span style={{ color: 'var(--c-text-muted)', 'font-size': '0.6rem' }}>{fileDir(props.path)}</span>
        {fileName(props.path)}
      </div>
      <Show when={props.onStage}>
        <button
          class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: 'var(--c-bg)', color: 'var(--c-success, #22c55e)', border: '1px solid var(--c-border)' }}
          onClick={(e) => {
            e.stopPropagation()
            props.onStage!()
          }}
          title="Stage"
        >
          +
        </button>
      </Show>
      <Show when={props.onUnstage}>
        <button
          class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: 'var(--c-bg)', color: 'var(--c-error, #ef4444)', border: '1px solid var(--c-border)' }}
          onClick={(e) => {
            e.stopPropagation()
            props.onUnstage!()
          }}
          title="Unstage"
        >
          −
        </button>
      </Show>
    </div>
  )

  /** Collapsible section header (VS Code style) */
  const SectionHeader: Component<{
    label: string
    count: number
    sectionKey: string
    color?: string
    actionLabel?: string
    onAction?: () => void
  }> = (props) => (
    <div class="flex items-center justify-between px-1 py-1">
      <button
        class="flex items-center gap-1 text-[10px] font-semibold tracking-wide uppercase"
        style={{
          color: props.color ?? 'var(--c-text-muted)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0
        }}
        onClick={() => toggleSection(props.sectionKey)}
      >
        <span
          style={{
            display: 'inline-block',
            transition: 'transform 0.15s',
            transform: isSectionCollapsed(props.sectionKey) ? 'rotate(0deg)' : 'rotate(90deg)',
            'font-size': '8px'
          }}
        >
          ▶
        </span>
        {props.label} ({props.count})
      </button>
      <Show when={props.actionLabel && props.onAction}>
        <button
          class="text-[10px]"
          style={{ color: 'var(--c-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          onClick={props.onAction}
        >
          {props.actionLabel}
        </button>
      </Show>
    </div>
  )

  // ── Overview View ─────────────────────────────────────────────────

  const OverviewView: Component = () => (
    <div class="flex flex-col gap-2 p-2">
      <Show when={overviewError()}>
        <div
          class="rounded px-2 py-1 text-xs"
          style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--c-error, #ef4444)' }}
        >
          {overviewError()}
        </div>
      </Show>

      <Show
        when={!overviewLoading() || projects().length > 0}
        fallback={
          <p class="p-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
            Loading projects…
          </p>
        }
      >
        <Show
          when={projects().length > 0}
          fallback={
            <div class="flex flex-col items-center gap-2 py-6">
              <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                No repositories found
              </p>
              <button
                class="rounded px-3 py-1.5 text-xs font-medium"
                style={{
                  background: 'var(--c-accent)',
                  color: 'white',
                  cursor: detecting() ? 'default' : 'pointer',
                  opacity: detecting() ? '0.6' : '1'
                }}
                disabled={detecting()}
                onClick={() => void detectProjects()}
              >
                {detecting() ? 'Detecting…' : 'Detect repos'}
              </button>
            </div>
          }
        >
          <For each={projects()}>
            {(proj) => {
              const ps = () => projectStatuses().get(proj.id)
              const st = () => ps()?.status ?? null
              const summary = () => (st() ? changeSummary(st()!) : null)

              return (
                <button
                  class="flex w-full flex-col gap-1 rounded border px-3 py-2 text-left transition-colors hover:brightness-110"
                  style={{
                    background: 'var(--c-bg)',
                    'border-color': summary()?.clean === false ? 'var(--c-warning, #f59e0b)' : 'var(--c-border)',
                    cursor: 'pointer'
                  }}
                  onClick={() => drillInto(proj)}
                >
                  {/* Project name */}
                  <span class="text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
                    {proj.name}
                  </span>

                  {/* Branch + ahead/behind */}
                  <Show when={st()}>
                    {(s) => (
                      <div class="flex items-center gap-1.5">
                        <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                          ⎇
                        </span>
                        <span class="text-[10px] font-medium" style={{ color: 'var(--c-text)' }}>
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
                    )}
                  </Show>

                  {/* Change summary */}
                  <Show
                    when={summary()}
                    fallback={
                      <Show when={ps()?.loading}>
                        <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                          Loading…
                        </span>
                      </Show>
                    }
                  >
                    {(sum) => (
                      <span
                        class="text-[10px]"
                        style={{
                          color: sum().clean ? 'var(--c-success, #22c55e)' : 'var(--c-warning, #f59e0b)'
                        }}
                      >
                        {sum().text}
                      </span>
                    )}
                  </Show>

                  {/* Error */}
                  <Show when={ps()?.error}>
                    <span class="text-[10px]" style={{ color: 'var(--c-error, #ef4444)' }}>
                      {ps()!.error}
                    </span>
                  </Show>
                </button>
              )
            }}
          </For>

          {/* Detect repos button at bottom */}
          <button
            class="mt-1 flex w-full items-center justify-center gap-1 rounded border px-2 py-1.5 text-[10px] transition-colors"
            style={{
              background: 'transparent',
              'border-color': 'var(--c-border)',
              color: 'var(--c-text-muted)',
              cursor: detecting() ? 'default' : 'pointer',
              opacity: detecting() ? '0.6' : '1',
              'border-style': 'dashed'
            }}
            disabled={detecting()}
            onClick={() => void detectProjects()}
          >
            {detecting() ? 'Detecting…' : '+ Detect repos'}
          </button>
        </Show>
      </Show>
    </div>
  )

  // ── Detail View ───────────────────────────────────────────────────

  const DetailView: Component = () => {
    const detailProjectName = () => {
      if (selectedProjectName()) return selectedProjectName()
      const storeId = activeProjectIdFromStore()
      if (storeId) {
        const proj = projects().find((p) => p.id === storeId)
        return proj?.name ?? ws()?.activeProjectName ?? storeId
      }
      return ''
    }

    const canCommit = () => commitMsg().trim() && status() && status()!.staged.length > 0

    const filteredBranches = () => {
      const filter = branchFilter().toLowerCase()
      if (!filter) return branches()
      return branches().filter((b) => b.toLowerCase().includes(filter))
    }

    const showCreateBranch = () => {
      const filter = branchFilter().trim()
      if (!filter) return false
      return !branches().some((b) => b === filter)
    }

    return (
      <div class="flex flex-col gap-1 p-2">
        {/* Back button + project name */}
        <div class="flex items-center gap-2 pb-1">
          <Show when={selectedProjectId()}>
            <button
              class="rounded px-1.5 py-0.5 text-[10px]"
              style={{
                color: 'var(--c-text-muted)',
                background: 'var(--c-bg)',
                border: '1px solid var(--c-border)',
                cursor: 'pointer'
              }}
              onClick={goBack}
            >
              ← All repos
            </button>
          </Show>
          <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
            {detailProjectName()}
          </span>
        </div>

        <Show
          when={!loading() || status()}
          fallback={
            <p class="p-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Loading…
            </p>
          }
        >
          <Show
            when={status()}
            fallback={
              <p class="p-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                {error() || 'Could not load git status'}
              </p>
            }
          >
            {(s) => (
              <>
                {/* ── Branch picker ── */}
                <div style={{ position: 'relative' }}>
                  <button
                    class="flex w-full items-center gap-1.5 rounded px-2 py-1.5"
                    style={{
                      background: 'var(--c-bg)',
                      border: '1px solid var(--c-border)',
                      cursor: checkingOut() ? 'default' : 'pointer',
                      opacity: checkingOut() ? '0.6' : '1'
                    }}
                    disabled={checkingOut()}
                    onClick={() => {
                      if (!branchDropdownOpen()) void fetchBranches()
                      setBranchDropdownOpen(!branchDropdownOpen())
                      setBranchFilter('')
                    }}
                  >
                    <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      ⎇
                    </span>
                    <span class="flex-1 text-left text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
                      {checkingOut() ? 'Switching…' : s().branch}
                    </span>
                    <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                      {branchDropdownOpen() ? '▼' : '▶'}
                    </span>
                  </button>

                  {/* Branch dropdown */}
                  <Show when={branchDropdownOpen()}>
                    <div
                      class="absolute right-0 left-0 z-50 mt-1 flex max-h-[240px] flex-col overflow-hidden rounded border"
                      style={{
                        background: 'var(--c-bg-raised, var(--c-bg))',
                        'border-color': 'var(--c-border)',
                        'box-shadow': '0 4px 12px rgba(0,0,0,0.3)'
                      }}
                    >
                      <input
                        class="w-full border-b px-2 py-1.5 text-xs"
                        style={{
                          background: 'transparent',
                          color: 'var(--c-text)',
                          'border-color': 'var(--c-border)',
                          outline: 'none'
                        }}
                        placeholder="Filter or create branch…"
                        value={branchFilter()}
                        onInput={(e) => setBranchFilter(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setBranchDropdownOpen(false)
                            setBranchFilter('')
                          } else if (e.key === 'Enter') {
                            const filter = branchFilter().trim()
                            if (filter && showCreateBranch()) {
                              void doCheckout(filter, true)
                            } else if (filteredBranches().length === 1) {
                              void doCheckout(filteredBranches()[0])
                            }
                          }
                        }}
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                      />
                      <div class="flex-1 overflow-auto">
                        <Show when={showCreateBranch()}>
                          <button
                            class="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs hover:bg-black/10"
                            style={{
                              color: 'var(--c-accent)',
                              cursor: 'pointer',
                              background: 'none',
                              border: 'none',
                              'text-align': 'left'
                            }}
                            onClick={() => void doCheckout(branchFilter().trim(), true)}
                          >
                            + Create branch: <strong>{branchFilter().trim()}</strong>
                          </button>
                        </Show>
                        <For each={filteredBranches()}>
                          {(branch) => (
                            <button
                              class="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs hover:bg-black/10"
                              style={{
                                color: branch === s().branch ? 'var(--c-accent)' : 'var(--c-text)',
                                cursor: 'pointer',
                                background: 'none',
                                border: 'none',
                                'text-align': 'left',
                                'font-weight': branch === s().branch ? '600' : '400'
                              }}
                              onClick={() => {
                                if (branch !== s().branch) void doCheckout(branch)
                                else {
                                  setBranchDropdownOpen(false)
                                  setBranchFilter('')
                                }
                              }}
                            >
                              <Show when={branch === s().branch}>
                                <span style={{ color: 'var(--c-accent)' }}>✓</span>
                              </Show>
                              {branch}
                            </button>
                          )}
                        </For>
                        <Show when={filteredBranches().length === 0 && !showCreateBranch()}>
                          <p class="px-2 py-1.5 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                            No branches found
                          </p>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </div>

                {/* ── Commit input (always visible, VS Code style) ── */}
                <div
                  class="flex items-start gap-1 rounded border p-1.5"
                  style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)' }}
                >
                  <textarea
                    class="flex-1 resize-none rounded border-none px-1.5 py-1 text-xs"
                    style={{
                      background: 'var(--c-bg-raised, var(--c-bg))',
                      color: 'var(--c-text)',
                      outline: 'none',
                      'font-family': 'inherit',
                      'min-height': '36px',
                      'max-height': '80px',
                      border: '1px solid var(--c-border)'
                    }}
                    placeholder="Commit message (⌘Enter to commit)"
                    value={commitMsg()}
                    onInput={(e) => setCommitMsg(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault()
                        if (canCommit()) void doCommit()
                      }
                    }}
                  />
                  <button
                    class="shrink-0 rounded px-2 py-1 text-xs font-medium"
                    style={{
                      background: canCommit() ? 'var(--c-accent)' : 'var(--c-border)',
                      color: canCommit() ? 'white' : 'var(--c-text-muted)',
                      cursor: canCommit() ? 'pointer' : 'default',
                      opacity: committing() ? '0.6' : '1',
                      border: 'none',
                      'line-height': '1.5'
                    }}
                    disabled={!canCommit() || committing()}
                    onClick={() => void doCommit()}
                    title="Commit (⌘Enter)"
                  >
                    {committing() ? '…' : '✓'}
                  </button>
                </div>

                {/* ── Push / Pull / Sync toolbar ── */}
                <div class="flex items-center gap-1">
                  <Show when={s().ahead > 0 && s().behind > 0}>
                    <button
                      class="flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[10px] font-medium"
                      style={{
                        background: 'var(--c-bg)',
                        border: '1px solid var(--c-border)',
                        color: 'var(--c-text)',
                        cursor: pushing() || pulling() ? 'default' : 'pointer',
                        opacity: pushing() || pulling() ? '0.6' : '1'
                      }}
                      disabled={pushing() || pulling()}
                      onClick={() => void doSync()}
                      title="Pull then Push"
                    >
                      {pulling() ? '↓…' : pushing() ? '↑…' : '↑↓'} Sync
                      <Show when={s().behind > 0}>
                        <span style={{ color: 'var(--c-warning, #f59e0b)' }}>↓{s().behind}</span>
                      </Show>
                      <Show when={s().ahead > 0}>
                        <span style={{ color: 'var(--c-accent)' }}>↑{s().ahead}</span>
                      </Show>
                    </button>
                  </Show>
                  <Show when={!(s().ahead > 0 && s().behind > 0)}>
                    <button
                      class="flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[10px] font-medium"
                      style={{
                        background: 'var(--c-bg)',
                        border: '1px solid var(--c-border)',
                        color: 'var(--c-text)',
                        cursor: pulling() ? 'default' : 'pointer',
                        opacity: pulling() ? '0.6' : '1'
                      }}
                      disabled={pulling()}
                      onClick={() => void doPull()}
                      title="Pull"
                    >
                      {pulling() ? '↓…' : '↓'} Pull
                      <Show when={s().behind > 0}>
                        <span
                          class="ml-0.5 rounded-full px-1"
                          style={{ background: 'var(--c-warning, #f59e0b)', color: 'white', 'font-size': '9px' }}
                        >
                          {s().behind}
                        </span>
                      </Show>
                    </button>
                    <button
                      class="flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[10px] font-medium"
                      style={{
                        background: 'var(--c-bg)',
                        border: '1px solid var(--c-border)',
                        color: 'var(--c-text)',
                        cursor: pushing() ? 'default' : 'pointer',
                        opacity: pushing() ? '0.6' : '1'
                      }}
                      disabled={pushing()}
                      onClick={() => void doPush()}
                      title="Push"
                    >
                      {pushing() ? '↑…' : '↑'} Push
                      <Show when={s().ahead > 0}>
                        <span
                          class="ml-0.5 rounded-full px-1"
                          style={{ background: 'var(--c-accent)', color: 'white', 'font-size': '9px' }}
                        >
                          {s().ahead}
                        </span>
                      </Show>
                    </button>
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

                {/* ── Staged changes (collapsible) ── */}
                <Show when={s().staged.length > 0}>
                  <div>
                    <SectionHeader
                      label="Staged Changes"
                      count={s().staged.length}
                      sectionKey="staged"
                      color="var(--c-success, #22c55e)"
                      actionLabel="Unstage All"
                      onAction={unstageAll}
                    />
                    <Show when={!isSectionCollapsed('staged')}>
                      <For each={s().staged}>
                        {(f) => (
                          <FileRow
                            path={f.path}
                            status={f.status}
                            color="var(--c-text)"
                            staged={true}
                            onUnstage={() => void unstageFile(f.path)}
                            onClickFile={() => void showDiff(f.path)}
                          />
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>

                {/* ── Unstaged changes (collapsible) ── */}
                <Show when={s().unstaged.length > 0}>
                  <div>
                    <SectionHeader
                      label="Changes"
                      count={s().unstaged.length}
                      sectionKey="changes"
                      color="var(--c-warning, #f59e0b)"
                      actionLabel="Stage All"
                      onAction={stageAll}
                    />
                    <Show when={!isSectionCollapsed('changes')}>
                      <For each={s().unstaged}>
                        {(f) => (
                          <FileRow
                            path={f.path}
                            status={f.status}
                            color="var(--c-text)"
                            onStage={() => void stageFile(f.path)}
                            onClickFile={() => void showDiff(f.path)}
                          />
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>

                {/* ── Untracked files (collapsible) ── */}
                <Show when={s().untracked.length > 0}>
                  <div>
                    <SectionHeader
                      label="Untracked"
                      count={s().untracked.length}
                      sectionKey="untracked"
                      color="var(--c-text-muted)"
                      actionLabel="Stage All"
                      onAction={() => {
                        const paths = s().untracked
                        if (paths.length > 0) void postGit('stage', { paths }).then(() => fetchDetailStatus())
                      }}
                    />
                    <Show when={!isSectionCollapsed('untracked')}>
                      <For each={s().untracked}>
                        {(f) => (
                          <FileRow
                            path={f}
                            color="var(--c-text-muted)"
                            onStage={() => void stageFile(f)}
                            onClickFile={() => void showDiff(f)}
                          />
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>

                {/* Clean state */}
                <Show when={s().staged.length === 0 && s().unstaged.length === 0 && s().untracked.length === 0}>
                  <p class="px-1 py-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                    ✓ Working tree clean
                  </p>
                </Show>

                {/* ── Commit log (collapsible, default collapsed) ── */}
                <div>
                  <SectionHeader
                    label="Commits"
                    count={commits().length}
                    sectionKey="commits"
                    color="var(--c-text-muted)"
                  />
                  <Show when={!isSectionCollapsed('commits')}>
                    <Show
                      when={commits().length > 0}
                      fallback={
                        <p class="px-1 py-1 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                          No commits loaded
                        </p>
                      }
                    >
                      <div class="flex flex-col">
                        <For each={commits()}>
                          {(c) => (
                            <div
                              class="flex items-baseline gap-1.5 rounded px-1 py-0.5 text-[10px]"
                              title={`${c.hash}\n${c.author}\n${c.date}`}
                            >
                              <span
                                class="shrink-0 font-mono"
                                style={{ color: 'var(--c-text-muted)', 'font-size': '10px' }}
                              >
                                {c.shortHash}
                              </span>
                              <span class="min-w-0 flex-1 truncate" style={{ color: 'var(--c-text)' }}>
                                {c.message}
                              </span>
                              <span class="shrink-0" style={{ color: 'var(--c-text-muted)', 'font-size': '9px' }}>
                                {relativeTime(c.date)}
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </div>

                {/* ── Inline diff viewer ── */}
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
                        style={{ color: 'var(--c-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
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
              </>
            )}
          </Show>
        </Show>
      </div>
    )
  }

  // ── Main Layout ───────────────────────────────────────────────────

  const refreshAction = () => {
    if (showDetail()) {
      void fetchDetailStatus()
    } else {
      void fetchProjects().then(() => fetchAllStatuses())
    }
  }

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
          onClick={refreshAction}
          title="Refresh"
        >
          ↻
        </button>
      </div>

      <div class="flex-1 overflow-auto">
        <Show when={ws()}>
          <Show when={showDetail()} fallback={<OverviewView />}>
            <DetailView />
          </Show>
        </Show>
        <Show when={!ws()}>
          <p class="p-3 text-xs" style={{ color: 'var(--c-text-muted)' }}>
            No workspace selected
          </p>
        </Show>
      </div>
    </div>
  )
}

export default GitPanel

import { Show, For, createSignal, createEffect, on, onMount } from 'solid-js'
import type { Component } from 'solid-js'
import { activeWorkspace, openPlanningDAG, openIssueDetail } from '../store.js'
import { draftsStore } from '../../drafts/index.js'

export interface PlanningCompletion {
  total: number
  closed: number
  percentage: number
  ready: number
  blocked: number
  inProgress: number
}

export interface PlanningIssue {
  id: string
  projectId: string
  orgId: string
  remote: string
  title: string
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  providerUrl?: string
}

export function buildPlanningUrl(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/planning/completion`
}

export function buildIssuesUrl(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/issues`
}

export function buildBlockedUrl(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/planning/blocked`
}

export function buildReadyUrl(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/planning/ready`
}

interface EntityRef {
  orgId: string
  projectId: string
  remote: string
  issueId: string
}

function refKey(r: EntityRef): string {
  return `${r.orgId}:${r.projectId}:${r.remote}:${r.issueId}`
}

function planningFilterKey(orgId: string): string {
  return `sovereign:planning-projects:${orgId}`
}

function loadProjectFilter(orgId: string): string[] | null {
  try {
    const raw = localStorage.getItem(planningFilterKey(orgId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveProjectFilter(orgId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(planningFilterKey(orgId), JSON.stringify([...ids]))
  } catch {
    /* ignore */
  }
}

interface ProjectInfo {
  id: string
  name: string
}

const PlanningPanel: Component = () => {
  const ws = () => activeWorkspace()
  const [completion, setCompletion] = createSignal<PlanningCompletion | null>(null)
  const [issues, setIssues] = createSignal<PlanningIssue[]>([])
  const [projects, setProjects] = createSignal<ProjectInfo[]>([])
  const [enabledProjectIds, setEnabledProjectIds] = createSignal<Set<string>>(new Set())
  const [blockedIds, setBlockedIds] = createSignal<Set<string>>(new Set())
  const [readyIds, setReadyIds] = createSignal<Set<string>>(new Set())
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [syncing, setSyncing] = createSignal(false)
  const [syncResult, setSyncResult] = createSignal<string | null>(null)
  const [newDraftTitle, setNewDraftTitle] = createSignal('')
  const [creatingDraft, setCreatingDraft] = createSignal(false)
  const [expandedSections, setExpandedSections] = createSignal<Record<string, boolean>>({
    drafts: true,
    ready: true,
    blocked: true,
    inProgress: true
  })

  function toggleSection(key: string): void {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function toggleProject(projectId: string): void {
    const orgId = ws()?.orgId
    setEnabledProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      if (orgId) saveProjectFilter(orgId, next)
      return next
    })
  }

  async function fetchAll(orgId: string) {
    setLoading(true)
    setError(null)
    try {
      const [compRes, issuesRes, blockedRes, readyRes, projectsRes] = await Promise.all([
        fetch(buildPlanningUrl(orgId)),
        fetch(buildIssuesUrl(orgId)),
        fetch(buildBlockedUrl(orgId)),
        fetch(buildReadyUrl(orgId)),
        fetch(`/api/orgs/${encodeURIComponent(orgId)}/projects`)
      ])

      if (compRes.ok) {
        const data = await compRes.json()
        // Map raw API shape to our interface
        setCompletion({
          total: data.total ?? 0,
          closed: data.closed ?? 0,
          percentage: data.percentage ?? 0,
          ready: 0,
          blocked: 0,
          inProgress: 0
        })
      } else {
        setCompletion(null)
      }

      if (issuesRes.ok) {
        setIssues(await issuesRes.json())
      }

      if (blockedRes.ok) {
        const refs: EntityRef[] = await blockedRes.json()
        setBlockedIds(new Set(refs.map(refKey)))
      }

      if (readyRes.ok) {
        const refs: EntityRef[] = await readyRes.json()
        setReadyIds(new Set(refs.map(refKey)))
      }

      if (projectsRes.ok) {
        const projs: ProjectInfo[] = await projectsRes.json()
        setProjects(projs)
        // Load persisted filter from localStorage, default all enabled
        const stored = loadProjectFilter(orgId)
        if (stored) {
          setEnabledProjectIds(new Set(stored.filter((id: string) => projs.some((p) => p.id === id))))
        } else {
          setEnabledProjectIds(new Set(projs.map((p) => p.id)))
        }
      }

      // Compute counts from categorized issues
      const allIssues = issues()
      const bSet = blockedIds()
      const rSet = readyIds()
      let readyCount = 0
      let blockedCount = 0
      let inProgressCount = 0
      for (const issue of allIssues) {
        if (issue.state === 'closed') continue
        const key = refKey({ orgId: issue.orgId, projectId: issue.projectId, remote: issue.remote, issueId: issue.id })
        if (bSet.has(key)) blockedCount++
        else if (rSet.has(key)) readyCount++
        else inProgressCount++
      }
      setCompletion((prev) =>
        prev ? { ...prev, ready: readyCount, blocked: blockedCount, inProgress: inProgressCount } : prev
      )
    } catch {
      setError('Failed to load planning data')
      setCompletion(null)
    } finally {
      setLoading(false)
    }
  }

  async function syncPlanning(orgId: string) {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/planning/sync`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        await fetchAll(orgId)
        const c = completion()
        if (c && c.total === 0) {
          setSyncResult(
            `Synced — ${data.parsed ?? 0} issues found. No planning items yet. Add issues via your configured provider (GitHub/Radicle) to populate the plan.`
          )
        }
      } else {
        setSyncResult('Sync failed — check provider configuration.')
      }
    } catch {
      setSyncResult('Sync failed — could not reach server.')
    } finally {
      setSyncing(false)
    }
  }

  createEffect(
    on(
      () => ws()?.orgId,
      (orgId) => {
        if (orgId) fetchAll(orgId)
        draftsStore.fetchDrafts(orgId || undefined)
        if (!orgId) {
          setCompletion(null)
          setIssues([])
          setProjects([])
          setEnabledProjectIds(new Set())
          setError(null)
          setSyncResult(null)
        }
      }
    )
  )

  const filteredIssues = () => {
    const enabled = enabledProjectIds()
    const all = issues()
    if (enabled.size === 0 || enabled.size === projects().length) return all
    return all.filter((i) => enabled.has(i.projectId))
  }

  const categorizedIssues = () => {
    const all = filteredIssues()
    const bSet = blockedIds()
    const rSet = readyIds()
    const ready: PlanningIssue[] = []
    const blocked: PlanningIssue[] = []
    const inProgress: PlanningIssue[] = []

    for (const issue of all) {
      if (issue.state === 'closed') continue
      const key = refKey({ orgId: issue.orgId, projectId: issue.projectId, remote: issue.remote, issueId: issue.id })
      if (bSet.has(key)) blocked.push(issue)
      else if (rSet.has(key)) ready.push(issue)
      else inProgress.push(issue)
    }
    return { ready, blocked, inProgress }
  }

  const isEmpty = () => {
    const c = completion()
    return c && c.total === 0
  }

  const hasData = () => {
    const c = completion()
    return c && c.total > 0
  }

  return (
    <div class="flex h-full flex-col">
      <div class="border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
            Planning
          </span>
        </div>
        <Show when={projects().length > 1}>
          <div class="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-2">
            <For each={projects()}>
              {(p) => (
                <label
                  class="flex cursor-pointer items-center gap-1 text-[10px]"
                  style={{ color: enabledProjectIds().has(p.id) ? 'var(--c-text)' : 'var(--c-text-muted)' }}
                >
                  <input
                    type="checkbox"
                    checked={enabledProjectIds().has(p.id)}
                    onChange={() => toggleProject(p.id)}
                    class="h-3 w-3 rounded"
                    style={{ 'accent-color': 'var(--c-accent)' }}
                  />
                  {p.name}
                </label>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="flex-1 overflow-auto p-3">
        <Show
          when={ws()}
          fallback={
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              No workspace
            </p>
          }
        >
          <Show when={loading() && !syncing()}>
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Loading...
            </p>
          </Show>

          <Show when={error()}>
            <p class="text-xs" style={{ color: 'var(--c-error)' }}>
              {error()}
            </p>
          </Show>

          <Show when={!loading() && !error() && isEmpty()}>
            <div class="flex flex-col items-center gap-3 py-8">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                style={{ color: 'var(--c-text-muted)' }}
              >
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
                <rect x="9" y="3" width="6" height="4" rx="1" />
                <line x1="9" y1="12" x2="15" y2="12" />
                <line x1="9" y1="16" x2="13" y2="16" />
              </svg>
              <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                No planning data for this workspace
              </p>
              <button
                class="rounded px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  background: 'var(--c-accent)',
                  color: 'var(--c-text-on-accent)',
                  opacity: syncing() ? '0.6' : '1',
                  cursor: syncing() ? 'not-allowed' : 'pointer'
                }}
                disabled={syncing()}
                onClick={() => {
                  const orgId = ws()?.orgId
                  if (orgId) syncPlanning(orgId)
                }}
              >
                {syncing() ? 'Syncing...' : 'Sync from Provider'}
              </button>
              <Show when={syncResult()}>
                <p class="text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  {syncResult()}
                </p>
              </Show>
            </div>
          </Show>

          <Show when={!loading() && !error() && hasData()}>
            {(() => {
              const c = () => completion()!
              const cats = categorizedIssues
              // Compute filtered stats reactively
              const filteredStats = () => {
                const fi = filteredIssues()
                const bSet = blockedIds()
                const rSet = readyIds()
                let total = fi.length
                let closed = 0
                let readyCount = 0
                let blockedCount = 0
                let inProgressCount = 0
                for (const issue of fi) {
                  if (issue.state === 'closed') { closed++; continue }
                  const key = refKey({ orgId: issue.orgId, projectId: issue.projectId, remote: issue.remote, issueId: issue.id })
                  if (bSet.has(key)) blockedCount++
                  else if (rSet.has(key)) readyCount++
                  else inProgressCount++
                }
                const percentage = total > 0 ? Math.round((closed / total) * 100) : 0
                return { total, closed, percentage, ready: readyCount, blocked: blockedCount, inProgress: inProgressCount }
              }
              const fs = filteredStats
              return (
                <div class="flex flex-col gap-3">
                  {/* Progress bar */}
                  <div class="flex items-center gap-2">
                    <div
                      class="h-1.5 flex-1 overflow-hidden rounded-full"
                      style={{ background: 'var(--c-bg-tertiary)' }}
                    >
                      <div
                        class="h-full rounded-full transition-all"
                        style={{ width: `${fs().percentage}%`, background: 'var(--c-accent)' }}
                      />
                    </div>
                    <span class="text-xs tabular-nums" style={{ color: 'var(--c-text-muted)' }}>
                      {fs().percentage}%
                    </span>
                  </div>

                  {/* Stats grid */}
                  <div class="grid grid-cols-2 gap-2">
                    <StatCard label="Total" value={fs().total} color="var(--c-text)" />
                    <StatCard label="Ready" value={fs().ready} color="var(--c-success)" />
                    <StatCard label="In Progress" value={fs().inProgress} color="var(--c-warning, #f59e0b)" />
                    <StatCard label="Blocked" value={fs().blocked} color="var(--c-error)" />
                  </div>

                  {/* View Full DAG button */}
                  <button
                    class="mt-1 rounded px-2 py-1.5 text-xs font-medium transition-colors"
                    style={{
                      background: 'var(--c-accent)',
                      color: 'var(--c-text-on-accent)'
                    }}
                    onClick={() => openPlanningDAG()}
                  >
                    View Full DAG
                  </button>

                  {/* Sync button */}
                  <button
                    class="rounded px-2 py-1 text-xs transition-colors"
                    style={{
                      background: 'var(--c-bg-secondary)',
                      color: 'var(--c-text-muted)',
                      cursor: syncing() ? 'not-allowed' : 'pointer',
                      opacity: syncing() ? '0.6' : '1'
                    }}
                    disabled={syncing()}
                    onClick={() => {
                      const orgId = ws()?.orgId
                      if (orgId) syncPlanning(orgId)
                    }}
                  >
                    {syncing() ? 'Syncing...' : 'Refresh from provider'}
                  </button>

                  {/* Drafts section */}
                  <DraftsSection
                    expanded={expandedSections().drafts}
                    onToggle={() => toggleSection('drafts')}
                    newTitle={newDraftTitle()}
                    onNewTitleChange={setNewDraftTitle}
                    creatingDraft={creatingDraft()}
                    onCreateDraft={async () => {
                      const t = newDraftTitle().trim()
                      if (!t) return
                      setCreatingDraft(true)
                      try {
                        const d = await draftsStore.createDraft(t)
                        setNewDraftTitle('')
                        draftsStore.selectDraft(d.id)
                      } finally {
                        setCreatingDraft(false)
                      }
                    }}
                    orgs={[]}
                  />

                  {/* Issue sections */}
                  <IssueSection
                    title="Ready"
                    issues={cats().ready}
                    color="var(--c-success)"
                    expanded={expandedSections().ready}
                    onToggle={() => toggleSection('ready')}
                  />
                  <IssueSection
                    title="Blocked"
                    issues={cats().blocked}
                    color="var(--c-error)"
                    expanded={expandedSections().blocked}
                    onToggle={() => toggleSection('blocked')}
                  />
                  <IssueSection
                    title="In Progress"
                    issues={cats().inProgress}
                    color="var(--c-warning, #f59e0b)"
                    expanded={expandedSections().inProgress}
                    onToggle={() => toggleSection('inProgress')}
                  />
                </div>
              )
            })()}
          </Show>
        </Show>
      </div>
    </div>
  )
}

const IssueSection: Component<{
  title: string
  issues: PlanningIssue[]
  color: string
  expanded: boolean
  onToggle: () => void
}> = (props) => (
  <div>
    <button
      class="flex w-full items-center gap-2 rounded px-1 py-1 text-xs font-medium"
      style={{ color: props.color }}
      onClick={props.onToggle}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="currentColor"
        style={{ transform: props.expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}
      >
        <polygon points="2,0 8,5 2,10" />
      </svg>
      {props.title} ({props.issues.length})
    </button>
    <Show when={props.expanded}>
      <div class="ml-1 flex flex-col gap-0.5">
        <For each={props.issues}>{(issue) => <IssueItem issue={issue} />}</For>
        <Show when={props.issues.length === 0}>
          <p class="py-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
            None
          </p>
        </Show>
      </div>
    </Show>
  </div>
)

const IssueItem: Component<{ issue: PlanningIssue }> = (props) => (
  <button
    class="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:opacity-80"
    style={{ background: 'var(--c-bg-secondary)' }}
    onClick={() => openIssueDetail(props.issue.orgId, props.issue.projectId, props.issue.id)}
  >
    <span class="text-xs font-medium" style={{ color: 'var(--c-text)' }}>
      {props.issue.title}
    </span>
    <div class="flex flex-wrap items-center gap-1">
      <For each={props.issue.labels}>
        {(label) => (
          <span
            class="rounded-full px-1.5 py-0 text-[10px]"
            style={{ background: 'var(--c-bg-tertiary)', color: 'var(--c-text-muted)' }}
          >
            {label}
          </span>
        )}
      </For>
      <Show when={props.issue.assignees.length > 0}>
        <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
          {props.issue.assignees.join(', ')}
        </span>
      </Show>
    </div>
  </button>
)

const DraftsSection: Component<{
  expanded: boolean
  onToggle: () => void
  newTitle: string
  onNewTitleChange: (v: string) => void
  creatingDraft: boolean
  onCreateDraft: () => void
  orgs: Array<{ id: string; name: string }>
}> = (props) => {
  const allDrafts = () => draftsStore.drafts().filter((d) => d.status === 'draft')

  return (
    <div>
      <button
        class="flex w-full items-center gap-2 rounded px-1 py-1 text-xs font-medium"
        style={{ color: '#d97706' }}
        onClick={props.onToggle}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          style={{ transform: props.expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}
        >
          <polygon points="2,0 8,5 2,10" />
        </svg>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        Drafts ({allDrafts().length})
      </button>
      <Show when={props.expanded}>
        <div class="ml-1 flex flex-col gap-1">
          {/* New draft input */}
          <div class="flex gap-1">
            <input
              type="text"
              value={props.newTitle}
              onInput={(e) => props.onNewTitleChange(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  props.onCreateDraft()
                }
              }}
              disabled={props.creatingDraft}
              class="flex-1 rounded border px-2 py-1 text-xs"
              style={{
                background: 'var(--c-bg-secondary)',
                'border-color': 'var(--c-border)',
                color: 'var(--c-text)',
                'border-style': 'dashed'
              }}
              placeholder="New draft title + Enter"
            />
          </div>

          <For each={allDrafts()}>
            {(draft) => (
              <button
                class="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:opacity-80"
                style={{
                  background: '#fef3c7',
                  border: '1px dashed #d97706',
                  opacity: draftsStore.selectedDraftId() === draft.id ? '1' : '0.85'
                }}
                onClick={() => draftsStore.selectDraft(draft.id)}
              >
                <span class="text-xs font-medium" style={{ color: '#78350f' }}>
                  {draft.title || 'Untitled draft'}
                </span>
                <div class="flex flex-wrap items-center gap-1">
                  <For each={draft.labels}>
                    {(label) => (
                      <span
                        class="rounded-full px-1.5 py-0 text-[10px]"
                        style={{ background: '#fde68a', color: '#92400e' }}
                      >
                        {label}
                      </span>
                    )}
                  </For>
                  <span class="text-[10px]" style={{ color: '#92400e' }}>
                    {draft.orgId ? 'Assigned' : 'Unassigned'}
                  </span>
                </div>
              </button>
            )}
          </For>
          <Show when={allDrafts().length === 0}>
            <p class="py-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
              No drafts yet
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}

const StatCard: Component<{ label: string; value: number; color: string }> = (props) => (
  <div class="rounded p-2" style={{ background: 'var(--c-bg-secondary)' }}>
    <div class="text-lg font-semibold tabular-nums" style={{ color: props.color }}>
      {props.value}
    </div>
    <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
      {props.label}
    </div>
  </div>
)

export default PlanningPanel

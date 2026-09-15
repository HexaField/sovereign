// TasksPanel — sidebar panel showing the holonic task graph with PR badges.
//
// Fetches tasks from GET /api/tasks, displays them in a flat list grouped by
// state (in-progress → pending → completed). PR-backed tasks show CI/review
// badges. Clicking a task opens a detail drawer with prompt input.

import { createSignal, createResource, Show, For, onCleanup } from 'solid-js'
import type { Component } from 'solid-js'
import { ExternalLinkIcon, SendIcon, RefreshIcon } from '../../../ui/icons.js'

// ── Types ───────────────────────────────────────────────────────────────

interface TaskProviderSummary {
  kind: string
  repo: string
  number: number
  prStatus: string
  checksStatus: string
  reviewDecision: string
  url: string
}

interface TaskListItem {
  id: string
  name: string
  state: string
  threadId: string | null
  transientState: string | null
  childCount: number
  parentCount: number
  provider?: TaskProviderSummary
}

interface TaskDetail {
  id: string
  name: string
  state: string
  threadId: string | null
  description: string | null
  transientState: string | null
  createdAt: string
  updatedAt: string | null
  parentTasks: Array<{ id: string; name: string; state: string }>
  childTasks: Array<{ id: string; name: string; state: string }>
  tags: string[]
  provider?: {
    kind: string
    url: string
    repo: string
    number: number
    prStatus: string
    checksStatus: string
    reviewDecision: string
    lastPolledAt: string
    unresolvedComments: number
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function stateColor(state: string): string {
  switch (state) {
    case 'in_progress':
      return 'var(--c-accent)'
    case 'completed':
      return '#22c55e'
    case 'cancelled':
      return 'var(--c-text-muted)'
    default:
      return 'var(--c-text-muted)'
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case 'in_progress':
      return 'In Progress'
    case 'completed':
      return 'Completed'
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'Pending'
  }
}

function checksColor(status: string): string {
  switch (status) {
    case 'passing':
      return '#22c55e'
    case 'failing':
      return '#ef4444'
    case 'pending':
      return '#f59e0b'
    default:
      return 'var(--c-text-muted)'
  }
}

function reviewLabel(decision: string): string {
  switch (decision) {
    case 'approved':
      return '✓ Approved'
    case 'changes_requested':
      return '✎ Changes'
    case 'review_required':
      return '⏳ Review needed'
    default:
      return ''
  }
}

// ── Fetch helpers ───────────────────────────────────────────────────────

async function fetchTasks(): Promise<TaskListItem[]> {
  const res = await fetch('/api/tasks')
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`)
  const data = await res.json()
  return data.tasks ?? []
}

async function fetchTaskDetail(taskId: string): Promise<TaskDetail | null> {
  // Strip task:// prefix for the URL param
  const id = taskId.replace('task://', '')
  const res = await fetch(`/api/tasks/${id}`)
  if (!res.ok) return null
  return res.json()
}

async function sendPrompt(taskId: string, prompt: string): Promise<void> {
  const id = taskId.replace('task://', '')
  const res = await fetch(`/api/tasks/${id}/send-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? `Send failed: ${res.status}`)
  }
}

async function refreshTask(taskId: string): Promise<void> {
  const id = taskId.replace('task://', '')
  await fetch(`/api/tasks/${id}/poll`, { method: 'POST' })
}

// ── PR Badge ────────────────────────────────────────────────────────────

const PrBadge: Component<{ provider: TaskProviderSummary }> = (props) => {
  return (
    <div class="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
      <span style={{ color: checksColor(props.provider.checksStatus) }}>
        {props.provider.checksStatus === 'passing' ? '●' : props.provider.checksStatus === 'failing' ? '✕' : '○'}
      </span>
      <a
        href={props.provider.url}
        target="_blank"
        rel="noopener"
        class="hover:underline"
        style={{ color: 'var(--c-text-muted)' }}
        onClick={(e) => e.stopPropagation()}
      >
        #{props.provider.number}
      </a>
      <Show when={props.provider.reviewDecision && props.provider.reviewDecision !== 'unknown'}>
        <span
          style={{
            color:
              props.provider.reviewDecision === 'approved'
                ? '#22c55e'
                : props.provider.reviewDecision === 'changes_requested'
                  ? '#ef4444'
                  : 'var(--c-text-muted)'
          }}
        >
          {reviewLabel(props.provider.reviewDecision)}
        </span>
      </Show>
    </div>
  )
}

// ── Task Item ───────────────────────────────────────────────────────────

const TaskItem: Component<{
  task: TaskListItem
  onSelect: (id: string) => void
}> = (props) => {
  return (
    <button
      class="w-full px-3 py-2 text-left transition-colors hover:brightness-110"
      style={{
        background: 'transparent',
        border: 'none',
        'border-bottom': '1px solid var(--c-border)',
        cursor: 'pointer'
      }}
      onClick={() => props.onSelect(props.task.id)}
    >
      <div class="flex items-start gap-2">
        <span
          class="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full"
          style={{ background: stateColor(props.task.state) }}
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs font-medium" style={{ color: 'var(--c-text)' }}>
            {props.task.name}
          </div>
          <Show when={props.task.transientState}>
            <div class="mt-0.5 truncate text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              {props.task.transientState}
            </div>
          </Show>
          <Show when={props.task.provider}>
            <PrBadge provider={props.task.provider!} />
          </Show>
        </div>
      </div>
    </button>
  )
}

// ── Task Detail ─────────────────────────────────────────────────────────

const TaskDetailView: Component<{
  taskId: string
  onBack: () => void
}> = (props) => {
  const [detail, { refetch }] = createResource(() => props.taskId, fetchTaskDetail)
  const [promptText, setPromptText] = createSignal('')
  const [sending, setSending] = createSignal(false)
  const [sendError, setSendError] = createSignal('')

  const handleSend = async () => {
    const text = promptText().trim()
    if (!text || sending()) return
    setSending(true)
    setSendError('')
    try {
      await sendPrompt(props.taskId, text)
      setPromptText('')
    } catch (err) {
      setSendError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  const handleRefresh = async () => {
    await refreshTask(props.taskId)
    refetch()
  }

  return (
    <div class="flex h-full flex-col">
      {/* Header */}
      <div class="flex items-center gap-2 px-3 py-2" style={{ 'border-bottom': '1px solid var(--c-border)' }}>
        <button
          class="px-1 text-xs"
          style={{ color: 'var(--c-text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
          onClick={props.onBack}
        >
          ← Back
        </button>
        <button
          class="ml-auto"
          style={{ color: 'var(--c-text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
          onClick={handleRefresh}
          title="Refresh PR status"
        >
          <RefreshIcon class="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body */}
      <div class="flex-1 overflow-auto px-3 py-2">
        <Show
          when={!detail.loading && detail()}
          fallback={
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Loading...
            </p>
          }
        >
          {(d) => {
            const task = d()
            if (!task) return null
            return (
              <>
                <h3 class="mb-1 text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
                  {task.name}
                </h3>

                {/* State badge */}
                <div class="mb-2 flex items-center gap-2">
                  <span
                    class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ background: stateColor(task.state), color: '#fff' }}
                  >
                    {stateLabel(task.state)}
                  </span>
                  <Show when={task.threadId}>
                    <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                      Thread: {task.threadId}
                    </span>
                  </Show>
                </div>

                {/* Description */}
                <Show when={task.description}>
                  <p class="mb-2 text-xs whitespace-pre-wrap" style={{ color: 'var(--c-text-muted)' }}>
                    {task.description}
                  </p>
                </Show>

                {/* Transient state */}
                <Show when={task.transientState}>
                  <div
                    class="mb-2 rounded px-2 py-1 text-xs"
                    style={{ background: 'var(--c-bg-raised)', color: 'var(--c-text-muted)' }}
                  >
                    {task.transientState}
                  </div>
                </Show>

                {/* PR Provider details */}
                <Show when={task.provider && task.provider.kind === 'github-pr'}>
                  {(() => {
                    const prov = task.provider!
                    return (
                      <div
                        class="mb-2 rounded p-2 text-xs"
                        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
                      >
                        <div class="mb-1 flex items-center justify-between">
                          <span class="font-medium" style={{ color: 'var(--c-text)' }}>
                            PR #{prov.number}
                          </span>
                          <a
                            href={prov.url}
                            target="_blank"
                            rel="noopener"
                            class="flex items-center gap-1"
                            style={{ color: 'var(--c-accent)' }}
                          >
                            <ExternalLinkIcon class="h-3 w-3" />
                            GitHub
                          </a>
                        </div>
                        <div class="flex flex-wrap gap-2 text-[10px]">
                          <span>
                            Status:{' '}
                            <span style={{ color: prov.prStatus === 'open' ? '#22c55e' : 'var(--c-text-muted)' }}>
                              {prov.prStatus}
                            </span>
                          </span>
                          <span>
                            CI: <span style={{ color: checksColor(prov.checksStatus) }}>{prov.checksStatus}</span>
                          </span>
                          <span>
                            Review:{' '}
                            <span
                              style={{
                                color:
                                  prov.reviewDecision === 'approved'
                                    ? '#22c55e'
                                    : prov.reviewDecision === 'changes_requested'
                                      ? '#ef4444'
                                      : 'var(--c-text-muted)'
                              }}
                            >
                              {prov.reviewDecision}
                            </span>
                          </span>
                          <Show when={prov.unresolvedComments > 0}>
                            <span style={{ color: '#f59e0b' }}>
                              {prov.unresolvedComments} unresolved comment{prov.unresolvedComments > 1 ? 's' : ''}
                            </span>
                          </Show>
                        </div>
                        <div class="mt-1 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                          Last polled: {new Date(prov.lastPolledAt).toLocaleTimeString()}
                        </div>
                      </div>
                    )
                  })()}
                </Show>

                {/* Tags */}
                <Show when={task.tags.length > 0}>
                  <div class="mb-2 flex flex-wrap gap-1">
                    <For each={task.tags}>
                      {(tag) => (
                        <span
                          class="rounded px-1.5 py-0.5 text-[10px]"
                          style={{ background: 'var(--c-bg-raised)', color: 'var(--c-text-muted)' }}
                        >
                          {tag}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Parent/Child links */}
                <Show when={task.parentTasks.length > 0}>
                  <div class="mb-1 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    Parents:{' '}
                    <For each={task.parentTasks}>
                      {(ref, i) => (
                        <>
                          {i() > 0 ? ', ' : ''}
                          <span style={{ color: 'var(--c-text)' }}>{ref.name}</span>
                        </>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={task.childTasks.length > 0}>
                  <div class="mb-1 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    Children:{' '}
                    <For each={task.childTasks}>
                      {(ref, i) => (
                        <>
                          {i() > 0 ? ', ' : ''}
                          <span style={{ color: 'var(--c-text)' }}>{ref.name}</span>
                        </>
                      )}
                    </For>
                  </div>
                </Show>
              </>
            )
          }}
        </Show>
      </div>

      {/* Prompt input — only if task has a threadId */}
      <Show when={detail() && detail()!.threadId}>
        <div
          class="flex gap-1 px-3 py-2"
          style={{ 'border-top': '1px solid var(--c-border)', background: 'var(--c-bg-raised)' }}
        >
          <input
            class="flex-1 rounded px-2 py-1 text-xs"
            style={{
              background: 'var(--c-bg)',
              border: '1px solid var(--c-border)',
              color: 'var(--c-text)',
              outline: 'none'
            }}
            placeholder="Send prompt to thread..."
            value={promptText()}
            onInput={(e) => setPromptText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            disabled={sending()}
          />
          <button
            class="rounded px-2 py-1"
            style={{
              background: 'var(--c-accent)',
              border: 'none',
              color: '#fff',
              cursor: sending() ? 'wait' : 'pointer',
              opacity: sending() ? '0.6' : '1'
            }}
            onClick={handleSend}
            disabled={sending()}
          >
            <SendIcon class="h-3.5 w-3.5" />
          </button>
        </div>
        <Show when={sendError()}>
          <div class="px-3 py-1 text-[10px]" style={{ color: '#ef4444' }}>
            {sendError()}
          </div>
        </Show>
      </Show>
    </div>
  )
}

// ── Main Panel ──────────────────────────────────────────────────────────

const TasksPanel: Component = () => {
  const [tasks, { refetch }] = createResource(fetchTasks)
  const [selectedTaskId, setSelectedTaskId] = createSignal<string | null>(null)

  // Auto-refresh every 30 seconds
  const interval = setInterval(() => {
    if (!selectedTaskId()) refetch()
  }, 30_000)
  onCleanup(() => clearInterval(interval))

  const sortedTasks = () => {
    const list = tasks() ?? []
    const order: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 }
    return [...list].sort((a, b) => (order[a.state] ?? 99) - (order[b.state] ?? 99))
  }

  const activeCount = () => (tasks() ?? []).filter((t) => t.state === 'in_progress' || t.state === 'pending').length

  return (
    <div class="flex h-full flex-col">
      <Show
        when={!selectedTaskId()}
        fallback={<TaskDetailView taskId={selectedTaskId()!} onBack={() => setSelectedTaskId(null)} />}
      >
        {/* Header */}
        <div
          class="flex items-center justify-between px-3 py-2"
          style={{ 'border-bottom': '1px solid var(--c-border)' }}
        >
          <span class="text-xs font-medium" style={{ color: 'var(--c-text)' }}>
            Tasks
            <Show when={activeCount() > 0}>
              <span class="ml-1" style={{ color: 'var(--c-text-muted)' }}>
                ({activeCount()})
              </span>
            </Show>
          </span>
          <button
            style={{ color: 'var(--c-text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onClick={() => refetch()}
            title="Refresh"
          >
            <RefreshIcon class="h-3.5 w-3.5" />
          </button>
        </div>

        {/* List */}
        <div class="flex-1 overflow-auto">
          <Show
            when={!tasks.loading}
            fallback={
              <p class="p-3 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                Loading tasks...
              </p>
            }
          >
            <Show
              when={(tasks() ?? []).length > 0}
              fallback={
                <p class="p-3 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  No tasks yet. Use <code>task_create</code> or <code>task_import_pr</code> from an agent thread.
                </p>
              }
            >
              <For each={sortedTasks()}>{(task) => <TaskItem task={task} onSelect={setSelectedTaskId} />}</For>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default TasksPanel

// Cron Manager Modal — full CRUD management of OpenClaw cron jobs
import { createSignal, Show, For, onMount, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { CronJob, CronIssue } from './types.js'
import { ISSUE_LABELS, ISSUE_COLORS } from './types.js'

type Tab = 'thread' | 'issues' | 'all'

function formatSchedule(s: CronJob['schedule']): string {
  if (s.expr) return s.expr
  if (s.everyMs) {
    const mins = Math.round(s.everyMs / 60000)
    if (mins < 60) return `every ${mins}m`
    const hrs = Math.round(mins / 60)
    return `every ${hrs}h`
  }
  return s.kind
}

function formatNextRun(ms?: number): string {
  if (!ms) return ''
  const diff = ms - Date.now()
  if (diff < 0) return 'overdue'
  if (diff < 60000) return 'in <1m'
  if (diff < 3600000) return `in ${Math.round(diff / 60000)}m`
  return `in ${Math.round(diff / 3600000)}h`
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function CronManagerModal(props: { threadKey: string; onClose: () => void }) {
  const [crons, setCrons] = createSignal<CronJob[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal('')
  const [tab, setTab] = createSignal<Tab>('thread')
  const [actionLoading, setActionLoading] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)
  let backdropRef!: HTMLDivElement

  const fetchCrons = async () => {
    setLoading(true)
    setError('')
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      const res = await fetch('/api/crons', { signal: controller.signal })
      clearTimeout(timeout)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setCrons(data.crons ?? [])
    } catch (err: any) {
      setError(err.name === 'AbortError' ? 'Gateway timeout' : err.message)
    }
    setLoading(false)
  }

  onMount(() => {
    fetchCrons()
  })

  // Close on Escape
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose()
  }
  onMount(() => document.addEventListener('keydown', handleKeyDown))
  onCleanup(() => document.removeEventListener('keydown', handleKeyDown))

  const threadCrons = () => crons().filter((c) => c.threadKey === props.threadKey)
  const issueCrons = () => crons().filter((c) => c.issues.length > 0)
  const allCrons = () => crons()

  const totalIssueCount = () => issueCrons().length

  // Actions
  const handleToggle = async (id: string) => {
    setActionLoading(id)
    try {
      await fetch(`/api/crons/${encodeURIComponent(id)}/toggle`, { method: 'POST' })
      await fetchCrons()
    } catch {
      /* ignore */
    }
    setActionLoading(null)
  }

  const handleDelete = async (id: string) => {
    setActionLoading(id)
    try {
      await fetch(`/api/crons/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setConfirmDelete(null)
      await fetchCrons()
    } catch {
      /* ignore */
    }
    setActionLoading(null)
  }

  const handleFixToThread = async (id: string, targetThread?: string) => {
    setActionLoading(id)
    try {
      await fetch(`/api/crons/${encodeURIComponent(id)}/fix-thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadKey: targetThread || props.threadKey })
      })
      await fetchCrons()
    } catch {
      /* ignore */
    }
    setActionLoading(null)
  }

  const IssueBadge = (props: { issue: CronIssue }) => (
    <span
      style={{
        display: 'inline-block',
        'font-size': '10px',
        'font-weight': '600',
        padding: '1px 6px',
        'border-radius': '9999px',
        color: '#fff',
        background: ISSUE_COLORS[props.issue] || '#ef4444',
        'white-space': 'nowrap'
      }}
    >
      {ISSUE_LABELS[props.issue] || props.issue}
    </span>
  )

  const CronCard = (cardProps: { job: CronJob; showThread?: boolean }) => {
    const job = cardProps.job
    const isLoading = () => actionLoading() === job.id
    const isConfirmingDelete = () => confirmDelete() === job.id

    return (
      <div
        style={{
          padding: '10px 12px',
          'border-radius': '8px',
          background: 'var(--c-bg)',
          border: job.issues.length > 0 ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid var(--c-border)',
          opacity: isLoading() ? '0.6' : '1',
          transition: 'opacity 0.2s'
        }}
      >
        {/* Header row */}
        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'margin-bottom': '4px' }}>
          <span
            style={{
              width: '7px',
              height: '7px',
              'border-radius': '50%',
              background: job.enabled ? 'var(--c-success, #22c55e)' : 'var(--c-text-muted)',
              'flex-shrink': '0'
            }}
          />
          <span
            style={{
              flex: '1',
              'font-size': '12px',
              'font-weight': '600',
              color: 'var(--c-text)',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap'
            }}
          >
            {job.name || job.id}
          </span>
          <span style={{ 'font-size': '10px', color: 'var(--c-text-muted)', 'flex-shrink': '0' }}>
            {formatSchedule(job.schedule)}
          </span>
        </div>

        {/* Info row */}
        <div
          style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'flex-wrap': 'wrap', 'margin-bottom': '6px' }}
        >
          <Show when={cardProps.showThread && job.threadKey}>
            <span
              style={{
                'font-size': '10px',
                color: 'var(--c-text-muted)',
                background: 'var(--c-bg-raised)',
                padding: '1px 6px',
                'border-radius': '4px'
              }}
            >
              → {job.threadKey}
            </span>
          </Show>
          <Show when={job.state?.nextRunAtMs}>
            <span style={{ 'font-size': '10px', color: 'var(--c-text-muted)' }}>
              Next: {formatNextRun(job.state?.nextRunAtMs)}
            </span>
          </Show>
          <Show when={job.state?.lastStatus}>
            <span
              style={{
                'font-size': '10px',
                color: job.state?.lastStatus === 'error' ? 'var(--c-error, #ef4444)' : 'var(--c-text-muted)'
              }}
            >
              Last: {job.state?.lastStatus}
            </span>
          </Show>
        </div>

        {/* Issues */}
        <Show when={job.issues.length > 0}>
          <div style={{ display: 'flex', gap: '4px', 'flex-wrap': 'wrap', 'margin-bottom': '6px' }}>
            <For each={job.issues}>{(issue) => <IssueBadge issue={issue} />}</For>
          </div>
        </Show>

        {/* Message preview */}
        <Show when={job.payload?.message || job.payload?.text}>
          <div
            style={{
              'font-size': '11px',
              color: 'var(--c-text-muted)',
              'margin-bottom': '6px',
              'font-style': 'italic'
            }}
          >
            {truncate(job.payload?.message || job.payload?.text || '', 100)}
          </div>
        </Show>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
          {/* Fix button — shown when there are fixable issues */}
          <Show
            when={job.issues.some(
              (i) => i === 'missing-channel' || i === 'wrong-session-target' || i === 'system-event-on-thread'
            )}
          >
            <button
              style={{
                'font-size': '11px',
                padding: '3px 10px',
                'border-radius': '6px',
                border: 'none',
                background: 'var(--c-accent)',
                color: '#fff',
                cursor: 'pointer',
                'font-weight': '600'
              }}
              disabled={isLoading()}
              onClick={() => handleFixToThread(job.id)}
            >
              Fix to Thread
            </button>
            {/* If cron has a different thread, offer fix to original */}
            <Show when={job.threadKey && job.threadKey !== props.threadKey}>
              <button
                style={{
                  'font-size': '11px',
                  padding: '3px 10px',
                  'border-radius': '6px',
                  border: '1px solid var(--c-border)',
                  background: 'transparent',
                  color: 'var(--c-text)',
                  cursor: 'pointer'
                }}
                disabled={isLoading()}
                onClick={() => handleFixToThread(job.id, job.threadKey!)}
              >
                Fix to {truncate(job.threadKey!, 16)}
              </button>
            </Show>
          </Show>

          {/* Toggle */}
          <button
            style={{
              'font-size': '11px',
              padding: '3px 10px',
              'border-radius': '6px',
              border: '1px solid var(--c-border)',
              background: 'transparent',
              color: 'var(--c-text)',
              cursor: 'pointer'
            }}
            disabled={isLoading()}
            onClick={() => handleToggle(job.id)}
          >
            {job.enabled ? 'Disable' : 'Enable'}
          </button>

          {/* Delete */}
          <Show when={!isConfirmingDelete()}>
            <button
              style={{
                'font-size': '11px',
                padding: '3px 10px',
                'border-radius': '6px',
                border: '1px solid var(--c-border)',
                background: 'transparent',
                color: 'var(--c-error, #ef4444)',
                cursor: 'pointer'
              }}
              disabled={isLoading()}
              onClick={() => setConfirmDelete(job.id)}
            >
              Delete
            </button>
          </Show>
          <Show when={isConfirmingDelete()}>
            <button
              style={{
                'font-size': '11px',
                padding: '3px 10px',
                'border-radius': '6px',
                border: 'none',
                background: 'var(--c-error, #ef4444)',
                color: '#fff',
                cursor: 'pointer',
                'font-weight': '600'
              }}
              disabled={isLoading()}
              onClick={() => handleDelete(job.id)}
            >
              Confirm Delete
            </button>
            <button
              style={{
                'font-size': '11px',
                padding: '3px 8px',
                'border-radius': '6px',
                border: '1px solid var(--c-border)',
                background: 'transparent',
                color: 'var(--c-text-muted)',
                cursor: 'pointer'
              }}
              onClick={() => setConfirmDelete(null)}
            >
              Cancel
            </button>
          </Show>
        </div>
      </div>
    )
  }

  // Group all crons by thread for the "All" tab
  const groupedByThread = () => {
    const groups = new Map<string, CronJob[]>()
    for (const c of allCrons()) {
      const key = c.threadKey || '(orphaned)'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(c)
    }
    return Array.from(groups.entries()).sort((a, b) => {
      // Current thread first, then orphaned last
      if (a[0] === props.threadKey) return -1
      if (b[0] === props.threadKey) return 1
      if (a[0] === '(orphaned)') return 1
      if (b[0] === '(orphaned)') return -1
      return a[0].localeCompare(b[0])
    })
  }

  return (
    <Portal>
      <div
        ref={backdropRef}
        onClick={(e) => {
          if (e.target === backdropRef) props.onClose()
        }}
        style={{
          position: 'fixed',
          inset: '0',
          'z-index': '1000',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          background: 'rgba(0, 0, 0, 0.5)',
          'backdrop-filter': 'blur(2px)'
        }}
      >
        <div
          style={{
            width: '100%',
            'max-width': '600px',
            'max-height': '80vh',
            background: 'var(--c-bg-raised)',
            border: '1px solid var(--c-border)',
            'border-radius': '12px',
            display: 'flex',
            'flex-direction': 'column',
            overflow: 'hidden',
            'box-shadow': '0 25px 50px -12px rgba(0, 0, 0, 0.25)'
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              padding: '14px 16px',
              'border-bottom': '1px solid var(--c-border)'
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <span style={{ 'font-size': '14px', 'font-weight': '600', color: 'var(--c-text)' }}>Cron Manager</span>
              <Show when={totalIssueCount() > 0}>
                <span
                  style={{
                    'font-size': '10px',
                    'font-weight': '600',
                    padding: '1px 6px',
                    'border-radius': '9999px',
                    color: '#fff',
                    background: '#ef4444'
                  }}
                >
                  {totalIssueCount()} issue{totalIssueCount() !== 1 ? 's' : ''}
                </span>
              </Show>
            </div>
            <button
              onClick={props.onClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--c-text-muted)',
                cursor: 'pointer',
                'font-size': '16px',
                padding: '2px 6px',
                'border-radius': '4px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              ✕
            </button>
          </div>

          {/* Summary bar */}
          <div
            style={{
              display: 'flex',
              gap: '12px',
              padding: '8px 16px',
              'font-size': '11px',
              color: 'var(--c-text-muted)',
              'border-bottom': '1px solid var(--c-border)',
              background: 'var(--c-bg)'
            }}
          >
            <span>{threadCrons().length} this thread</span>
            <span style={{ color: totalIssueCount() > 0 ? '#ef4444' : 'inherit' }}>
              {totalIssueCount()} with issues
            </span>
            <span>{allCrons().length} total</span>
          </div>

          {/* Tabs */}
          <div
            style={{
              display: 'flex',
              'border-bottom': '1px solid var(--c-border)',
              background: 'var(--c-bg)'
            }}
          >
            {(['thread', 'issues', 'all'] as Tab[]).map((t) => {
              const labels: Record<Tab, string> = {
                thread: 'This Thread',
                issues: 'Issues',
                all: 'All'
              }
              const counts: Record<Tab, () => number> = {
                thread: () => threadCrons().length,
                issues: () => issueCrons().length,
                all: () => allCrons().length
              }
              return (
                <button
                  onClick={() => setTab(t)}
                  style={{
                    flex: '1',
                    padding: '8px 0',
                    'font-size': '12px',
                    'font-weight': tab() === t ? '600' : '400',
                    color: tab() === t ? 'var(--c-accent)' : 'var(--c-text-muted)',
                    background: 'none',
                    border: 'none',
                    'border-bottom': tab() === t ? '2px solid var(--c-accent)' : '2px solid transparent',
                    cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}
                >
                  {labels[t]}
                  <Show when={t === 'issues' && totalIssueCount() > 0}>
                    <span style={{ 'margin-left': '4px', color: '#ef4444' }}>({counts[t]()})</span>
                  </Show>
                  <Show when={t !== 'issues'}>
                    <span style={{ 'margin-left': '4px', opacity: '0.6' }}>({counts[t]()})</span>
                  </Show>
                </button>
              )
            })}
          </div>

          {/* Content */}
          <div style={{ 'overflow-y': 'auto', padding: '12px 16px', flex: '1' }}>
            <Show when={loading()}>
              <div
                style={{ 'text-align': 'center', padding: '20px 0', color: 'var(--c-text-muted)', 'font-size': '12px' }}
              >
                Loading cron jobs…
              </div>
            </Show>

            <Show when={error()}>
              <div
                style={{
                  'text-align': 'center',
                  padding: '20px 0',
                  color: 'var(--c-error, #ef4444)',
                  'font-size': '12px'
                }}
              >
                {error()}
              </div>
            </Show>

            <Show when={!loading() && !error()}>
              {/* This Thread tab */}
              <Show when={tab() === 'thread'}>
                <Show when={threadCrons().length === 0}>
                  <div
                    style={{
                      'text-align': 'center',
                      padding: '20px 0',
                      color: 'var(--c-text-muted)',
                      'font-size': '12px'
                    }}
                  >
                    No cron jobs for this thread
                  </div>
                </Show>
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  <For each={threadCrons()}>{(job) => <CronCard job={job} />}</For>
                </div>
              </Show>

              {/* Issues tab */}
              <Show when={tab() === 'issues'}>
                <Show when={issueCrons().length === 0}>
                  <div
                    style={{
                      'text-align': 'center',
                      padding: '20px 0',
                      color: 'var(--c-text-muted)',
                      'font-size': '12px'
                    }}
                  >
                    All crons look healthy ✓
                  </div>
                </Show>
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  <For each={issueCrons()}>{(job) => <CronCard job={job} showThread />}</For>
                </div>
              </Show>

              {/* All tab */}
              <Show when={tab() === 'all'}>
                <Show when={allCrons().length === 0}>
                  <div
                    style={{
                      'text-align': 'center',
                      padding: '20px 0',
                      color: 'var(--c-text-muted)',
                      'font-size': '12px'
                    }}
                  >
                    No cron jobs found
                  </div>
                </Show>
                <For each={groupedByThread()}>
                  {([groupKey, groupJobs]) => (
                    <div style={{ 'margin-bottom': '12px' }}>
                      <div
                        style={{
                          'font-size': '11px',
                          'font-weight': '600',
                          color: 'var(--c-text-muted)',
                          'text-transform': 'uppercase',
                          'letter-spacing': '0.05em',
                          'margin-bottom': '6px',
                          display: 'flex',
                          'align-items': 'center',
                          gap: '6px'
                        }}
                      >
                        {groupKey === props.threadKey ? `${groupKey} (current)` : groupKey}
                        <span style={{ 'font-weight': '400', 'text-transform': 'none', 'letter-spacing': 'normal' }}>
                          ({groupJobs.length})
                        </span>
                      </div>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                        <For each={groupJobs}>{(job) => <CronCard job={job} showThread />}</For>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  )
}

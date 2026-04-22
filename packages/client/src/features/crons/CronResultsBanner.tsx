// Cron Results Banner — shows recent cron run outcomes for the current thread
import { createSignal, createEffect, onMount, Show, For } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'
import { threadKey } from '../threads/store.js'

export interface CronRunResult {
  jobId: string
  jobName: string
  status: string
  error?: string
  summary?: string
  durationMs?: number
  timestamp: number
  threadKey: string | null
}

const [cronRuns, setCronRuns] = createSignal<CronRunResult[]>([])
const [channelStatus, setChannelStatus] = createSignal<{
  hasRealChannels: boolean
  warning: string | null
} | null>(null)

// Max number of runs to show
const MAX_RUNS = 5

/** Initialize cron results store — call once from app init */
export function initCronResultsStore(ws?: WsStore): () => void {
  const unsubs: Array<() => void> = []

  if (ws) {
    // Listen for real-time cron run events
    unsubs.push(
      ws.on('cron.run.completed', (msg: any) => {
        const run: CronRunResult = {
          jobId: msg.jobId,
          jobName: msg.jobName || msg.jobId,
          status: msg.status,
          error: msg.error,
          summary: msg.summary,
          durationMs: msg.durationMs,
          timestamp: msg.timestamp || Date.now(),
          threadKey: msg.threadKey
        }
        setCronRuns((prev) => {
          const updated = [run, ...prev]
          // Keep only the latest runs
          return updated.slice(0, 50) // store more, display fewer
        })
      })
    )
  }

  return () => {
    unsubs.forEach((u) => u())
  }
}

/** Fetch cron run history for a thread from the server */
async function fetchRunsForThread(tk: string): Promise<void> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`/api/crons/runs?threadKey=${encodeURIComponent(tk)}&limit=10`, {
      signal: controller.signal
    })
    clearTimeout(timeout)
    if (!res.ok) return
    const data = await res.json()
    const entries = (data.entries ?? []).map((e: any) => ({
      jobId: e.jobId,
      jobName: e.jobName || e.jobId,
      status: e.status,
      error: e.error,
      summary: e.summary,
      durationMs: e.durationMs,
      timestamp: e.ts || e.timestamp || 0,
      threadKey: tk
    }))
    // Merge with existing WS-received runs (dedup by jobId+timestamp)
    setCronRuns((prev) => {
      const existing = new Set(prev.map((r) => `${r.jobId}-${r.timestamp}`))
      const newRuns = entries.filter((e: CronRunResult) => !existing.has(`${e.jobId}-${e.timestamp}`))
      return [...newRuns, ...prev].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50)
    })
  } catch {
    // Non-fatal
  }
}

/** Fetch channel status (are real channels configured?) */
async function fetchChannelStatus(): Promise<void> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch('/api/crons/channel-status', { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return
    const data = await res.json()
    setChannelStatus(data)
  } catch {
    // Non-fatal
  }
}

function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = Date.now()
  const diffMs = now - ts

  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3600_000) return `${Math.round(diffMs / 60_000)}m ago`
  if (diffMs < 86400_000) return `${Math.round(diffMs / 3600_000)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatDuration(ms?: number): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** Banner showing delivery channel warning */
export function ChannelWarningBanner() {
  onMount(() => {
    fetchChannelStatus()
  })

  return (
    <Show when={channelStatus() && !channelStatus()!.hasRealChannels && channelStatus()!.warning}>
      <div
        style={{
          padding: '8px 12px',
          margin: '0 0 8px 0',
          'border-radius': '8px',
          background: 'rgba(249, 115, 22, 0.1)',
          border: '1px solid rgba(249, 115, 22, 0.3)',
          display: 'flex',
          'align-items': 'flex-start',
          gap: '8px'
        }}
      >
        <span style={{ 'font-size': '14px', 'flex-shrink': '0', 'margin-top': '1px' }}>⚠️</span>
        <div>
          <div
            style={{
              'font-size': '12px',
              'font-weight': '600',
              color: 'var(--c-warning, #f97316)',
              'margin-bottom': '2px'
            }}
          >
            No Delivery Channels
          </div>
          <div style={{ 'font-size': '11px', color: 'var(--c-text-muted)', 'line-height': '1.4' }}>
            {channelStatus()!.warning}
          </div>
        </div>
      </div>
    </Show>
  )
}

/** Inline banner showing recent cron run results for the current thread */
export function CronResultsBanner() {
  const [expanded, setExpanded] = createSignal(false)

  // Fetch runs when thread changes
  createEffect(() => {
    const tk = threadKey()
    if (tk) {
      fetchRunsForThread(tk)
    }
  })

  const threadRuns = () => {
    const tk = threadKey()
    if (!tk) return []
    return cronRuns()
      .filter((r) => r.threadKey === tk)
      .slice(0, MAX_RUNS)
  }

  const hasErrors = () => threadRuns().some((r) => r.status === 'error' || r.status === 'failed')

  return (
    <Show when={threadRuns().length > 0}>
      <div
        style={{
          margin: '0 0 8px 0',
          'border-radius': '8px',
          background: hasErrors() ? 'rgba(239, 68, 68, 0.05)' : 'rgba(34, 197, 94, 0.05)',
          border: hasErrors() ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid rgba(34, 197, 94, 0.2)',
          overflow: 'hidden'
        }}
      >
        {/* Header — click to expand */}
        <button
          onClick={() => setExpanded(!expanded())}
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            width: '100%',
            padding: '6px 10px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--c-text-muted)',
            'font-size': '11px'
          }}
        >
          <span style={{ 'font-size': '12px' }}>⏱</span>
          <span style={{ flex: '1', 'text-align': 'left' }}>
            Cron Results ({threadRuns().length})
            <Show when={hasErrors()}>
              <span style={{ color: 'var(--c-error, #ef4444)', 'margin-left': '4px', 'font-weight': '600' }}>
                — has failures
              </span>
            </Show>
          </span>
          <span
            style={{
              transform: expanded() ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s'
            }}
          >
            ▶
          </span>
        </button>

        {/* Expanded details */}
        <Show when={expanded()}>
          <div
            style={{
              padding: '0 10px 8px 10px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '4px'
            }}
          >
            <For each={threadRuns()}>{(run) => <CronRunRow run={run} />}</For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function CronRunRow(props: { run: CronRunResult }) {
  const [showDetail, setShowDetail] = createSignal(false)
  const isError = () => props.run.status === 'error' || props.run.status === 'failed'

  return (
    <div>
      <div
        onClick={() => setShowDetail(!showDetail())}
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '6px',
          padding: '4px 6px',
          'border-radius': '6px',
          background: 'var(--c-bg)',
          cursor: 'pointer',
          'font-size': '11px'
        }}
      >
        <span style={{ 'font-size': '12px', 'flex-shrink': '0' }}>{isError() ? '✗' : '✓'}</span>
        <span
          style={{
            flex: '1',
            color: isError() ? 'var(--c-error, #ef4444)' : 'var(--c-text)',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap'
          }}
        >
          {props.run.jobName}
        </span>
        <Show when={props.run.durationMs}>
          <span style={{ color: 'var(--c-text-muted)', 'font-size': '10px', 'flex-shrink': '0' }}>
            {formatDuration(props.run.durationMs)}
          </span>
        </Show>
        <span style={{ color: 'var(--c-text-muted)', 'font-size': '10px', 'flex-shrink': '0' }}>
          {formatTime(props.run.timestamp)}
        </span>
      </div>

      {/* Detail panel */}
      <Show when={showDetail() && (props.run.summary || props.run.error)}>
        <div
          style={{
            padding: '4px 8px',
            margin: '2px 0 2px 18px',
            'font-size': '10px',
            color: isError() ? 'var(--c-error, #ef4444)' : 'var(--c-text-muted)',
            'line-height': '1.4',
            background: 'var(--c-bg-raised)',
            'border-radius': '4px',
            'white-space': 'pre-wrap',
            'word-break': 'break-word',
            'max-height': '120px',
            'overflow-y': 'auto'
          }}
        >
          {isError() && props.run.error
            ? truncate(props.run.error, 500)
            : props.run.summary
              ? truncate(props.run.summary, 500)
              : ''}
        </div>
      </Show>
    </div>
  )
}

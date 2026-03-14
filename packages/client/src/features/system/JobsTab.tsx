// §6.7 Jobs Tab — Scheduled jobs list
// Name, schedule, last run time+status, next run. Actions: trigger now, enable/disable, view history.

import { createSignal, onMount, Show, For, type Component } from 'solid-js'

export interface Job {
  id: string
  name: string
  schedule: string // cron expression or interval
  enabled: boolean
  lastRun: { time: string; status: 'success' | 'failure' | 'running' } | null
  nextRun: string | null
}

export interface JobHistoryEntry {
  time: string
  status: 'success' | 'failure'
  duration: number // ms
}

export function getJobStatusClass(status: string): string {
  switch (status) {
    case 'success':
      return 'text-green-400'
    case 'failure':
      return 'text-red-400'
    case 'running':
      return 'text-blue-400'
    default:
      return 'opacity-50'
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export async function fetchJobs(): Promise<Job[]> {
  const res = await fetch('/api/jobs')
  if (!res.ok) throw new Error(`Failed to fetch jobs: ${res.status}`)
  return res.json()
}

export async function triggerJob(jobId: string): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}/trigger`, { method: 'POST' })
  if (!res.ok) throw new Error(`Failed to trigger job: ${res.status}`)
}

export async function toggleJob(jobId: string, enabled: boolean): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  })
  if (!res.ok) throw new Error(`Failed to update job: ${res.status}`)
}

export async function fetchJobHistory(jobId: string): Promise<JobHistoryEntry[]> {
  const res = await fetch(`/api/jobs/${jobId}/history`)
  if (!res.ok) throw new Error(`Failed to fetch job history: ${res.status}`)
  return res.json()
}

const JobsTab: Component = () => {
  const [jobs, setJobs] = createSignal<Job[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [expandedJob, setExpandedJob] = createSignal<string | null>(null)
  const [history, setHistory] = createSignal<JobHistoryEntry[]>([])

  const load = async () => {
    try {
      const data = await fetchJobs()
      setJobs(data)
      setError(null)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    }
  }

  onMount(load)

  const handleTrigger = async (jobId: string) => {
    try {
      await triggerJob(jobId)
      await load()
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleToggle = async (job: Job) => {
    try {
      await toggleJob(job.id, !job.enabled)
      await load()
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleViewHistory = async (jobId: string) => {
    if (expandedJob() === jobId) {
      setExpandedJob(null)
      return
    }
    try {
      const hist = await fetchJobHistory(jobId)
      setHistory(hist)
      setExpandedJob(jobId)
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div class="space-y-4">
      {error() && <div class="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error()}</div>}

      {jobs().length === 0 && !error() && <div class="text-sm opacity-50">No scheduled jobs</div>}

      <For each={jobs()}>
        {(job) => (
          <div
            class="rounded-lg border"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
          >
            <div class="flex items-center gap-3 p-4">
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class={`text-sm font-medium ${!job.enabled ? "line-through opacity-50" : ''}`}>{job.name}</span>
                  <span class="rounded bg-gray-500/20 px-1.5 py-0.5 font-mono text-xs opacity-60">{job.schedule}</span>
                </div>

                <div class="mt-1 flex gap-4 text-xs opacity-60">
                  <Show when={job.lastRun} fallback={<span>Never run</span>}>
                    {(last) => (
                      <span>
                        Last: {new Date(last().time).toLocaleString()}{' '}
                        <span class={getJobStatusClass(last().status)}>{last().status}</span>
                      </span>
                    )}
                  </Show>
                  <Show when={job.nextRun}>{(next) => <span>Next: {new Date(next()).toLocaleString()}</span>}</Show>
                </div>
              </div>

              {/* Actions */}
              <div class="flex gap-2">
                <button
                  class="rounded border px-2 py-1 text-xs hover:opacity-80"
                  style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
                  onClick={() => handleTrigger(job.id)}
                  title="Trigger now"
                >
                  ▶ Run
                </button>
                <button
                  class="rounded border px-2 py-1 text-xs hover:opacity-80"
                  style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
                  onClick={() => handleToggle(job)}
                  title={job.enabled ? 'Disable' : 'Enable'}
                >
                  {job.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  class="rounded border px-2 py-1 text-xs hover:opacity-80"
                  style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
                  onClick={() => handleViewHistory(job.id)}
                  title="View history"
                >
                  History
                </button>
              </div>
            </div>

            {/* Expanded history */}
            <Show when={expandedJob() === job.id && history().length > 0}>
              <div class="border-t px-4 py-2" style={{ 'border-color': 'var(--c-border)' }}>
                <For each={history()}>
                  {(entry) => (
                    <div class="flex gap-3 py-1 text-xs">
                      <span class="opacity-50">{new Date(entry.time).toLocaleString()}</span>
                      <span class={getJobStatusClass(entry.status)}>{entry.status}</span>
                      <span class="opacity-40">{formatDuration(entry.duration)}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}

export default JobsTab

import { Show, createSignal, createEffect, on } from 'solid-js'
import type { Component } from 'solid-js'
import { activeWorkspace } from '../store.js'

export interface PlanningCompletion {
  total: number
  completed: number
  ready: number
  blocked: number
  active: number
  completionPct: number
}

export function buildPlanningUrl(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/planning/completion`
}

const PlanningPanel: Component = () => {
  const ws = () => activeWorkspace()
  const [completion, setCompletion] = createSignal<PlanningCompletion | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [syncing, setSyncing] = createSignal(false)
  const [syncResult, setSyncResult] = createSignal<string | null>(null)

  async function fetchCompletion(orgId: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(buildPlanningUrl(orgId))
      if (!res.ok) {
        setCompletion(null)
        return
      }
      const data = await res.json()
      setCompletion(data)
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
        await fetchCompletion(orgId)
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
        if (orgId) fetchCompletion(orgId)
        else {
          setCompletion(null)
          setError(null)
          setSyncResult(null)
        }
      }
    )
  )

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
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Planning
        </span>
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
              const c = completion()!
              return (
                <div class="flex flex-col gap-3">
                  <div class="flex items-center gap-2">
                    <div
                      class="h-1.5 flex-1 overflow-hidden rounded-full"
                      style={{ background: 'var(--c-bg-tertiary)' }}
                    >
                      <div
                        class="h-full rounded-full transition-all"
                        style={{ width: `${c.completionPct}%`, background: 'var(--c-accent)' }}
                      />
                    </div>
                    <span class="text-xs tabular-nums" style={{ color: 'var(--c-text-muted)' }}>
                      {c.completionPct}%
                    </span>
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <StatCard label="Total" value={c.total} color="var(--c-text)" />
                    <StatCard label="Ready" value={c.ready} color="var(--c-success)" />
                    <StatCard label="Active" value={c.active} color="var(--c-accent)" />
                    <StatCard label="Blocked" value={c.blocked} color="var(--c-error)" />
                  </div>
                  <button
                    class="mt-1 rounded px-2 py-1 text-xs transition-colors"
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
                </div>
              )
            })()}
          </Show>
        </Show>
      </div>
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

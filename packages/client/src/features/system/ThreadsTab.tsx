// §6.9 Threads Tab — View all threads, assign orphans to workspaces
import { createSignal, onMount, For, Show, type Component } from 'solid-js'
import type { ThreadInfo } from '../threads/store.js'
import { fetchThreadsForOrg } from '../threads/store.js'

interface OrgInfo {
  orgId: string
  name: string
}

const ThreadsTab: Component = () => {
  const [allThreads, setAllThreads] = createSignal<ThreadInfo[]>([])
  const [orgs, setOrgs] = createSignal<OrgInfo[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [moving, setMoving] = createSignal<string | null>(null) // threadKey being moved

  const load = async () => {
    try {
      const [threadsRes, orgsRes] = await Promise.all([fetch('/api/threads'), fetch('/api/orgs')])
      if (!threadsRes.ok) throw new Error(`Threads: HTTP ${threadsRes.status}`)
      if (!orgsRes.ok) throw new Error(`Orgs: HTTP ${orgsRes.status}`)
      const threadsData = await threadsRes.json()
      const orgsData = await orgsRes.json()
      setAllThreads((threadsData.threads ?? threadsData ?? []).filter((t: any) => t.key))
      setOrgs(
        (orgsData.orgs ?? orgsData ?? []).map((o: any) => ({
          orgId: o.orgId ?? o.id,
          name: o.name ?? o.orgId ?? o.id
        }))
      )
      setError(null)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    }
  }

  onMount(load)

  const orphanThreads = () => allThreads().filter((t) => !t.orgId || t.orgId === '_global')
  const assignedThreads = () => allThreads().filter((t) => t.orgId && t.orgId !== '_global')

  const orgName = (orgId: string) => {
    if (!orgId || orgId === '_global') return 'Global'
    const org = orgs().find((o) => o.orgId === orgId)
    return org?.name ?? orgId
  }

  const assignThread = async (key: string, orgId: string) => {
    setMoving(key)
    try {
      const res = await fetch(`/api/threads/${key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Refresh
      await load()
      // Also refresh thread store so other views pick up the change
      fetchThreadsForOrg()
    } catch (e: any) {
      setError(e.message ?? 'Failed to assign')
    } finally {
      setMoving(null)
    }
  }

  const threadLabel = (t: ThreadInfo) => t.label || t.key
  const lastActive = (t: ThreadInfo) => {
    if (!t.lastActivity) return ''
    const d = new Date(t.lastActivity)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div class="space-y-6">
      <h2 class="text-lg font-bold" style={{ color: 'var(--c-text)' }}>
        Thread Management
      </h2>

      <Show when={error()}>
        <div
          class="rounded px-3 py-2 text-sm"
          style={{ background: 'var(--c-error-bg, #7f1d1d)', color: 'var(--c-error, #fca5a5)' }}
        >
          {error()}
        </div>
      </Show>

      {/* Orphan Threads */}
      <div>
        <h3 class="mb-2 text-sm font-semibold" style={{ color: 'var(--c-text-muted)' }}>
          Unassigned Threads ({orphanThreads().length})
        </h3>
        <Show
          when={orphanThreads().length > 0}
          fallback={
            <p class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
              No unassigned threads — all threads are linked to a workspace.
            </p>
          }
        >
          <div class="space-y-2">
            <For each={orphanThreads()}>
              {(t) => (
                <div
                  class="flex items-center justify-between rounded px-3 py-2"
                  style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)' }}
                >
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium" style={{ color: 'var(--c-text)' }}>
                      {threadLabel(t)}
                    </div>
                    <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      {lastActive(t)}
                    </div>
                  </div>
                  <div class="ml-3 flex items-center gap-2">
                    <Show when={moving() === t.key}>
                      <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                        Moving…
                      </span>
                    </Show>
                    <select
                      class="rounded border px-2 py-1 text-xs"
                      style={{
                        background: 'var(--c-bg)',
                        color: 'var(--c-text)',
                        'border-color': 'var(--c-border)'
                      }}
                      disabled={moving() === t.key}
                      onChange={(e) => {
                        const orgId = e.currentTarget.value
                        if (orgId) {
                          assignThread(t.key, orgId)
                          e.currentTarget.value = ''
                        }
                      }}
                    >
                      <option value="">Assign to…</option>
                      <For each={orgs().filter((o) => o.orgId !== '_global')}>
                        {(org) => <option value={org.orgId}>{org.name}</option>}
                      </For>
                    </select>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* Assigned Threads */}
      <div>
        <h3 class="mb-2 text-sm font-semibold" style={{ color: 'var(--c-text-muted)' }}>
          Assigned Threads ({assignedThreads().length})
        </h3>
        <Show
          when={assignedThreads().length > 0}
          fallback={
            <p class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
              No assigned threads.
            </p>
          }
        >
          <div class="space-y-2">
            <For each={assignedThreads()}>
              {(t) => (
                <div
                  class="flex items-center justify-between rounded px-3 py-2"
                  style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)' }}
                >
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium" style={{ color: 'var(--c-text)' }}>
                      {threadLabel(t)}
                    </div>
                    <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      {orgName(t.orgId!)} · {lastActive(t)}
                    </div>
                  </div>
                  <div class="ml-3">
                    <select
                      class="rounded border px-2 py-1 text-xs"
                      style={{
                        background: 'var(--c-bg)',
                        color: 'var(--c-text)',
                        'border-color': 'var(--c-border)'
                      }}
                      disabled={moving() === t.key}
                      onChange={(e) => {
                        const orgId = e.currentTarget.value
                        if (orgId) {
                          assignThread(t.key, orgId === '_global' ? '_global' : orgId)
                          e.currentTarget.value = ''
                        }
                      }}
                    >
                      <option value="">Move to…</option>
                      <option value="_global">Global (unassign)</option>
                      <For each={orgs().filter((o) => o.orgId !== '_global' && o.orgId !== t.orgId)}>
                        {(org) => <option value={org.orgId}>{org.name}</option>}
                      </For>
                    </select>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default ThreadsTab

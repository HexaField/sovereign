import type { Component } from 'solid-js'
import { Show, For, createSignal, createEffect, onCleanup } from 'solid-js'
import { activeWorkspace } from '../store.js'

export interface GitStatusData {
  branch: string
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

export function buildGitStatusUrl(projectId: string): string {
  return `/api/git/status?project=${encodeURIComponent(projectId)}`
}

const fetchGitStatus = async (orgId: string, projectId: string): Promise<GitStatusData | null> => {
  const res = await fetch(
    `/api/git/status?orgId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projectId)}`
  )
  if (!res.ok) return null
  const data = await res.json()
  return {
    branch: data.branch ?? 'unknown',
    ahead: data.ahead ?? 0,
    behind: data.behind ?? 0,
    staged: (data.staged ?? []).map((f: any) => (typeof f === 'string' ? f : f.path)),
    unstaged: (data.modified ?? data.unstaged ?? []).map((f: any) => (typeof f === 'string' ? f : f.path)),
    untracked: (data.untracked ?? []).map((f: any) => (typeof f === 'string' ? f : f.path))
  }
}

const GitPanel: Component = () => {
  const ws = () => activeWorkspace()
  const [status, setStatus] = createSignal<GitStatusData | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)

  createEffect(() => {
    const orgId = ws()?.orgId
    const projectId = ws()?.activeProjectId
    if (!orgId || !projectId) {
      setStatus(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(false)
    // Use void to fire-and-forget the async work
    void (async () => {
      try {
        const res = await fetch(
          `/api/git/status?orgId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projectId)}`
        )
        if (!res.ok) {
          setError(true)
          setLoading(false)
          return
        }
        const data = await res.json()
        setStatus({
          branch: data.branch ?? 'unknown',
          ahead: data.ahead ?? 0,
          behind: data.behind ?? 0,
          staged: (data.staged ?? []).map((f: any) => (typeof f === 'string' ? f : f.path)),
          unstaged: (data.modified ?? data.unstaged ?? []).map((f: any) => (typeof f === 'string' ? f : f.path)),
          untracked: (data.untracked ?? []).map((f: any) => (typeof f === 'string' ? f : f.path))
        })
        setLoading(false)
      } catch {
        setError(true)
        setLoading(false)
      }
    })()
  })

  return (
    <div class="flex h-full flex-col">
      <div class="border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Git
        </span>
      </div>
      <div class="flex-1 overflow-auto p-2">
        <Show
          when={ws()?.activeProjectId}
          fallback={
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              No project selected
            </p>
          }
        >
          <Show
            when={!loading()}
            fallback={
              <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                Loading...
              </p>
            }
          >
            <Show
              when={status()}
              fallback={
                <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  Could not load git status
                </p>
              }
            >
              {(s) => (
                <div class="space-y-2">
                  <div class="text-xs" style={{ color: 'var(--c-text-heading)' }}>
                    Branch: <strong>{s().branch}</strong>
                    <Show when={s().ahead > 0}>
                      <span class="ml-1" style={{ color: 'var(--c-accent)' }}>
                        ↑{s().ahead}
                      </span>
                    </Show>
                    <Show when={s().behind > 0}>
                      <span class="ml-1" style={{ color: 'var(--c-warning, #f59e0b)' }}>
                        ↓{s().behind}
                      </span>
                    </Show>
                  </div>
                  <Show when={s().staged.length > 0}>
                    <div>
                      <div class="text-xs font-medium" style={{ color: 'var(--c-success, #22c55e)' }}>
                        Staged
                      </div>
                      <For each={s().staged}>
                        {(f) => (
                          <div class="truncate pl-2 text-xs" style={{ color: 'var(--c-text)' }}>
                            {f}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={s().unstaged.length > 0}>
                    <div>
                      <div class="text-xs font-medium" style={{ color: 'var(--c-warning, #f59e0b)' }}>
                        Modified
                      </div>
                      <For each={s().unstaged}>
                        {(f) => (
                          <div class="truncate pl-2 text-xs" style={{ color: 'var(--c-text)' }}>
                            {f}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={s().untracked.length > 0}>
                    <div>
                      <div class="text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
                        Untracked
                      </div>
                      <For each={s().untracked}>
                        {(f) => (
                          <div class="truncate pl-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                            {f}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={s().staged.length === 0 && s().unstaged.length === 0 && s().untracked.length === 0}>
                    <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      Working tree clean
                    </p>
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

import { type Component, createSignal, createResource, Show } from 'solid-js'
import type { GitStatus } from './types.js'
import ChangesList from './ChangesList.js'
import CommitForm from './CommitForm.js'
import BranchSelector from './BranchSelector.js'
import CommitLog from './CommitLog.js'

interface GitPanelProps {
  orgId?: string
  projectId?: string
}

const GitPanel: Component<GitPanelProps> = (props) => {
  const [view, setView] = createSignal<'changes' | 'log'>('changes')

  const [status, { refetch }] = createResource(
    () => ({ orgId: props.orgId, projectId: props.projectId }),
    async (params) => {
      if (!params.orgId || !params.projectId) return null
      try {
        const res = await fetch(`/api/git/status?org=${params.orgId}&project=${params.projectId}`)
        if (!res.ok) return null
        return res.json() as Promise<GitStatus>
      } catch {
        return null
      }
    }
  )

  const doStage = async (path: string) => {
    await fetch('/api/git/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: props.orgId, projectId: props.projectId, paths: [path] })
    })
    void refetch()
  }

  const doUnstage = async (path: string) => {
    await fetch('/api/git/unstage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: props.orgId, projectId: props.projectId, paths: [path] })
    })
    void refetch()
  }

  const doStageAll = async () => {
    const all = [...(status()?.modified.map((f) => f.path) ?? []), ...(status()?.untracked ?? [])]
    await fetch('/api/git/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: props.orgId, projectId: props.projectId, paths: all })
    })
    void refetch()
  }

  const doUnstageAll = async () => {
    const all = status()?.staged.map((f) => f.path) ?? []
    await fetch('/api/git/unstage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: props.orgId, projectId: props.projectId, paths: all })
    })
    void refetch()
  }

  const doCommit = async (message: string) => {
    await fetch('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: props.orgId, projectId: props.projectId, message })
    })
    void refetch()
  }

  const doSwitchBranch = async (branch: string) => {
    await fetch('/api/git/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: props.orgId, projectId: props.projectId, branch })
    })
    void refetch()
  }

  const doCreateBranch = async (branch: string) => {
    await fetch('/api/git/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: props.orgId, projectId: props.projectId, branch, create: true })
    })
    void refetch()
  }

  return (
    <div class="flex h-full flex-col text-xs">
      <Show when={status()}>
        {(st) => (
          <>
            <BranchSelector
              currentBranch={st().branch}
              orgId={props.orgId}
              projectId={props.projectId}
              onSwitch={doSwitchBranch}
              onCreate={doCreateBranch}
            />

            {/* View toggle */}
            <div class="flex border-b border-zinc-700">
              <button
                class={`flex-1 px-2 py-1 ${view() === 'changes' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50"}`}
                onClick={() => setView('changes')}
              >
                Changes
              </button>
              <button
                class={`flex-1 px-2 py-1 ${view() === 'log' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50"}`}
                onClick={() => setView('log')}
              >
                Log
              </button>
            </div>

            <Show when={view() === 'changes'}>
              <div class="flex-1 overflow-y-auto">
                <ChangesList
                  staged={st().staged}
                  modified={st().modified}
                  untracked={st().untracked}
                  onStage={doStage}
                  onUnstage={doUnstage}
                  onStageAll={doStageAll}
                  onUnstageAll={doUnstageAll}
                  onFileClick={() => {}}
                />
              </div>
              <CommitForm onCommit={doCommit} disabled={st().staged.length === 0} />
            </Show>

            <Show when={view() === 'log'}>
              <div class="flex-1 overflow-y-auto">
                <CommitLog orgId={props.orgId} projectId={props.projectId} />
              </div>
            </Show>
          </>
        )}
      </Show>

      <Show when={!status() && !status.loading}>
        <div class="flex flex-1 items-center justify-center text-zinc-500">No project selected</div>
      </Show>
    </div>
  )
}

export default GitPanel

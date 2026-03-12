import { type Component, createResource, For, Show } from 'solid-js'
import type { CommitInfo } from './types.js'

interface CommitLogProps {
  orgId?: string
  projectId?: string
}

const CommitLog: Component<CommitLogProps> = (props) => {
  const [commits] = createResource(
    () => ({ orgId: props.orgId, projectId: props.projectId }),
    async (params) => {
      if (!params.orgId || !params.projectId) return []
      try {
        const res = await fetch(`/api/git/log?org=${params.orgId}&project=${params.projectId}&limit=50`)
        if (!res.ok) return []
        return res.json() as Promise<CommitInfo[]>
      } catch {
        return []
      }
    }
  )

  return (
    <div class="overflow-y-auto text-xs">
      <For each={commits() ?? []}>
        {(commit) => (
          <div class="border-b border-zinc-800 px-2 py-1.5">
            <div class="flex items-center gap-2">
              <span class="font-mono text-blue-400">{commit.shortHash}</span>
              <Show when={commit.refs && commit.refs.length > 0}>
                <For each={commit.refs}>
                  {(ref) => <span class="rounded bg-zinc-700 px-1 py-0.5 text-[10px] text-zinc-300">{ref}</span>}
                </For>
              </Show>
            </div>
            <div class="mt-0.5 text-zinc-300">{commit.message}</div>
            <div class="mt-0.5 text-zinc-500">
              {commit.author} · {commit.date}
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

export default CommitLog

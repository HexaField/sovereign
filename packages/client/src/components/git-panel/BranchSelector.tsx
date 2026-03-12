import { type Component, createSignal, createResource, For, Show } from 'solid-js'

interface BranchSelectorProps {
  currentBranch: string
  orgId?: string
  projectId?: string
  onSwitch: (branch: string) => void
  onCreate: (branch: string) => void
}

const BranchSelector: Component<BranchSelectorProps> = (props) => {
  const [showCreate, setShowCreate] = createSignal(false)
  const [newBranch, setNewBranch] = createSignal('')

  const [branches] = createResource(
    () => ({ orgId: props.orgId, projectId: props.projectId }),
    async (params) => {
      if (!params.orgId || !params.projectId) return []
      try {
        const res = await fetch(`/api/git/branches?org=${params.orgId}&project=${params.projectId}`)
        if (!res.ok) return []
        return res.json() as Promise<string[]>
      } catch {
        return []
      }
    }
  )

  const handleCreate = () => {
    const name = newBranch().trim()
    if (!name) return
    props.onCreate(name)
    setNewBranch('')
    setShowCreate(false)
  }

  return (
    <div class="border-b border-zinc-700 px-2 py-1.5">
      <div class="flex items-center gap-2">
        <select
          class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300"
          value={props.currentBranch}
          onChange={(e) => props.onSwitch(e.currentTarget.value)}
        >
          <For each={branches() ?? []}>
            {(branch) => (
              <option value={branch} selected={branch === props.currentBranch}>
                {branch}
              </option>
            )}
          </For>
        </select>
        <button
          class="text-xs text-zinc-500 hover:text-zinc-300"
          onClick={() => setShowCreate((s) => !s)}
          title="Create branch"
        >
          +
        </button>
      </div>
      <Show when={showCreate()}>
        <div class="mt-1 flex items-center gap-1">
          <input
            class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 focus:border-blue-500 focus:outline-none"
            placeholder="New branch name"
            value={newBranch()}
            onInput={(e) => setNewBranch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
            }}
          />
          <button class="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500" onClick={handleCreate}>
            Create
          </button>
        </div>
      </Show>
    </div>
  )
}

export default BranchSelector

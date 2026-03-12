import { type Component, createResource, For, Show } from 'solid-js'

interface QuickRunProps {
  orgId?: string
  projectId?: string
}

interface PackageScripts {
  [key: string]: string
}

const QuickRun: Component<QuickRunProps> = (props) => {
  const [scripts] = createResource(
    () => ({ orgId: props.orgId, projectId: props.projectId }),
    async (params) => {
      if (!params.orgId || !params.projectId) return {}
      try {
        const res = await fetch(`/api/files?path=package.json&project=${params.projectId}&org=${params.orgId}`)
        if (!res.ok) return {}
        const data = await res.json()
        const parsed = JSON.parse(data.content)
        return (parsed.scripts ?? {}) as PackageScripts
      } catch {
        return {}
      }
    }
  )

  const runScript = async (name: string) => {
    // Create a terminal session running the script
    await fetch('/api/terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: props.orgId,
        projectId: props.projectId,
        command: `npm run ${name}`
      })
    })
  }

  const entries = () => Object.entries(scripts() ?? {})

  return (
    <Show when={entries().length > 0}>
      <div class="flex flex-wrap gap-1 border-b border-zinc-700 px-2 py-1.5">
        <For each={entries()}>
          {([name]) => (
            <button
              class="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700"
              onClick={() => runScript(name)}
              title={name}
            >
              ▶ {name}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

export default QuickRun

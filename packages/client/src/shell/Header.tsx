import { type Component, createSignal, createResource, For, Show } from 'solid-js'

interface OrgSummary {
  id: string
  name: string
}

interface ProjectSummary {
  id: string
  name: string
}

const Header: Component = () => {
  const [orgs] = createResource<OrgSummary[]>(async () => {
    try {
      const res = await fetch('/api/orgs')
      if (!res.ok) return []
      return res.json()
    } catch {
      return []
    }
  })

  const [activeOrgId, setActiveOrgId] = createSignal<string>('')
  const [activeProjectId, setActiveProjectId] = createSignal<string>('')

  const [projects] = createResource(activeOrgId, async (orgId) => {
    if (!orgId) return []
    try {
      const res = await fetch(`/api/orgs/${orgId}/projects`)
      if (!res.ok) return []
      return res.json() as Promise<ProjectSummary[]>
    } catch {
      return []
    }
  })

  const [notifications] = createResource<number>(async () => {
    try {
      const res = await fetch('/api/notifications/unread')
      if (!res.ok) return 0
      const data = await res.json()
      return data.count ?? 0
    } catch {
      return 0
    }
  })

  return (
    <div class="flex items-center justify-between border-b border-zinc-700 bg-zinc-900 px-3 py-1.5">
      <div class="flex items-center gap-2">
        {/* Org switcher */}
        <select
          class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300"
          value={activeOrgId()}
          onChange={(e) => {
            setActiveOrgId(e.currentTarget.value)
            setActiveProjectId('')
          }}
        >
          <option value="">Select org...</option>
          <For each={orgs() ?? []}>{(org) => <option value={org.id}>{org.name}</option>}</For>
        </select>

        {/* Project selector */}
        <Show when={activeOrgId()}>
          <span class="text-zinc-600">/</span>
          <select
            class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300"
            value={activeProjectId()}
            onChange={(e) => setActiveProjectId(e.currentTarget.value)}
          >
            <option value="">Select project...</option>
            <For each={projects() ?? []}>{(proj) => <option value={proj.id}>{proj.name}</option>}</For>
          </select>
        </Show>
      </div>

      {/* Notification bell */}
      <div class="relative cursor-pointer text-zinc-400 hover:text-zinc-200">
        <span class="text-lg">🔔</span>
        <Show when={(notifications() ?? 0) > 0}>
          <span class="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
            {notifications()}
          </span>
        </Show>
      </div>
    </div>
  )
}

export default Header

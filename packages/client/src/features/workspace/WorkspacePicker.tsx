import { createSignal, createResource, For, Show, onCleanup, type Component } from 'solid-js'
import { activeWorkspace, setActiveWorkspace, setActiveProject } from './store.js'

interface OrgData {
  id: string
  name: string
  path: string
}

interface ProjectData {
  id: string
  orgId: string
  name: string
  repoPath: string
}

const fetchOrgs = async (): Promise<OrgData[]> => {
  const res = await fetch('/api/orgs')
  if (!res.ok) return []
  return res.json()
}

const fetchProjects = async (orgId: string): Promise<ProjectData[]> => {
  const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/projects`)
  if (!res.ok) return []
  return res.json()
}

const WorkspacePicker: Component = () => {
  const [open, setOpen] = createSignal(false)
  const [scanning, setScanning] = createSignal(false)
  const [showAddForm, setShowAddForm] = createSignal(false)
  const [addName, setAddName] = createSignal('')
  const [addPath, setAddPath] = createSignal('')
  const [addError, setAddError] = createSignal('')
  let containerRef: HTMLDivElement | undefined
  let buttonRef: HTMLButtonElement | undefined

  // Compute dropdown position relative to viewport
  const dropdownStyle = () => {
    if (!buttonRef) return {}
    const rect = buttonRef.getBoundingClientRect()
    return {
      position: 'fixed' as const,
      top: `${rect.bottom + 4}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      'max-height': '320px',
      'z-index': '9999'
    }
  }

  // Close on click outside
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false)
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('mousedown', handleClickOutside)
    onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))
  }

  const ws = () => activeWorkspace()
  const currentOrgId = () => ws()?.orgId ?? '_global'

  const [orgs, { refetch: refetchOrgs }] = createResource(fetchOrgs)
  const [projects, { refetch: refetchProjects }] = createResource(currentOrgId, fetchProjects)

  const handleSelectProject = (orgId: string, orgName: string, project: ProjectData) => {
    setActiveWorkspace(orgId, orgName)
    setActiveProject(project.id, project.name)
    setOpen(false)
  }

  const handleScan = async () => {
    setScanning(true)
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(currentOrgId())}/detect-projects`, { method: 'POST' })
      if (res.ok) {
        refetchProjects()
      }
    } finally {
      setScanning(false)
    }
  }

  const handleAdd = async () => {
    setAddError('')
    const name = addName().trim()
    const repoPath = addPath().trim()
    if (!name || !repoPath) {
      setAddError('Name and path are required')
      return
    }
    const res = await fetch(`/api/orgs/${encodeURIComponent(currentOrgId())}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, repoPath })
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Failed to add project' }))
      setAddError(data.error || 'Failed')
      return
    }
    setAddName('')
    setAddPath('')
    setShowAddForm(false)
    refetchProjects()
  }

  const currentLabel = () => {
    const p = ws()?.activeProjectName
    const o = ws()?.orgName ?? 'Global'
    return p ? `${o} / ${p}` : o
  }

  return (
    <div class="relative" ref={containerRef}>
      <button
        ref={buttonRef}
        class="flex w-full items-center justify-between rounded px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-80"
        style={{ background: 'var(--c-bg)', color: 'var(--c-text-heading)', border: '1px solid var(--c-border)' }}
        onClick={() => {
          const wasOpen = open()
          setOpen(!wasOpen)
          if (!wasOpen) {
            refetchOrgs()
            refetchProjects()
          }
        }}
      >
        <span class="truncate">{currentLabel()}</span>
        <span style={{ color: 'var(--c-text-muted)' }}>▾</span>
      </button>

      <Show when={open()}>
        <div
          class="overflow-auto rounded border shadow-lg"
          style={{ ...dropdownStyle(), background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}
        >
          <For each={orgs() ?? []}>
            {(org) => (
              <div>
                <div
                  class="px-3 py-1.5 text-xs font-semibold"
                  style={{ color: 'var(--c-text-muted)', background: 'var(--c-bg)' }}
                >
                  {org.name}
                </div>
                <Show when={org.id === currentOrgId()}>
                  <For each={projects() ?? []}>
                    {(project) => (
                      <button
                        class="block w-full px-4 py-1.5 text-left text-xs transition-colors hover:opacity-80"
                        style={{
                          color: ws()?.activeProjectId === project.id ? 'var(--c-accent)' : 'var(--c-text)',
                          background:
                            ws()?.activeProjectId === project.id
                              ? 'var(--c-accent-dim, rgba(99,102,241,0.1))'
                              : 'transparent'
                        }}
                        onClick={() => handleSelectProject(org.id, org.name, project)}
                      >
                        {project.name}
                      </button>
                    )}
                  </For>
                </Show>
                <Show when={org.id !== currentOrgId()}>
                  <button
                    class="block w-full px-4 py-1 text-left text-xs"
                    style={{ color: 'var(--c-text-muted)' }}
                    onClick={() => {
                      setActiveWorkspace(org.id, org.name)
                      refetchProjects()
                    }}
                  >
                    Switch to this org →
                  </button>
                </Show>
              </div>
            )}
          </For>

          {/* Actions */}
          <div class="border-t px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
            <div class="flex gap-2">
              <button
                class="rounded px-2 py-1 text-xs transition-colors hover:opacity-80"
                style={{ background: 'var(--c-accent)', color: 'white' }}
                onClick={handleScan}
                disabled={scanning()}
              >
                {scanning() ? 'Scanning...' : 'Scan'}
              </button>
              <button
                class="rounded px-2 py-1 text-xs transition-colors hover:opacity-80"
                style={{ border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
                onClick={() => setShowAddForm(!showAddForm())}
              >
                + Add
              </button>
            </div>

            <Show when={showAddForm()}>
              <div class="mt-2 space-y-1">
                <input
                  class="w-full rounded px-2 py-1 text-xs"
                  style={{ background: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
                  placeholder="Project name"
                  value={addName()}
                  onInput={(e) => setAddName(e.currentTarget.value)}
                />
                <input
                  class="w-full rounded px-2 py-1 text-xs"
                  style={{ background: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
                  placeholder="/path/to/repo"
                  value={addPath()}
                  onInput={(e) => setAddPath(e.currentTarget.value)}
                />
                <Show when={addError()}>
                  <p class="text-xs" style={{ color: 'var(--c-error, #ef4444)' }}>
                    {addError()}
                  </p>
                </Show>
                <button
                  class="rounded px-2 py-1 text-xs"
                  style={{ background: 'var(--c-accent)', color: 'white' }}
                  onClick={handleAdd}
                >
                  Add Project
                </button>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default WorkspacePicker

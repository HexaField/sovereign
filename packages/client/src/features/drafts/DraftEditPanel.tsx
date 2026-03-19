import { Component, Show, For, createSignal, createEffect, on, onMount } from 'solid-js'
import { draftsStore } from './index.js'
import type { Draft, DraftDep } from './store.js'

const DraftEditPanel: Component = () => {
  const selectedId = () => draftsStore.selectedDraftId()
  const draft = (): Draft | undefined => draftsStore.drafts().find((d) => d.id === selectedId())

  const [title, setTitle] = createSignal('')
  const [body, setBody] = createSignal('')
  const [labels, setLabels] = createSignal<string[]>([])
  const [labelInput, setLabelInput] = createSignal('')
  const [orgId, setOrgId] = createSignal<string | null>(null)
  const [projectId, setProjectId] = createSignal<string | null>(null)
  const [orgs, setOrgs] = createSignal<Array<{ id: string; name: string }>>([])
  const [projects, setProjects] = createSignal<Array<{ id: string; name: string }>>([])
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [confirmPublish, setConfirmPublish] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [publishing, setPublishing] = createSignal(false)

  let saveTimer: ReturnType<typeof setTimeout> | undefined

  // Load draft data into local signals
  createEffect(
    on(
      () => draft(),
      (d) => {
        if (d) {
          setTitle(d.title)
          setBody(d.body)
          setLabels([...d.labels])
          setOrgId(d.orgId)
          setProjectId(d.projectId)
        }
      }
    )
  )

  onMount(async () => {
    try {
      const res = await fetch('/api/orgs')
      if (res.ok) setOrgs(await res.json())
    } catch {
      /* ignore */
    }
  })

  // Fetch projects when org changes
  createEffect(
    on(orgId, async (oid) => {
      if (oid) {
        try {
          const res = await fetch(`/api/orgs/${encodeURIComponent(oid)}/projects`)
          if (res.ok) setProjects(await res.json())
          else setProjects([])
        } catch {
          setProjects([])
        }
      } else {
        setProjects([])
        setProjectId(null)
      }
    })
  )

  function debouncedSave(patch: Record<string, unknown>) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      const id = selectedId()
      if (!id) return
      setSaving(true)
      try {
        await draftsStore.updateDraft(id, patch as any)
      } finally {
        setSaving(false)
      }
    }, 500)
  }

  function handleTitleChange(val: string) {
    setTitle(val)
    debouncedSave({ title: val })
  }

  function handleBodyChange(val: string) {
    setBody(val)
    debouncedSave({ body: val })
  }

  function handleOrgChange(val: string) {
    const v = val || null
    setOrgId(v)
    setProjectId(null)
    debouncedSave({ orgId: v, projectId: null })
  }

  function handleProjectChange(val: string) {
    const v = val || null
    setProjectId(v)
    debouncedSave({ projectId: v })
  }

  function addLabel() {
    const l = labelInput().trim()
    if (l && !labels().includes(l)) {
      const next = [...labels(), l]
      setLabels(next)
      setLabelInput('')
      debouncedSave({ labels: next })
    }
  }

  function removeLabel(label: string) {
    const next = labels().filter((l) => l !== label)
    setLabels(next)
    debouncedSave({ labels: next })
  }

  async function handleRemoveDep(index: number) {
    const id = selectedId()
    if (!id) return
    await draftsStore.removeDependency(id, index)
  }

  async function handlePublish() {
    const id = selectedId()
    const oid = orgId()
    const pid = projectId()
    if (!id || !oid || !pid) return
    setPublishing(true)
    try {
      await draftsStore.publishDraft(id, oid, pid)
      draftsStore.selectDraft(null)
    } finally {
      setPublishing(false)
      setConfirmPublish(false)
    }
  }

  async function handleDelete() {
    const id = selectedId()
    if (!id) return
    await draftsStore.deleteDraft(id)
    draftsStore.selectDraft(null)
    setConfirmDelete(false)
  }

  return (
    <div class="flex h-full flex-col overflow-auto" style={{ background: 'var(--c-bg)' }}>
      <Show
        when={draft()}
        fallback={
          <div class="flex h-full items-center justify-center">
            <p class="text-sm" style={{ color: 'var(--c-text-muted)', opacity: 0.5 }}>
              Draft not found
            </p>
          </div>
        }
      >
        {(d) => (
          <div class="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
            {/* Header */}
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span
                  class="rounded-full border px-2 py-0.5 text-[10px] font-medium"
                  style={{ 'border-color': '#d97706', color: '#d97706' }}
                >
                  DRAFT
                </span>
                <Show when={saving()}>
                  <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    Saving...
                  </span>
                </Show>
              </div>
              <button
                class="text-xs hover:opacity-80"
                style={{ color: 'var(--c-text-muted)' }}
                onClick={() => draftsStore.selectDraft(null)}
              >
                Close
              </button>
            </div>

            {/* Title */}
            <input
              type="text"
              value={title()}
              onInput={(e) => handleTitleChange(e.currentTarget.value)}
              class="w-full rounded border px-3 py-2 text-sm"
              style={{
                background: 'var(--c-bg-secondary)',
                'border-color': 'var(--c-border)',
                color: 'var(--c-text)'
              }}
              placeholder="Draft title"
            />

            {/* Body */}
            <textarea
              value={body()}
              onInput={(e) => handleBodyChange(e.currentTarget.value)}
              class="min-h-[120px] w-full rounded border px-3 py-2 text-sm"
              style={{
                background: 'var(--c-bg-secondary)',
                'border-color': 'var(--c-border)',
                color: 'var(--c-text)',
                resize: 'vertical'
              }}
              placeholder="Description (optional)"
            />

            {/* Labels */}
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
                Labels
              </label>
              <div class="flex flex-wrap gap-1">
                <For each={labels()}>
                  {(label) => (
                    <span
                      class="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                      style={{ background: 'var(--c-bg-tertiary)', color: 'var(--c-text-muted)' }}
                    >
                      {label}
                      <button class="ml-0.5 hover:opacity-80" onClick={() => removeLabel(label)}>
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                          <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.5" fill="none" />
                        </svg>
                      </button>
                    </span>
                  )}
                </For>
              </div>
              <div class="flex gap-1">
                <input
                  type="text"
                  value={labelInput()}
                  onInput={(e) => setLabelInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addLabel()
                    }
                  }}
                  class="flex-1 rounded border px-2 py-1 text-xs"
                  style={{
                    background: 'var(--c-bg-secondary)',
                    'border-color': 'var(--c-border)',
                    color: 'var(--c-text)'
                  }}
                  placeholder="Add label + Enter"
                />
              </div>
            </div>

            {/* Workspace dropdown */}
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
                Workspace
              </label>
              <select
                value={orgId() ?? ''}
                onChange={(e) => handleOrgChange(e.currentTarget.value)}
                class="rounded border px-2 py-1.5 text-xs"
                style={{
                  background: 'var(--c-bg-secondary)',
                  'border-color': 'var(--c-border)',
                  color: 'var(--c-text)'
                }}
              >
                <option value="">Unassigned</option>
                <For each={orgs()}>{(org) => <option value={org.id}>{org.name}</option>}</For>
              </select>
            </div>

            {/* Project dropdown */}
            <Show when={orgId()}>
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
                  Project
                </label>
                <select
                  value={projectId() ?? ''}
                  onChange={(e) => handleProjectChange(e.currentTarget.value)}
                  class="rounded border px-2 py-1.5 text-xs"
                  style={{
                    background: 'var(--c-bg-secondary)',
                    'border-color': 'var(--c-border)',
                    color: 'var(--c-text)'
                  }}
                >
                  <option value="">Select project</option>
                  <For each={projects()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
                </select>
              </div>
            </Show>

            {/* Dependencies */}
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
                Dependencies
              </label>
              <Show
                when={d().dependencies.length > 0}
                fallback={
                  <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                    No dependencies
                  </p>
                }
              >
                <div class="flex flex-col gap-1">
                  <For each={d().dependencies}>
                    {(dep, i) => (
                      <div
                        class="flex items-center justify-between rounded px-2 py-1"
                        style={{ background: 'var(--c-bg-secondary)' }}
                      >
                        <span class="text-xs" style={{ color: 'var(--c-text)' }}>
                          {dep.type}:{' '}
                          {dep.target.kind === 'draft'
                            ? `Draft ${dep.target.draftId.slice(0, 8)}...`
                            : `${dep.target.ref.issueId}`}
                        </span>
                        <button
                          class="rounded px-1 text-xs hover:opacity-80"
                          style={{ color: 'var(--c-error)' }}
                          onClick={() => handleRemoveDep(i())}
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                          >
                            <path d="M2 2l6 6M8 2l-6 6" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            {/* Actions */}
            <div class="flex items-center gap-2 border-t pt-4" style={{ 'border-color': 'var(--c-border)' }}>
              {/* Publish */}
              <Show when={orgId() && projectId()}>
                <Show
                  when={!confirmPublish()}
                  fallback={
                    <div class="flex items-center gap-2">
                      <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                        Publish this draft?
                      </span>
                      <button
                        class="rounded px-3 py-1 text-xs font-medium"
                        style={{ background: 'var(--c-accent)', color: 'var(--c-text-on-accent)' }}
                        disabled={publishing()}
                        onClick={handlePublish}
                      >
                        {publishing() ? 'Publishing...' : 'Confirm'}
                      </button>
                      <button
                        class="rounded px-2 py-1 text-xs"
                        style={{ color: 'var(--c-text-muted)' }}
                        onClick={() => setConfirmPublish(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  }
                >
                  <button
                    class="rounded px-3 py-1.5 text-xs font-medium"
                    style={{ background: 'var(--c-accent)', color: 'var(--c-text-on-accent)' }}
                    onClick={() => setConfirmPublish(true)}
                  >
                    Publish
                  </button>
                </Show>
              </Show>

              <div class="flex-1" />

              {/* Delete */}
              <Show
                when={!confirmDelete()}
                fallback={
                  <div class="flex items-center gap-2">
                    <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      Delete this draft?
                    </span>
                    <button
                      class="rounded px-3 py-1 text-xs font-medium"
                      style={{ background: 'var(--c-error)', color: '#fff' }}
                      onClick={handleDelete}
                    >
                      Confirm
                    </button>
                    <button
                      class="rounded px-2 py-1 text-xs"
                      style={{ color: 'var(--c-text-muted)' }}
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </button>
                  </div>
                }
              >
                <button
                  class="rounded px-3 py-1.5 text-xs"
                  style={{ color: 'var(--c-error)' }}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

export default DraftEditPanel

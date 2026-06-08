import { createSignal, Show, For, onCleanup, onMount } from 'solid-js'
import { wsStore } from '../../ws/index.js'
import { formatRelativeTime } from '../../lib/format.js'
import { activeWorkspace, chatExpanded, toggleChatExpanded, setActiveWorkspace } from './store.js'
import { threadKey, switchThread, threads, createThread, moveThread } from '../threads/store.js'
import { ChatSettingsButton } from '../chat/ChatSettings.js'
import { RecipeButton } from '../recipes/RecipePanel.js'
import { startNotificationPolling } from '../notifications/store.js'
import { ExpandIcon, CollapseIcon } from '../../ui/icons.js'

interface OrgListItem {
  id: string
  name: string
}

interface BrowseEntry {
  name: string
  isDirectory: boolean
}

interface BrowseResult {
  path: string
  parent: string | null
  entries: BrowseEntry[]
}

interface SubagentInfo {
  sessionKey: string
  label: string
  status: string
  task: string
}

const BASE = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'

function FolderBrowser(props: { path: string; onSelect: (path: string) => void }) {
  const [currentPath, setCurrentPath] = createSignal(props.path || '')
  const [entries, setEntries] = createSignal<BrowseEntry[]>([])
  const [parentPath, setParentPath] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [browseError, setBrowseError] = createSignal('')
  const [showHidden, setShowHidden] = createSignal(false)

  const browse = async (dirPath?: string) => {
    setLoading(true)
    setBrowseError('')
    try {
      const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''
      const res = await fetch(`${BASE}api/files/browse${params}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to browse' }))
        setBrowseError(data.error || 'Failed to browse directory')
        return
      }
      const data: BrowseResult = await res.json()
      setCurrentPath(data.path)
      setParentPath(data.parent)
      setEntries(data.entries)
      props.onSelect(data.path)
    } catch (e: any) {
      setBrowseError(e.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }

  browse(props.path || undefined)

  const filteredEntries = () => {
    const all = entries()
    return showHidden() ? all : all.filter((e) => !e.name.startsWith('.'))
  }

  const breadcrumbs = () => {
    const p = currentPath()
    if (!p) return []
    const parts = p.split('/').filter(Boolean)
    const segments: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of parts) {
      acc += '/' + part
      segments.push({ label: part, path: acc })
    }
    return segments
  }

  return (
    <div>
      <div
        class="mb-2 flex flex-wrap items-center gap-0.5 rounded-lg px-2 py-1.5 text-xs"
        style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
      >
        <For each={breadcrumbs()}>
          {(seg, i) => (
            <>
              <Show when={i() > 0}>
                <span style={{ color: 'var(--c-text-muted)' }}>/</span>
              </Show>
              <button
                class="rounded px-1 py-0.5 transition-colors hover:underline"
                style={{ color: 'var(--c-accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                onClick={() => browse(seg.path)}
              >
                {seg.label}
              </button>
            </>
          )}
        </For>
      </div>

      <div
        class="overflow-y-auto rounded-lg"
        style={{
          background: 'var(--c-bg)',
          border: '1px solid var(--c-border)',
          'max-height': '300px',
          'min-height': '120px'
        }}
      >
        <Show when={loading()}>
          <div class="flex items-center justify-center py-8 text-xs" style={{ color: 'var(--c-text-muted)' }}>
            Loading…
          </div>
        </Show>
        <Show when={browseError()}>
          <div class="px-3 py-4 text-xs" style={{ color: 'var(--c-danger, #ef4444)' }}>
            {browseError()}
          </div>
        </Show>
        <Show when={!loading() && !browseError()}>
          <Show when={parentPath()}>
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors"
              style={{ color: 'var(--c-text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => browse(parentPath()!)}
            >
              <span>📁</span>
              <span>..</span>
            </button>
          </Show>
          <For each={filteredEntries()}>
            {(entry) => (
              <button
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors"
                style={{ color: 'var(--c-text)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => browse(currentPath() + '/' + entry.name)}
              >
                <span>📁</span>
                <span>{entry.name}</span>
              </button>
            )}
          </For>
          <Show when={filteredEntries().length === 0 && !parentPath()}>
            <div class="px-3 py-4 text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Empty directory
            </div>
          </Show>
        </Show>
      </div>

      <div class="mt-2 flex items-center gap-2">
        <label class="flex cursor-pointer items-center gap-1.5 text-xs" style={{ color: 'var(--c-text-muted)' }}>
          <input
            type="checkbox"
            checked={showHidden()}
            onChange={(e) => setShowHidden(e.currentTarget.checked)}
            class="accent-[var(--c-accent)]"
          />
          Show hidden folders
        </label>
      </div>
    </div>
  )
}

function AddWorkspaceDialog(props: { onClose: () => void; onCreated: (org: OrgListItem) => void }) {
  const [name, setName] = createSignal('')
  const [wsPath, setWsPath] = createSignal('')
  const [error, setError] = createSignal('')
  const [submitting, setSubmitting] = createSignal(false)

  const handleSubmit = async () => {
    if (!name().trim() || !wsPath().trim()) {
      setError('Name and path are required')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`${BASE}api/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name().trim(), path: wsPath().trim() })
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to create workspace' }))
        setError(data.error || 'Failed to create workspace')
        return
      }
      const org = await res.json()
      props.onCreated(org)
    } catch (e: any) {
      setError(e.message || 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div class="fixed inset-0 z-[300] bg-black/50" onClick={() => props.onClose()} />
      <div
        class="fixed top-1/2 left-1/2 z-[301] w-[480px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl p-5 shadow-2xl"
        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
      >
        <h2 class="mb-4 text-base font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          Add Workspace
        </h2>
        <div class="flex flex-col gap-3">
          <div>
            <label class="mb-1 block text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
              Name
            </label>
            <input
              type="text"
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--c-bg)', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }}
              placeholder="My Workspace"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
              Folder
            </label>
            <FolderBrowser path="" onSelect={(p) => setWsPath(p)} />
            <div class="mt-2">
              <input
                type="text"
                class="w-full rounded-lg border px-3 py-2 text-xs outline-none"
                style={{
                  background: 'var(--c-bg)',
                  color: 'var(--c-text)',
                  'border-color': 'var(--c-border)',
                  'font-family': 'monospace'
                }}
                placeholder="/path/to/folder"
                value={wsPath()}
                onInput={(e) => setWsPath(e.currentTarget.value)}
              />
            </div>
          </div>
          <Show when={error()}>
            <p class="text-xs" style={{ color: 'var(--c-danger, #ef4444)' }}>
              {error()}
            </p>
          </Show>
          <div class="mt-1 flex justify-end gap-2">
            <button
              class="rounded-lg px-4 py-2 text-sm transition-colors"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={() => props.onClose()}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
            >
              Cancel
            </button>
            <button
              class="rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
              style={{ background: 'var(--c-accent)', opacity: submitting() ? '0.6' : '1' }}
              disabled={submitting()}
              onClick={handleSubmit}
            >
              {submitting() ? 'Creating…' : 'Select & Create'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function SubagentTree(props: {
  subagents: SubagentInfo[]
  allSubagents: Record<string, SubagentInfo[]>
  depth: number
  activeKey: string
  onSelect: (sessionKey: string) => void
}) {
  return (
    <div style={{ 'padding-left': `${props.depth * 16}px` }} class="pb-0.5">
      <For each={props.subagents}>
        {(sa) => {
          const isActive = () => sa.status === 'working' || sa.status === 'thinking'
          const isSelected = () => props.activeKey === sa.sessionKey
          const children = () => props.allSubagents[sa.sessionKey] || []
          return (
            <>
              <button
                class="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-3 py-1.5 text-left text-xs transition-colors"
                style={{
                  color: isSelected() ? 'var(--c-accent)' : 'var(--c-text-muted)',
                  background: isSelected() ? 'var(--c-hover-bg)' : 'transparent'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--c-hover-bg)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isSelected() ? 'var(--c-hover-bg)' : 'transparent'
                }}
                onClick={() => props.onSelect(sa.sessionKey)}
                title={sa.task || sa.label}
              >
                <span
                  class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    background: isActive() ? 'var(--c-warning, #f59e0b)' : 'var(--c-text-muted)',
                    animation: isActive() ? 'pulse-dot 2s ease-in-out infinite' : 'none'
                  }}
                />
                <Show when={isSelected()}>
                  <span class="text-[10px]">●</span>
                </Show>
                <span class="min-w-0 flex-1 truncate">{sa.label}</span>
                <Show when={isActive()}>
                  <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-warning, #f59e0b)' }}>
                    {sa.status}
                  </span>
                </Show>
              </button>
              <Show when={children().length > 0}>
                <SubagentTree
                  subagents={children()}
                  allSubagents={props.allSubagents}
                  depth={props.depth + 1}
                  activeKey={props.activeKey}
                  onSelect={props.onSelect}
                />
              </Show>
            </>
          )
        }}
      </For>
    </div>
  )
}

export function WorkspaceHeaderContent() {
  const ws = () => activeWorkspace()
  const [threadPickerOpen, setThreadPickerOpen] = createSignal(false)
  const [newThreadInput, setNewThreadInput] = createSignal(false)
  const [newThreadLabel, setNewThreadLabel] = createSignal('')
  const [moveThreadKey, setMoveThreadKey] = createSignal<string | null>(null)
  const [wsPickerOpen, setWsPickerOpen] = createSignal(false)
  const [orgList, setOrgList] = createSignal<OrgListItem[]>([])
  const [showAddDialog, setShowAddDialog] = createSignal(false)
  const [activeSubagents, setActiveSubagents] = createSignal<
    Record<
      string,
      Array<{
        sessionKey: string
        label: string
        status: string
        task: string
      }>
    >
  >({})

  // Ticks every 60s so relative-time strings re-compute even when thread data is unchanged.
  const [nowTick, setNowTick] = createSignal(Date.now())

  const fetchActiveSubagents = async () => {
    try {
      const res = await fetch('/api/threads/active-subagents')
      const data = await res.json()
      setActiveSubagents(data.subagents || {})
    } catch {
      /* ignore */
    }
  }

  let subagentRefetchTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSubagentRefetch = () => {
    if (subagentRefetchTimer) return
    subagentRefetchTimer = setTimeout(() => {
      subagentRefetchTimer = null
      void fetchActiveSubagents()
    }, 250)
  }

  onMount(() => {
    wsStore.subscribe(['chat'])
    const offSpawned = wsStore.on('subagent.spawned', scheduleSubagentRefetch)
    const offCompleted = wsStore.on('subagent.completed', scheduleSubagentRefetch)
    const offFailed = wsStore.on('subagent.failed', scheduleSubagentRefetch)
    void fetchActiveSubagents()

    // Clock tick for relative-time display — every 60s.
    const clockInterval = setInterval(() => setNowTick(Date.now()), 60_000)

    // Fallback poll while dropdown is open: WS events cover spawned/completed/failed
    // but not mid-lifecycle status transitions. Poll every 10s so status never drifts
    // more than one interval behind reality.
    const pollInterval = setInterval(() => {
      if (threadPickerOpen()) void fetchActiveSubagents()
    }, 10_000)

    onCleanup(() => {
      offSpawned()
      offCompleted()
      offFailed()
      if (subagentRefetchTimer) clearTimeout(subagentRefetchTimer)
      clearInterval(clockInterval)
      clearInterval(pollInterval)
    })
  })

  const fetchOrgs = async () => {
    try {
      const res = await fetch(`${BASE}api/orgs`)
      if (res.ok) setOrgList(await res.json())
    } catch {
      /* ignore */
    }
  }

  startNotificationPolling()

  const activeThreadLabel = () => {
    const key = threadKey()
    if (!key) return 'No thread'
    const t = threads().find((th) => th.id === key)
    if (t) return t.label ?? t.id
    const subs = activeSubagents()
    for (const children of Object.values(subs)) {
      const match = children.find((sa) => sa.sessionKey === key)
      if (match) return match.label
    }
    if (key.includes(':subagent:')) {
      const uuid = key.split(':subagent:')[1]
      return uuid ? uuid.slice(0, 8) : key
    }
    return key
  }

  return (
    <div class="flex min-w-0 items-center gap-1.5 text-sm">
      <div class="relative">
        <button
          class="flex cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-1.5 py-0.5 text-sm font-semibold transition-colors"
          style={{ color: 'var(--c-text-heading)' }}
          onClick={() => {
            fetchOrgs()
            setWsPickerOpen(!wsPickerOpen())
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {ws()?.orgName ?? 'Global'}
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            ▾
          </span>
        </button>
        <Show when={wsPickerOpen()}>
          <div class="fixed inset-0 z-[199]" onClick={() => setWsPickerOpen(false)} />
          <div
            class="fixed z-[200] mt-1 min-w-[180px] overflow-hidden rounded-lg shadow-lg"
            style={{
              background: 'var(--c-bg-raised)',
              border: '1px solid var(--c-border)',
              top: 'var(--ws-picker-top, 40px)',
              left: 'var(--ws-picker-left, 60px)'
            }}
            ref={(el) => {
              const btn = el.previousElementSibling?.previousElementSibling as HTMLElement
              if (btn) {
                const rect = btn.getBoundingClientRect()
                el.style.top = `${rect.bottom + 4}px`
                el.style.left = `${rect.left}px`
              }
            }}
          >
            <For each={orgList()}>
              {(org) => (
                <a
                  class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm no-underline transition-colors"
                  href={`?view=workspace${org.id !== '_global' ? `&workspace=${org.id}` : ''}`}
                  style={{
                    color: org.id === ws()?.orgId ? 'var(--c-accent)' : 'var(--c-text)',
                    background: org.id === ws()?.orgId ? 'var(--c-hover-bg)' : undefined
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = org.id === ws()?.orgId ? 'var(--c-hover-bg)' : '')
                  }
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) return
                    e.preventDefault()
                    setActiveWorkspace(org.id, org.name)
                    setWsPickerOpen(false)
                  }}
                >
                  <Show when={org.id === ws()?.orgId}>
                    <span class="text-xs">●</span>
                  </Show>
                  <span>{org.name}</span>
                </a>
              )}
            </For>
            <div style={{ 'border-top': '1px solid var(--c-border)' }}>
              <button
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
                style={{ color: 'var(--c-text-muted)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                onClick={() => {
                  setWsPickerOpen(false)
                  setShowAddDialog(true)
                }}
              >
                <span>+</span>
                <span>Add Workspace…</span>
              </button>
            </div>
          </div>
        </Show>
      </div>

      <Show when={showAddDialog()}>
        <AddWorkspaceDialog
          onClose={() => setShowAddDialog(false)}
          onCreated={(org) => {
            setShowAddDialog(false)
            setActiveWorkspace(org.id, org.name)
          }}
        />
      </Show>
      <span style={{ color: 'var(--c-text-muted)' }}>/</span>
      <div class="relative flex min-w-0 items-center">
        <button
          class="flex cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-1.5 py-0.5 text-sm font-medium transition-colors"
          style={{
            color: 'var(--c-accent)',
            'max-width': '140px',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap'
          }}
          onClick={() => {
            fetchOrgs()
            fetchActiveSubagents()
            setThreadPickerOpen(!threadPickerOpen())
            setNewThreadInput(false)
            setMoveThreadKey(null)
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          title="Switch thread"
        >
          <span class="overflow-hidden text-ellipsis whitespace-nowrap">{activeThreadLabel()}</span>
          <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            ▾
          </span>
        </button>
        <ChatSettingsButton />
        <RecipeButton />
        <button
          class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent transition-all"
          style={{ color: 'var(--c-text-muted)' }}
          onClick={() => toggleChatExpanded()}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--c-hover-bg)'
            e.currentTarget.style.color = 'var(--c-accent)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = 'var(--c-text-muted)'
          }}
          title={chatExpanded() ? 'Minimize chat' : 'Maximize chat'}
        >
          <Show when={chatExpanded()} fallback={<ExpandIcon class="h-3.5 w-3.5" />}>
            <CollapseIcon class="h-3.5 w-3.5" />
          </Show>
        </button>
        <Show when={threadPickerOpen()}>
          <div class="fixed inset-0 z-[199]" onClick={() => setThreadPickerOpen(false)} />
          <div
            class="absolute top-full left-0 z-[200] mt-1 min-w-[200px] overflow-hidden rounded-lg shadow-lg"
            style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
          >
            <For
              each={threads()
                .filter((t) => t.id)
                .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))}
            >
              {(t) => (
                <>
                  <div
                    class="group relative flex w-full items-center text-left text-sm transition-colors"
                    style={{
                      color: t.id === threadKey() ? 'var(--c-accent)' : 'var(--c-text)',
                      background: t.id === threadKey() ? 'var(--c-hover-bg)' : undefined
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = t.id === threadKey() ? 'var(--c-hover-bg)' : '')
                    }
                  >
                    <a
                      class="flex flex-1 items-center gap-2 px-3 py-2 no-underline"
                      href={`?view=workspace${ws()?.orgId && ws()?.orgId !== '_global' ? `&workspace=${ws()?.orgId}` : ''}#thread=${t.id}`}
                      style={{ color: 'inherit' }}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey) return
                        e.preventDefault()
                        switchThread(t.id)
                        setThreadPickerOpen(false)
                      }}
                    >
                      <Show when={t.id === threadKey()}>
                        <span class="text-xs">●</span>
                      </Show>
                      <span class="truncate">{t.label ?? t.id}</span>
                      <Show when={t.lastActivity}>
                        <span class="ml-auto shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                          {t.lastActivity ? formatRelativeTime(t.lastActivity, nowTick()) : ''}
                        </span>
                      </Show>
                    </a>
                    <div class="relative">
                      <button
                        class="px-2 py-2 text-sm font-bold opacity-80 transition-opacity hover:!opacity-100"
                        style={{ color: 'var(--c-accent)' }}
                        title="Move to workspace"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMoveThreadKey(moveThreadKey() === t.id ? null : t.id)
                        }}
                      >
                        ⇄
                      </button>
                      <Show when={moveThreadKey() === t.id}>
                        <div
                          class="absolute top-0 left-full z-[210] ml-1 min-w-[150px] overflow-hidden rounded-lg shadow-lg"
                          style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
                        >
                          <div
                            class="px-3 py-1.5 text-[10px] font-semibold tracking-wide uppercase"
                            style={{ color: 'var(--c-text-muted)' }}
                          >
                            Move to…
                          </div>
                          <For each={orgList().filter((o) => o.id !== t.workspaceIds?.[0])}>
                            {(org) => (
                              <button
                                class="flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors"
                                style={{ color: 'var(--c-text)' }}
                                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                                onClick={() => {
                                  moveThread(t.id, org.id)
                                  setMoveThreadKey(null)
                                  setThreadPickerOpen(false)
                                }}
                              >
                                {org.name}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </div>
                  <Show when={(activeSubagents()[t.id] || []).length > 0}>
                    <SubagentTree
                      subagents={activeSubagents()[t.id]}
                      allSubagents={activeSubagents()}
                      depth={1}
                      activeKey={threadKey()}
                      onSelect={(key) => {
                        switchThread(key)
                        setThreadPickerOpen(false)
                      }}
                    />
                  </Show>
                </>
              )}
            </For>

            <div class="mx-2 my-1 border-t" style={{ 'border-color': 'var(--c-border)' }} />
            <Show
              when={newThreadInput()}
              fallback={
                <button
                  class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors"
                  style={{ color: 'var(--c-text-muted)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  onClick={() => setNewThreadInput(true)}
                >
                  + New Thread
                </button>
              }
            >
              <div class="flex items-center gap-1 px-2 py-1.5">
                <input
                  class="flex-1 rounded border px-2 py-1 text-xs outline-none"
                  style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
                  placeholder="Thread name…"
                  value={newThreadLabel()}
                  onInput={(e) => setNewThreadLabel(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newThreadLabel().trim()) {
                      createThread(newThreadLabel().trim())
                      setNewThreadLabel('')
                      setNewThreadInput(false)
                      setThreadPickerOpen(false)
                    }
                    if (e.key === 'Escape') {
                      setNewThreadLabel('')
                      setNewThreadInput(false)
                    }
                  }}
                  ref={(el) => setTimeout(() => el.focus(), 0)}
                />
                <button
                  class="rounded px-2 py-1 text-xs font-medium text-white"
                  style={{ background: 'var(--c-accent)', opacity: newThreadLabel().trim() ? '1' : '0.4' }}
                  disabled={!newThreadLabel().trim()}
                  onClick={() => {
                    if (newThreadLabel().trim()) {
                      createThread(newThreadLabel().trim())
                      setNewThreadLabel('')
                      setNewThreadInput(false)
                      setThreadPickerOpen(false)
                    }
                  }}
                >
                  Create
                </button>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

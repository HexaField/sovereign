import { createSignal, createMemo, createResource, For, Show, onCleanup } from 'solid-js'
import type { ThreadInfo } from './store.js'
import { threadKey, switchThread, createThread } from './store.js'
import { getThreadDisplayName, getEntityIcon, groupThreadsByWorkspace, formatRelativeTime } from './helpers.js'

// ── Hidden threads (localStorage-backed) ─────────────────────────────

export const HIDDEN_THREADS_KEY = 'sovereign:hidden-threads'

export function getHiddenThreads(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_THREADS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function setHiddenThreads(keys: string[]): void {
  localStorage.setItem(HIDDEN_THREADS_KEY, JSON.stringify(keys))
}

export function hideThread(key: string): void {
  const hidden = getHiddenThreads()
  if (!hidden.includes(key)) {
    setHiddenThreads([...hidden, key])
  }
}

export function unhideThread(key: string): void {
  setHiddenThreads(getHiddenThreads().filter((k) => k !== key))
}

export function filterThreads(threads: ThreadInfo[], query: string): ThreadInfo[] {
  if (!query.trim()) return threads
  const q = query.toLowerCase()
  return threads.filter((t) => {
    const name = getThreadDisplayName(t).toLowerCase()
    if (name.includes(q)) return true
    if (t.label && t.label.toLowerCase().includes(q)) return true
    if (t.entities?.some((e) => e.entityRef.toLowerCase().includes(q))) return true
    return false
  })
}

// ── Types for session tree ───────────────────────────────────────────

interface SessionNode {
  key: string
  fullKey: string
  kind: 'main' | 'thread' | 'cron' | 'cron-run' | 'subagent' | 'event-agent'
  label: string
  parentKey: string | null
  updatedAt: number
  totalTokens: number
  children?: SessionNode[]
}

interface CronJobInfo {
  id: string
  name: string
  nextRunAtMs?: number
}

interface ThreadStatusItem {
  key: string
  busy: boolean
  hasUnread: boolean
  stuckReason?: string
  stuckSecs?: number
  laneErrors?: Array<{ timestamp: number; error: string }>
}

// ── Data fetching (stubs until server routes exist) ──────────────────

const BASE = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'

async function fetchSessionTree(): Promise<SessionNode[]> {
  try {
    const res = await fetch(`${BASE}api/sessions/tree`)
    if (!res.ok) return []
    const data = await res.json()
    return data.tree || []
  } catch {
    return []
  }
}

async function fetchCronByThread(): Promise<Record<string, CronJobInfo[]>> {
  try {
    const archRes = await fetch(`${BASE}api/architecture`)
    if (!archRes.ok) return {}
    const arch = await archRes.json()
    const jobs: Array<{
      id: string
      name: string
      enabled: boolean
      sessionTarget?: string
      sessionKey?: string
      state?: { nextRunAtMs?: number }
    }> = arch.cronJobs || []
    const result: Record<string, CronJobInfo[]> = {}
    for (const job of jobs) {
      if (!job.enabled) continue
      const nextMs = job.state?.nextRunAtMs
      if (!nextMs) continue
      let tKey = 'main'
      if (job.sessionKey) {
        const short = job.sessionKey.replace(/^agent:[^:]+:/, '')
        tKey = short === 'main' ? 'main' : short.startsWith('thread:') ? short : `thread:${short}`
      } else if (job.sessionTarget && job.sessionTarget !== 'main' && job.sessionTarget !== 'isolated') {
        tKey = job.sessionTarget.startsWith('thread:') ? job.sessionTarget : `thread:${job.sessionTarget}`
      }
      if (!result[tKey]) result[tKey] = []
      result[tKey].push({ id: job.id, name: job.name, nextRunAtMs: nextMs })
    }
    return result
  } catch {
    return {}
  }
}

async function fetchThreadStatus(): Promise<ThreadStatusItem[]> {
  try {
    const res = await fetch(`${BASE}api/sessions/status`)
    if (!res.ok) return []
    const data = await res.json()
    return data.threads || data || []
  } catch {
    return []
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  if (mins > 0) return `${mins}m`
  return '<1m'
}

const KIND_ICONS: Record<string, string> = {
  main: '💬',
  thread: '🧵',
  cron: '⏰',
  'cron-run': '▶',
  subagent: '🤖',
  'event-agent': '⚡'
}

const KIND_COLORS: Record<string, string> = {
  main: 'var(--c-accent)',
  thread: 'var(--c-accent)',
  cron: '#f59e0b',
  'cron-run': '#6b7280',
  subagent: '#8b5cf6',
  'event-agent': '#8b5cf6'
}

// ── Session row component ────────────────────────────────────────────

function SessionRow(props: {
  node: SessionNode
  depth: number
  activeKey: string
  cronJobs: Record<string, CronJobInfo[]>
  now: number
  threadStatus: Map<string, ThreadStatusItem>
  hidden?: boolean
  onHide?: (key: string) => void
  onUnhide?: (key: string) => void
}) {
  const [expanded, setExpanded] = createSignal(props.node.kind === 'main' || props.node.kind === 'thread')
  const [errorsExpanded, setErrorsExpanded] = createSignal(false)

  const isActive = () => props.activeKey === props.node.key
  const hasChildren = () => (props.node.children?.length || 0) > 0
  const cronForNode = () => props.cronJobs[props.node.key] || []

  const nextCron = () => {
    const jobs = cronForNode()
    if (!jobs.length) return undefined
    return jobs.reduce((a, b) => ((a.nextRunAtMs || Infinity) < (b.nextRunAtMs || Infinity) ? a : b))
  }

  const handleClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      const url = new URL(globalThis.location.href)
      url.searchParams.set('view', 'chat')
      if (props.node.key === 'main') {
        url.searchParams.delete('thread')
      } else {
        url.searchParams.set('thread', props.node.key)
      }
      globalThis.open(url.toString(), '_blank')
      return
    }
    if (props.node.kind === 'cron' && hasChildren()) {
      setExpanded(!expanded())
      return
    }
    switchThread(props.node.key)
  }

  const toggleExpand = (e: Event) => {
    e.stopPropagation()
    setExpanded(!expanded())
  }

  return (
    <>
      <div
        class="group tap-highlight-none flex cursor-pointer items-center gap-2 rounded-lg transition-colors"
        style={{
          'padding-left': `${12 + props.depth * 16}px`,
          'padding-right': '12px',
          'padding-top': '8px',
          'padding-bottom': '8px',
          background: isActive() ? 'color-mix(in srgb, var(--c-accent) 15%, transparent)' : undefined,
          opacity: props.hidden ? '0.45' : undefined
        }}
        onClick={handleClick}
      >
        <Show
          when={hasChildren()}
          fallback={
            <span
              class="w-4 text-center text-[10px]"
              style={{ color: KIND_COLORS[props.node.kind] || 'var(--c-text-muted)' }}
            >
              {KIND_ICONS[props.node.kind] || '·'}
            </span>
          }
        >
          <button
            class="w-4 cursor-pointer border-none bg-transparent text-center text-[10px] transition-transform"
            style={{
              color: KIND_COLORS[props.node.kind] || 'var(--c-text-muted)',
              transform: expanded() ? 'rotate(90deg)' : 'rotate(0deg)'
            }}
            onClick={toggleExpand}
          >
            ▶
          </button>
        </Show>

        <span class="shrink-0 text-xs">{KIND_ICONS[props.node.kind] || '·'}</span>

        <div class="min-w-0 flex-1">
          <div
            class="overflow-hidden text-sm font-medium text-ellipsis whitespace-nowrap"
            style={{ 'text-decoration': props.hidden ? 'line-through' : undefined }}
          >
            {props.node.label}
          </div>
          <div
            class="mt-0.5 flex items-center gap-1.5 overflow-hidden text-[10px] whitespace-nowrap"
            style={{ color: 'var(--c-text-muted)' }}
          >
            <span>{props.node.updatedAt ? formatRelativeTime(props.node.updatedAt) : ''}</span>
            <Show when={props.node.totalTokens > 0}>
              <span>· {Math.round(props.node.totalTokens / 1000)}k tok</span>
            </Show>
            <Show when={props.node.kind === 'cron' && hasChildren()}>
              <span>
                · {props.node.children!.length} {props.node.children!.length === 1 ? 'run' : 'runs'}
              </span>
            </Show>
          </div>

          <Show when={nextCron()}>
            {(next) => {
              const ms = () => (next().nextRunAtMs || 0) - props.now
              return (
                <div class="mt-0.5 flex items-center gap-1 text-[10px]" style={{ color: '#f59e0b' }}>
                  <span>⏰</span>
                  <span>{next().name}</span>
                  <span style={{ color: 'var(--c-text-muted)' }}>
                    {ms() > 0 ? `in ${formatCountdown(ms())}` : 'due'}
                  </span>
                </div>
              )
            }}
          </Show>
        </div>

        {/* Busy indicator */}
        <Show when={props.threadStatus.get(props.node.key)?.busy}>
          <div
            class="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full"
            style={{ background: '#f59e0b' }}
            title="Processing…"
          />
        </Show>

        {/* Unread indicator */}
        <Show
          when={
            !isActive() &&
            props.threadStatus.get(props.node.key)?.hasUnread &&
            !props.threadStatus.get(props.node.key)?.busy
          }
        >
          <div class="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: 'var(--c-accent)' }} />
        </Show>

        {/* Active indicator */}
        <Show when={isActive() && !props.threadStatus.get(props.node.key)?.busy}>
          <div class="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--c-accent)' }} />
        </Show>

        {/* Stuck indicator */}
        <Show when={props.threadStatus.get(props.node.key)?.stuckReason}>
          <div class="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: '#ef4444' }} title="Stuck" />
        </Show>

        {/* Hide / Unhide button */}
        <Show when={props.node.key !== 'main' && (props.node.kind === 'thread' || props.node.kind === 'main')}>
          <Show when={props.hidden && props.onUnhide}>
            <button
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--c-accent)',
                cursor: 'pointer',
                'font-size': '12px'
              }}
              title="Unhide thread"
              onClick={(e) => {
                e.stopPropagation()
                props.onUnhide!(props.node.key)
              }}
            >
              ↩
            </button>
          </Show>
          <Show when={!props.hidden && props.onHide}>
            <button
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 transition-colors group-hover:opacity-100"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--c-text-muted)',
                cursor: 'pointer',
                'font-size': '11px'
              }}
              title="Hide thread"
              onClick={(e) => {
                e.stopPropagation()
                props.onHide!(props.node.key)
              }}
            >
              ✕
            </button>
          </Show>
        </Show>
      </div>

      {/* Stuck status bar */}
      <Show when={props.threadStatus.get(props.node.key)?.stuckReason} keyed>
        {(reason) => {
          const status = () => props.threadStatus.get(props.node.key)!
          return (
            <div
              style={{ 'padding-left': `${28 + props.depth * 16}px`, 'padding-right': '12px', 'padding-bottom': '4px' }}
            >
              <div class="flex flex-wrap items-center gap-1.5 text-[9px]" style={{ color: '#ef4444' }}>
                <span>
                  ⚠ {reason}
                  {status().stuckSecs ? ` (${Math.round(status().stuckSecs! / 60)}m)` : ''}
                </span>
                <Show when={status().laneErrors && status().laneErrors!.length > 0}>
                  <button
                    class="rounded px-1 py-0 text-[8px]"
                    style={{ background: 'rgba(239,68,68,0.2)', color: '#fca5a5', border: 'none', cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      setErrorsExpanded(!errorsExpanded())
                    }}
                  >
                    {status().laneErrors!.length} errors {errorsExpanded() ? '▴' : '▾'}
                  </button>
                </Show>
              </div>
              <Show when={errorsExpanded() && status().laneErrors}>
                <div
                  class="mt-1 max-h-24 overflow-y-auto rounded p-1.5 font-mono text-[8px]"
                  style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}
                >
                  <For each={status().laneErrors!}>
                    {(err) => (
                      <div class="py-0.5" style={{ color: '#fca5a5' }}>
                        <span style={{ color: 'var(--c-text-muted)' }}>
                          {new Date(err.timestamp).toLocaleTimeString()}
                        </span>{' '}
                        {err.error}
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )
        }}
      </Show>

      {/* Children */}
      <Show when={expanded() && hasChildren()}>
        <For each={props.node.children}>
          {(child) => (
            <SessionRow
              node={child}
              depth={props.depth + 1}
              activeKey={props.activeKey}
              cronJobs={props.cronJobs}
              now={props.now}
              threadStatus={props.threadStatus}
            />
          )}
        </For>
      </Show>
    </>
  )
}

// ── Props ────────────────────────────────────────────────────────────

export interface ThreadDrawerProps {
  open: () => boolean
  onClose: () => void
  threads: () => ThreadInfo[]
  activeKey: () => string
  onSwitchThread: (key: string) => void
  onNewThread?: () => void
}

// ── Known recurring crons ────────────────────────────────────────────

const RECURRING_CRONS = new Set([
  'graph-reconciliation',
  'morning-digest',
  'event-system-audit',
  'ad4m-release-check',
  'oauth-proxy-monitor'
])

// ── Main drawer component ────────────────────────────────────────────

export function ThreadDrawer(props: ThreadDrawerProps) {
  const [search, setSearch] = createSignal('')
  const [showHidden, setShowHidden] = createSignal(false)
  const [showOldRuns, setShowOldRuns] = createSignal(false)
  const [expandedThreads, setExpandedThreads] = createSignal<Set<string>>(new Set())
  const [newName, setNewName] = createSignal('')

  const hiddenKeys = createMemo(() => getHiddenThreads())

  // Session tree data (fetched when drawer is open)
  const [tree, { refetch }] = createResource(
    () => props.open(),
    async (open) => {
      if (!open) return []
      return fetchSessionTree()
    }
  )

  const [cronByThread] = createResource(
    () => props.open(),
    async (open) => {
      if (!open) return {}
      return fetchCronByThread()
    }
  )

  const [threadStatusData] = createResource(
    () => props.open(),
    async (open) => {
      if (!open) return []
      return fetchThreadStatus()
    }
  )

  const threadStatusMap = () => {
    const items = threadStatusData() || []
    return new Map(items.map((t) => [t.key, t]))
  }

  // Tick every 30s for countdowns
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30000)
  onCleanup(() => clearInterval(timer))

  // Thread filtering (for search within props.threads — the entity-based view)
  const visibleThreads = createMemo(() => {
    const all = props.threads()
    const filtered = filterThreads(all, search())
    if (showHidden()) return filtered
    return filtered.filter((t) => !hiddenKeys().includes(t.key))
  })

  const grouped = createMemo(() => groupThreadsByWorkspace(visibleThreads()))

  const toggleExpand = (key: string) => {
    const s = new Set(expandedThreads())
    if (s.has(key)) s.delete(key)
    else s.add(key)
    setExpandedThreads(s)
  }

  const handleCreate = () => {
    const name = newName().trim()
    if (!name) return
    createThread(name)
    setNewName('')
    refetch()
  }

  // Extract main's children into proper sections (from session tree)
  const sections = () => {
    const roots = tree() || []
    const mainNode = roots.find((n) => n.kind === 'main')
    const children = mainNode?.children || []

    const threads: SessionNode[] = []
    const hiddenThreadsList: SessionNode[] = []
    const recurringCrons: SessionNode[] = []
    const recentRuns: SessionNode[] = []
    const oldRuns: SessionNode[] = []

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    const hidden = new Set(hiddenKeys())
    const activeKey = props.activeKey() || threadKey()

    for (const child of children) {
      if (child.kind === 'thread') {
        if (hidden.has(child.key) && child.key !== activeKey) {
          hiddenThreadsList.push(child)
        } else {
          threads.push(child)
        }
      } else if (child.kind === 'cron') {
        if (RECURRING_CRONS.has(child.label)) {
          recurringCrons.push(child)
        } else if (child.updatedAt > oneDayAgo) {
          recentRuns.push(child)
        } else {
          oldRuns.push(child)
        }
      } else {
        threads.push(child)
      }
    }

    threads.sort((a, b) => b.updatedAt - a.updatedAt)
    hiddenThreadsList.sort((a, b) => b.updatedAt - a.updatedAt)

    return { mainNode, threads, hiddenThreadsList, recurringCrons, recentRuns, oldRuns }
  }

  return (
    <div class="fixed inset-0 z-[200]" classList={{ hidden: !props.open(), block: props.open() }}>
      <div
        class="absolute inset-0 backdrop-blur-[2px]"
        style={{ background: 'var(--c-backdrop)' }}
        onClick={() => props.onClose()}
      />

      <div
        class="absolute top-0 right-0 left-0 flex max-h-[80vh] flex-col overflow-hidden rounded-b-2xl transition-transform duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{ background: 'var(--c-bg-raised)', 'border-bottom': '1px solid var(--c-border)' }}
        classList={{ '-translate-y-full': !props.open(), 'translate-y-0': props.open() }}
      >
        {/* Header */}
        <div class="flex shrink-0 items-center px-5 pt-4 pb-3" style={{ 'border-bottom': '1px solid var(--c-border)' }}>
          <span class="flex-1 text-sm font-semibold tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
            Sessions
          </span>
          <button
            class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border-none text-base transition-all"
            style={{ background: 'var(--c-hover-bg)', color: 'var(--c-text-muted)' }}
            onClick={() => props.onClose()}
          >
            ✕
          </button>
        </div>

        {/* Search */}
        <div class="px-4 pt-3 pb-1">
          <input
            type="text"
            placeholder="Search threads…"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            class="w-full rounded-[10px] px-3.5 py-2 font-[inherit] text-sm transition-colors outline-none"
            style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
          />
        </div>

        {/* Session tree */}
        <div class="flex-1 overflow-y-auto overscroll-contain py-2">
          {/* Main session */}
          <Show when={sections().mainNode}>
            {(main) => (
              <SessionRow
                node={{ ...main(), children: [] }}
                depth={0}
                activeKey={props.activeKey() || threadKey()}
                cronJobs={cronByThread() || {}}
                now={now()}
                threadStatus={threadStatusMap()}
              />
            )}
          </Show>

          {/* Threads from session tree */}
          <For each={sections().threads}>
            {(node) => (
              <SessionRow
                node={node}
                depth={0}
                activeKey={props.activeKey() || threadKey()}
                cronJobs={cronByThread() || {}}
                now={now()}
                threadStatus={threadStatusMap()}
                onHide={hideThread}
              />
            )}
          </For>

          {/* Entity-bound threads from props (fallback/additional view) */}
          <Show when={!tree()?.length}>
            <For each={[...grouped().entries()]}>
              {([groupKey, threads]) => (
                <div class="py-2">
                  <div class="px-4 py-1 text-xs font-semibold uppercase" style={{ color: 'var(--c-text-muted)' }}>
                    {groupKey === 'global' ? 'Global' : groupKey}
                  </div>
                  <Show when={groupKey === 'global'}>
                    <button
                      class="w-full px-4 py-1 text-left text-sm"
                      style={{ color: 'var(--c-accent)' }}
                      onClick={() => props.onNewThread?.()}
                    >
                      + New thread
                    </button>
                  </Show>
                  <For each={threads}>
                    {(thread) => {
                      const isHidden = () => hiddenKeys().includes(thread.key)
                      const isExpanded = () => expandedThreads().has(thread.key)
                      return (
                        <div
                          class="flex cursor-pointer items-center gap-2 px-4 py-2"
                          style={{
                            background:
                              props.activeKey() === thread.key
                                ? 'var(--c-bg-active, color-mix(in srgb, var(--c-accent) 15%, transparent))'
                                : 'transparent',
                            opacity: isHidden() ? '0.5' : '1'
                          }}
                          onClick={() => props.onSwitchThread(thread.key)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            hideThread(thread.key)
                          }}
                        >
                          <Show when={thread.entities?.length > 0}>
                            <span>{getEntityIcon(thread.entities[0].entityType)}</span>
                          </Show>
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-sm" style={{ color: 'var(--c-text)' }}>
                              {getThreadDisplayName(thread)}
                            </div>
                            <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                              {formatRelativeTime(thread.lastActivity)}
                            </div>
                            <Show when={thread.entities?.length > 1}>
                              <button
                                class="text-xs"
                                style={{ color: 'var(--c-accent)' }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleExpand(thread.key)
                                }}
                              >
                                +{thread.entities.length - 1}
                              </button>
                              <Show when={isExpanded()}>
                                <For each={thread.entities.slice(1)}>
                                  {(entity) => (
                                    <div class="pl-4 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                                      {getEntityIcon(entity.entityType)} {entity.entityRef}
                                    </div>
                                  )}
                                </For>
                              </Show>
                            </Show>
                          </div>
                          <Show when={thread.unreadCount > 0}>
                            <span
                              class="rounded-full px-1.5 py-0.5 text-xs"
                              style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
                            >
                              {thread.unreadCount}
                            </span>
                          </Show>
                          <Show when={isHidden()}>
                            <button
                              class="text-xs"
                              style={{ color: 'var(--c-accent)' }}
                              onClick={(e) => {
                                e.stopPropagation()
                                unhideThread(thread.key)
                              }}
                            >
                              Unhide
                            </button>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              )}
            </For>
          </Show>

          {/* Hidden threads toggle + list */}
          <Show when={sections().hiddenThreadsList.length > 0}>
            <button
              class="flex w-full cursor-pointer items-center gap-1 border-none bg-transparent px-4 pt-3 pb-1 text-left text-[10px] font-semibold tracking-wider uppercase"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={() => setShowHidden(!showHidden())}
            >
              <span
                class="inline-block text-[8px] transition-transform"
                style={{ transform: showHidden() ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                ▶
              </span>
              <span>Hidden ({sections().hiddenThreadsList.length})</span>
            </button>
            <Show when={showHidden()}>
              <For each={sections().hiddenThreadsList}>
                {(node) => (
                  <SessionRow
                    node={node}
                    depth={0}
                    activeKey={props.activeKey() || threadKey()}
                    cronJobs={cronByThread() || {}}
                    now={now()}
                    threadStatus={threadStatusMap()}
                    hidden={true}
                    onUnhide={unhideThread}
                  />
                )}
              </For>
            </Show>
          </Show>

          {/* Recurring crons */}
          <Show when={sections().recurringCrons.length > 0}>
            <div
              class="px-4 pt-4 pb-1 text-[10px] font-semibold tracking-wider uppercase"
              style={{ color: 'var(--c-text-muted)' }}
            >
              Scheduled Jobs
            </div>
            <For each={sections().recurringCrons}>
              {(node) => (
                <SessionRow
                  node={node}
                  depth={0}
                  activeKey={props.activeKey() || threadKey()}
                  cronJobs={cronByThread() || {}}
                  now={now()}
                  threadStatus={threadStatusMap()}
                />
              )}
            </For>
          </Show>

          {/* Recent runs */}
          <Show when={sections().recentRuns.length > 0}>
            <div
              class="px-4 pt-4 pb-1 text-[10px] font-semibold tracking-wider uppercase"
              style={{ color: 'var(--c-text-muted)' }}
            >
              Recent Runs
            </div>
            <For each={sections().recentRuns}>
              {(node) => (
                <SessionRow
                  node={node}
                  depth={0}
                  activeKey={props.activeKey() || threadKey()}
                  cronJobs={cronByThread() || {}}
                  now={now()}
                  threadStatus={threadStatusMap()}
                />
              )}
            </For>
          </Show>

          {/* Old runs (collapsed) */}
          <Show when={sections().oldRuns.length > 0}>
            <button
              class="flex w-full cursor-pointer items-center gap-1 border-none bg-transparent px-4 pt-3 pb-1 text-left text-[10px] font-semibold tracking-wider uppercase"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={() => setShowOldRuns(!showOldRuns())}
            >
              <span
                class="inline-block text-[8px] transition-transform"
                style={{ transform: showOldRuns() ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                ▶
              </span>
              <span>Older Runs ({sections().oldRuns.length})</span>
            </button>
            <Show when={showOldRuns()}>
              <For each={sections().oldRuns}>
                {(node) => (
                  <SessionRow
                    node={node}
                    depth={0}
                    activeKey={props.activeKey() || threadKey()}
                    cronJobs={cronByThread() || {}}
                    now={now()}
                    threadStatus={threadStatusMap()}
                  />
                )}
              </For>
            </Show>
          </Show>

          {/* Show hidden toggle (for entity-based view) */}
          <Show when={!tree()?.length}>
            <div class="border-t p-3" style={{ 'border-color': 'var(--c-border)' }}>
              <button
                class="text-xs"
                style={{ color: 'var(--c-text-muted)' }}
                onClick={() => setShowHidden(!showHidden())}
              >
                {showHidden() ? 'Hide hidden threads' : 'Show hidden'}
              </button>
            </div>
          </Show>
        </div>

        {/* Create thread */}
        <div class="mx-3 mt-2 mb-3 flex shrink-0 gap-2">
          <input
            type="text"
            placeholder="New thread name…"
            value={newName()}
            onInput={(e) => setNewName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
            }}
            class="min-w-0 flex-1 rounded-[10px] px-3.5 py-2.5 font-[inherit] text-sm transition-colors outline-none"
            style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
          />
          <button
            class="shrink-0 cursor-pointer rounded-[10px] border-none px-4 py-2.5 text-[13px] font-semibold whitespace-nowrap text-white transition-opacity hover:enabled:opacity-85 disabled:cursor-default disabled:opacity-40"
            style={{ background: 'var(--c-accent)' }}
            disabled={!newName().trim()}
            onClick={handleCreate}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

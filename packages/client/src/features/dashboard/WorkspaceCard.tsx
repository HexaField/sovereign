// §2.2 WorkspaceCard — Workspace summary card for the dashboard
// Pure functions exported for testability; SolidJS component uses Tailwind + var(--c-*) tokens

export interface OrgSummary {
  orgId: string
  orgName: string
  gitDirtyCount: number
  branchesAhead: number
  branchesBehind: number
  activeThreads: number
  threadCount: number
  unreadThreads: number
  errorThreads: number
  notificationCount: number
  hasActiveAgents: boolean
  hasPendingNotifications: boolean
}

export type ActivityColor = 'green' | 'amber' | 'grey'

export function getActivityColor(org: OrgSummary): ActivityColor {
  if (org.hasActiveAgents) return 'green'
  if (org.hasPendingNotifications || org.notificationCount > 0) return 'amber'
  return 'grey'
}

export function isGlobalOrg(orgId: string): boolean {
  return orgId === '_global'
}

export function formatGitSummary(dirty: number, ahead: number, behind: number): string {
  const parts: string[] = []
  if (dirty > 0) parts.push(`${dirty} dirty`)
  if (ahead > 0) parts.push(`${ahead} ahead`)
  if (behind > 0) parts.push(`${behind} behind`)
  return parts.length > 0 ? parts.join(', ') : 'Clean'
}

export function formatThreadSummary(active: number, unread: number, errors: number): string {
  const parts: string[] = []
  parts.push(`${active} active`)
  if (unread > 0) parts.push(`${unread} unread`)
  if (errors > 0) parts.push(`${errors} error`)
  return parts.join(', ')
}

export function activityDotClass(color: ActivityColor): string {
  switch (color) {
    case 'green':
      return 'bg-green-500'
    case 'amber':
      return 'bg-amber-500'
    case 'grey':
      return 'bg-gray-400'
  }
}

import { setActiveWorkspace } from '../workspace/store'
import { setActiveView } from '../nav/store'
import { Show } from 'solid-js'

export function handleCardClick(orgId: string, orgName: string): void {
  setActiveWorkspace(orgId, orgName)
  setActiveView('workspace')
}

export default function WorkspaceCard(props: { org: OrgSummary; compact?: boolean }) {
  const color = () => getActivityColor(props.org)
  const isGlobal = () => isGlobalOrg(props.org.orgId)

  // Compact mode for mobile: single row, ~60px tall, badges inline
  if (props.compact) {
    return (
      <button
        class="flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:brightness-110"
        style={{
          background: 'var(--c-bg-raised)',
          'border-color': 'var(--c-border)',
          'border-radius': '8px'
        }}
        onClick={() => handleCardClick(props.org.orgId, props.org.orgName)}
      >
        <span class={`inline-block h-2 w-2 shrink-0 rounded-full ${activityDotClass(color())}`} />
        <span class="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          {isGlobal() ? 'Global' : props.org.orgName}
        </span>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={props.org.gitDirtyCount > 0}>
            <span class="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
              {props.org.gitDirtyCount}✎
            </span>
          </Show>
          <Show when={props.org.threadCount > 0}>
            <span class="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
              {props.org.threadCount}💬
            </span>
          </Show>
          <Show when={props.org.notificationCount > 0}>
            <span class="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
              {props.org.notificationCount}
            </span>
          </Show>
          <Show when={props.org.hasActiveAgents}>
            <span class="h-2 w-2 animate-pulse rounded-full bg-green-500" />
          </Show>
        </div>
      </button>
    )
  }

  // Desktop: full card with metrics
  return (
    <button
      class="w-full cursor-pointer rounded-lg border p-3 text-left transition-colors hover:brightness-110"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': 'var(--c-border)',
        'border-radius': '8px'
      }}
      onClick={() => handleCardClick(props.org.orgId, props.org.orgName)}
    >
      <div class="mb-1.5 flex items-center gap-2">
        <span class={`inline-block h-2.5 w-2.5 rounded-full ${activityDotClass(color())}`} />
        <h3 class="text-sm font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          {isGlobal() ? 'Global' : props.org.orgName}
        </h3>
        <Show when={props.org.hasActiveAgents}>
          <span class="ml-auto h-2 w-2 animate-pulse rounded-full bg-green-500" title="Agent active" />
        </Show>
        <Show when={props.org.notificationCount > 0}>
          <span class={`${props.org.hasActiveAgents ? '' : 'ml-auto'} rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white`}>
            {props.org.notificationCount}
          </span>
        </Show>
      </div>
      <div class="space-y-0.5 text-[11px] opacity-70" style={{ color: 'var(--c-text)' }}>
        <div class="flex items-center gap-1">
          <span>✎</span>
          <span>{formatGitSummary(props.org.gitDirtyCount, props.org.branchesAhead, props.org.branchesBehind)}</span>
        </div>
        <div class="flex items-center gap-1">
          <span>💬</span>
          <span>{formatThreadSummary(props.org.threadCount, props.org.unreadThreads, props.org.errorThreads)}</span>
        </div>
      </div>
    </button>
  )
}

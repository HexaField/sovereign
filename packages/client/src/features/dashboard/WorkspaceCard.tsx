// §2.2 WorkspaceCard — Workspace summary card for the dashboard
// Pure functions exported for testability; SolidJS component uses Tailwind + var(--c-*) tokens

export interface OrgSummary {
  orgId: string
  orgName: string
  gitDirtyCount: number
  branchesAhead: number
  branchesBehind: number
  activeThreads: number
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

export function handleCardClick(orgId: string, orgName: string): void {
  setActiveWorkspace(orgId, orgName)
  setActiveView('workspace')
}

export default function WorkspaceCard(props: { org: OrgSummary }) {
  const color = () => getActivityColor(props.org)
  const isGlobal = () => isGlobalOrg(props.org.orgId)

  return (
    <button
      class="w-full cursor-pointer rounded-lg border p-4 text-left transition-colors hover:brightness-110"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': 'var(--c-border)',
        'border-radius': '8px'
      }}
      onClick={() => handleCardClick(props.org.orgId, props.org.orgName)}
    >
      <div class="mb-2 flex items-center gap-2">
        <span class={`inline-block h-2.5 w-2.5 rounded-full ${activityDotClass(color())}`} />
        <h3 class="text-base font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          {isGlobal() ? '🔒 Global' : props.org.orgName}
        </h3>
        {props.org.notificationCount > 0 && (
          <span class="ml-auto rounded-full bg-red-500 px-1.5 py-0.5 text-xs font-medium text-white">
            {props.org.notificationCount}
          </span>
        )}
      </div>
      <p class="mb-1 text-xs opacity-70" style={{ color: 'var(--c-text)' }}>
        {formatGitSummary(props.org.gitDirtyCount, props.org.branchesAhead, props.org.branchesBehind)}
      </p>
      <p class="text-xs opacity-70" style={{ color: 'var(--c-text)' }}>
        {formatThreadSummary(props.org.activeThreads, props.org.unreadThreads, props.org.errorThreads)}
      </p>
    </button>
  )
}

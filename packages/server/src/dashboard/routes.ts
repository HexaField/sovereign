// Dashboard summary endpoint — aggregates per-org data for workspace cards

import { Router } from 'express'
import type { OrgManager } from '@sovereign/orgs'
import type { ThreadManager } from '@sovereign/threads'
import type { Notifications } from '@sovereign/notifications'
import type { SystemModule } from '@sovereign/system'

export interface DashboardRoutesOptions {
  orgManager: OrgManager
  threadManager: ThreadManager
  notifications: Notifications
  system: SystemModule
}

export interface OrgDashboardSummary {
  orgId: string
  orgName: string
  gitDirtyCount: number
  branchesAhead: number
  branchesBehind: number
  activeThreadCount: number
  threadCount: number
  unreadThreadCount: number
  notificationCount: number
  hasActiveAgent: boolean
}

export function createDashboardRoutes(opts: DashboardRoutesOptions): Router {
  const router = Router()

  router.get('/api/dashboard/summary', (_req, res) => {
    try {
      const orgs = opts.orgManager.listOrgs()
      const allThreads = opts.threadManager.list()
      const allNotifications = opts.notifications.list()

      const summaries: OrgDashboardSummary[] = orgs.map((org: any) => {
        const orgId = org.id ?? org.orgId
        const orgName = org.name ?? org.orgName ?? orgId

        // Threads attached to this org: either via workspaceIds, or via an
        // entity binding whose orgId matches. Post-membrane the legacy
        // single `orgId` field is gone — workspaces are now a list.
        const orgThreads = allThreads.filter(
          (t) => t.workspaceIds.includes(orgId) || t.entities.some((e) => e.orgId === orgId)
        )
        const threadCount = orgThreads.filter((t) => !t.archived).length
        const activeThreadCount = orgThreads.filter((t) => t.agentStatus !== 'idle' && !t.archived).length
        const unreadThreadCount = orgThreads.filter((t) => t.unreadCount > 0).length
        const hasActiveAgent = orgThreads.some((t) => t.agentStatus === 'working' || t.agentStatus === 'thinking')

        // Notification count for this org
        const orgNotifications = allNotifications.filter((n: any) => n.source === orgId && !n.read && !n.dismissed)
        const notificationCount = orgNotifications.length

        return {
          orgId,
          orgName,
          gitDirtyCount: 0, // Would need git status per project — expensive, skip for now
          branchesAhead: 0,
          branchesBehind: 0,
          activeThreadCount,
          threadCount,
          unreadThreadCount,
          notificationCount,
          hasActiveAgent
        }
      })

      res.json(summaries)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  return router
}

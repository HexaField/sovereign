// Sovereign-native cron orchestration. Owns the job table conceptually;
// today it delegates to whichever backend manages cron natively (OpenClaw
// has `capabilities.cron === 'backend-managed'`). When Pi / Claude Code
// land, this service will route via Sovereign's own croner-backed scheduler
// and use `backend.sendMessage()` to deliver.
//
// Modules outside this file talk to `CronService`, never directly to a
// backend's cron RPC.

import type { RoutingBackend } from '../agent-backend/factory.js'
import type { OpenClawBackend } from '../agent-backend/openclaw/openclaw.js'
import type { CronJob, CronRunEntry } from '../agent-backend/openclaw/cron-bridge.js'

export type { CronJob, CronRunEntry } from '../agent-backend/openclaw/cron-bridge.js'

export interface CronService {
  list(includeDisabled?: boolean): Promise<CronJob[]>
  runs(jobId?: string): Promise<CronRunEntry[]>
  update(id: string, patch: Record<string, unknown>): Promise<unknown>
  remove(id: string): Promise<void>
  /** Detect whether a backend-managed cron job needs an auto-fix patch. */
  needsAutoFix(job: CronJob): boolean
  /** Build a patch that converts a broken job to the working delivery pattern. */
  buildFixPatch(job: CronJob): Record<string, unknown>
  /** Send a message into a backend session (used by cron-monitor for delivery relay). */
  sendMessage(sessionKey: string, text: string): Promise<void>
}

function openClaw(routing: RoutingBackend): OpenClawBackend | undefined {
  return routing.forKind('openclaw') as OpenClawBackend | undefined
}

export function createCronService(routing: RoutingBackend): CronService {
  // Phase 0: cron lives entirely inside the OpenClaw backend's gateway. The
  // service is a thin pass-through that consolidates the surface so chats /
  // routes don't need to know which backend owns scheduling.
  function bridge() {
    const oc = openClaw(routing)
    if (!oc) {
      // No backend-managed cron available; return a stub that produces no jobs.
      return null
    }
    return oc.cronBridge
  }

  return {
    async list(includeDisabled = false) {
      const b = bridge()
      if (!b) return []
      return await b.list(includeDisabled)
    },
    async runs(jobId?: string) {
      const b = bridge()
      if (!b) return []
      return await b.runs(jobId)
    },
    async update(id, patch) {
      const b = bridge()
      if (!b) throw new Error('cron: no backend-managed cron available')
      return await b.update(id, patch)
    },
    async remove(id) {
      const b = bridge()
      if (!b) throw new Error('cron: no backend-managed cron available')
      await b.remove(id)
    },
    needsAutoFix(job) {
      const b = bridge()
      if (!b) return false
      return b.needsAutoFix(job)
    },
    buildFixPatch(job) {
      const b = bridge()
      if (!b) return {}
      return b.buildFixPatch(job)
    },
    async sendMessage(sessionKey: string, text: string) {
      const target = routing.forSession(sessionKey)
      await target.sendMessage(sessionKey, text)
    }
  }
}

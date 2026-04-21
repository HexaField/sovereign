// Cron Manager Types

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  schedule: { kind: string; expr?: string; everyMs?: number }
  payload: { kind: string; message?: string; text?: string }
  delivery?: { mode?: string; channel?: string }
  sessionTarget?: string
  sessionKey?: string
  state?: { lastStatus?: string; nextRunAtMs?: number; lastRunAtMs?: number }
  threadKey: string | null
  issues: CronIssue[]
}

export type CronIssue = 'missing-channel' | 'wrong-session-target' | 'system-event-on-thread' | 'disabled-after-error'

export const ISSUE_LABELS: Record<CronIssue, string> = {
  'missing-channel': 'No Channel',
  'wrong-session-target': 'Wrong Target',
  'system-event-on-thread': 'System Event',
  'disabled-after-error': 'Error-Disabled'
}

export const ISSUE_COLORS: Record<CronIssue, string> = {
  'missing-channel': '#ef4444',
  'wrong-session-target': '#ef4444',
  'system-event-on-thread': '#f97316',
  'disabled-after-error': '#f97316'
}

/** Derive threadKey from a sessionTarget or sessionKey string */
export function deriveThreadKey(sessionTarget?: string, sessionKey?: string): string | null {
  for (const val of [sessionTarget, sessionKey]) {
    if (!val) continue
    const sessionMatch = val.match(/^session:agent:main:thread:(.+)$/)
    if (sessionMatch) return sessionMatch[1]
    const agentMatch = val.match(/^agent:main:thread:(.+)$/)
    if (agentMatch) return agentMatch[1]
  }
  return null
}

/** Detect issues with a cron job (client-side mirror of server logic) */
export function detectCronIssues(job: Omit<CronJob, 'issues' | 'threadKey'>): CronIssue[] {
  const issues: CronIssue[] = []
  if (!job.delivery?.channel) {
    issues.push('missing-channel')
  }
  const target = job.sessionTarget || ''
  const threadKey = deriveThreadKey(job.sessionTarget, job.sessionKey)
  if ((target === 'isolated' || target === 'main') && !threadKey) {
    issues.push('wrong-session-target')
  }
  if (threadKey && job.payload?.kind === 'systemEvent') {
    issues.push('system-event-on-thread')
  }
  if (job.enabled === false && job.state?.lastStatus === 'error') {
    issues.push('disabled-after-error')
  }
  return issues
}

/** Build the fix-to-thread patch for a given cron and target thread */
export function buildFixToThreadPatch(job: CronJob, targetThreadKey: string): Record<string, unknown> {
  const payload = { ...job.payload } as Record<string, unknown>
  if (payload.kind === 'systemEvent') {
    payload.kind = 'agentTurn'
    if (payload.text && !payload.message) {
      payload.message = payload.text
      delete payload.text
    }
  }
  return {
    sessionTarget: `session:agent:main:thread:${targetThreadKey}`,
    delivery: { mode: 'announce', channel: 'webchat' },
    payload
  }
}

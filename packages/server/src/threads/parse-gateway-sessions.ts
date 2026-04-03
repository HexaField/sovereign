// Extracted from the /api/threads/gateway-sessions route handler for testability

export interface ParsedSession {
  key: string
  shortKey: string
  kind: string
  label: string
  lastActivity?: number
}

export interface MergedSession extends ParsedSession {
  orgId?: string
  localLabel?: string
  isRegistered: boolean
}

export function parseSessionEntry(fullKey: string, meta: any): ParsedSession {
  let kind = 'unknown'
  let shortKey = fullKey
  if (fullKey.startsWith('agent:main:')) shortKey = fullKey.slice('agent:main:'.length)

  if (fullKey.endsWith(':main') || shortKey === 'main') kind = 'main'
  else if (fullKey.includes(':thread:')) kind = 'thread'
  else if (fullKey.includes(':cron:')) kind = 'cron'
  else if (fullKey.includes(':subagent:')) kind = 'subagent'
  else if (fullKey.includes(':event-agent:')) kind = 'event-agent'

  if (shortKey.startsWith('thread:')) shortKey = shortKey.slice('thread:'.length)

  return {
    key: fullKey,
    shortKey,
    kind,
    label: meta?.label || shortKey,
    lastActivity: meta?.updatedAt || meta?.createdAt
  }
}

export function filterMainAndThread(sessions: ParsedSession[]): ParsedSession[] {
  return sessions.filter((s) => s.kind === 'main' || s.kind === 'thread')
}

export function mergeWithLocal(sessions: ParsedSession[], localThreads: any[]): MergedSession[] {
  const localMap = new Map(localThreads.map((t: any) => [t.key, t]))
  // Also map by full gateway key format
  for (const t of localThreads) {
    if (t.key === 'main') localMap.set('agent:main:main', t)
    else if (!t.key.startsWith('agent:')) localMap.set(`agent:main:thread:${t.key}`, t)
  }

  return sessions.map((gs) => {
    const local = localMap.get(gs.key) || localMap.get(gs.shortKey)
    return {
      ...gs,
      orgId: local?.orgId,
      localLabel: local?.label,
      isRegistered: !!local
    }
  })
}

/** Read gateway sessions.json and return a map of shortKey → {lastActivity, status} */
export async function getGatewayActivityMap(): Promise<Map<string, { lastActivity: number; status?: string }>> {
  const map = new Map<string, { lastActivity: number; status?: string }>()
  try {
    const { readFile } = await import('fs/promises')
    const { join } = await import('path')
    const sessionsPath = join(process.env.HOME || '', '.openclaw/agents/main/sessions/sessions.json')
    const raw = await readFile(sessionsPath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, any>
    for (const [fullKey, meta] of Object.entries(data)) {
      const parsed = parseSessionEntry(fullKey, meta)
      if ((parsed.kind === 'main' || parsed.kind === 'thread') && parsed.lastActivity) {
        const status = meta?.status
        map.set(parsed.shortKey, { lastActivity: parsed.lastActivity, status })
      }
    }
  } catch {
    /* ignore read errors */
  }
  return map
}

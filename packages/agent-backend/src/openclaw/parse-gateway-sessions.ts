// Parser for OpenClaw's `sessions.json`. Lives in the OpenClaw adapter so
// nothing outside this directory has to know about the file's shape.

import fs from 'node:fs/promises'
import { statSync } from 'node:fs'
import path from 'node:path'

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

// Cache the activity map — the OpenClaw sessions.json can grow large (60MB+).
let cachedMap: Map<string, { lastActivity: number; status?: string }> | null = null
let cachedMapTime = 0
const CACHE_TTL = 10_000

/** Read OpenClaw sessions.json and return shortKey → {lastActivity, status}. */
export async function getGatewayActivityMap(
  sessionsJsonPath: string = path.join(process.env.HOME || '', '.openclaw/agents/main/sessions/sessions.json')
): Promise<Map<string, { lastActivity: number; status?: string }>> {
  const now = Date.now()
  if (cachedMap && now - cachedMapTime < CACHE_TTL) return cachedMap

  const map = new Map<string, { lastActivity: number; status?: string }>()
  try {
    try {
      const stat = statSync(sessionsJsonPath)
      if (cachedMap && stat.mtimeMs <= cachedMapTime) {
        cachedMapTime = now
        return cachedMap
      }
    } catch {
      /* ignore */
    }

    const raw = await fs.readFile(sessionsJsonPath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, any>
    for (const [fullKey, meta] of Object.entries(data)) {
      const parsed = parseSessionEntry(fullKey, meta)
      if ((parsed.kind === 'main' || parsed.kind === 'thread') && parsed.lastActivity) {
        const status = meta?.status
        map.set(parsed.shortKey, { lastActivity: parsed.lastActivity, status })
      }
    }
    cachedMap = map
    cachedMapTime = now
  } catch {
    /* ignore read errors */
  }
  return cachedMap ?? map
}

import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import type { NotificationRule } from './types.js'
import type { BusEvent } from '@template/core'

export interface RuleEngine {
  match(event: BusEvent): NotificationRule | null
  reload(): void
  rules(): NotificationRule[]
  dispose(): void
}

const getByPath = (obj: unknown, path: string): unknown => {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

export const interpolate = (template: string, event: BusEvent): string => {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
    // Try event-level first, e.g. {{payload.repo}} means event.payload.repo
    const val = getByPath(event, path)
    return val !== undefined ? String(val) : ''
  })
}

const matchPattern = (eventType: string, pattern: string): boolean => {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return eventType === prefix || eventType.startsWith(prefix + '.')
  }
  return eventType === pattern
}

export const createRuleEngine = (dataDir: string): RuleEngine => {
  const rulesPath = join(dataDir, 'notifications', 'rules.json')
  let currentRules: NotificationRule[] = []

  const reload = (): void => {
    if (existsSync(rulesPath)) {
      try {
        currentRules = JSON.parse(readFileSync(rulesPath, 'utf-8'))
      } catch {
        currentRules = []
      }
    } else {
      currentRules = []
    }
  }

  reload()

  // Hot-reload via file watching
  let watching = false
  if (existsSync(rulesPath)) {
    watchFile(rulesPath, { interval: 500 }, () => {
      reload()
    })
    watching = true
  }

  const match = (event: BusEvent): NotificationRule | null => {
    for (const rule of currentRules) {
      if (matchPattern(event.type, rule.eventPattern)) return rule
    }
    return null
  }

  const dispose = (): void => {
    if (watching) {
      unwatchFile(rulesPath)
      watching = false
    }
  }

  return { match, reload, rules: () => [...currentRules], dispose }
}

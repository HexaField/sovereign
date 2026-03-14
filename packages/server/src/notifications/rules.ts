import { readFileSync, writeFileSync, existsSync, watchFile, unwatchFile, mkdirSync } from 'node:fs'
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

const DEFAULT_RULES: NotificationRule[] = [
  {
    eventPattern: 'issue.created',
    severity: 'info',
    titleTemplate: 'New Issue',
    bodyTemplate: 'Issue created: {{payload.title}}',
    entityType: 'issue',
    entityIdField: 'payload.id'
  },
  {
    eventPattern: 'issue.updated',
    severity: 'info',
    titleTemplate: 'Issue Updated',
    bodyTemplate: 'Issue updated: {{payload.title}}',
    entityType: 'issue',
    entityIdField: 'payload.id'
  },
  {
    eventPattern: 'review.created',
    severity: 'info',
    titleTemplate: 'New Review',
    bodyTemplate: 'Review created for {{payload.title}}',
    entityType: 'pr',
    entityIdField: 'payload.id'
  },
  {
    eventPattern: 'review.merged',
    severity: 'info',
    titleTemplate: 'Review Merged',
    bodyTemplate: 'Review merged: {{payload.title}}',
    entityType: 'pr',
    entityIdField: 'payload.id'
  },
  {
    eventPattern: 'scheduler.job.failed',
    severity: 'error',
    titleTemplate: 'Job Failed',
    bodyTemplate: 'Scheduled job failed: {{payload.jobName}}'
  },
  {
    eventPattern: 'config.changed',
    severity: 'info',
    titleTemplate: 'Config Changed',
    bodyTemplate: 'Configuration updated: {{payload.key}}'
  }
]

export const seedDefaultRules = (dataDir: string): void => {
  const dir = join(dataDir, 'notifications')
  mkdirSync(dir, { recursive: true })
  const rulesPath = join(dir, 'rules.json')
  if (!existsSync(rulesPath)) {
    writeFileSync(rulesPath, JSON.stringify(DEFAULT_RULES, null, 2))
  }
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

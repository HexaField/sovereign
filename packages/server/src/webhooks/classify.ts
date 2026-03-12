import { readFileSync, existsSync, watchFile, unwatchFile, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ClassificationRule, WebhookClassification } from './types.js'

export interface Classifier {
  classify(source: string, body: unknown): WebhookClassification
  rules(): ClassificationRule[]
  stop(): void
}

const matchValue = (actual: unknown, expected: unknown): boolean => {
  if (expected === actual) return true
  if (typeof expected === 'object' && expected !== null && typeof actual === 'object' && actual !== null) {
    for (const [key, val] of Object.entries(expected as Record<string, unknown>)) {
      if (!matchValue((actual as Record<string, unknown>)[key], val)) return false
    }
    return true
  }
  return false
}

export const createClassifier = (dataDir: string): Classifier => {
  const rulesPath = join(dataDir, 'webhooks', 'rules.json')
  let currentRules: ClassificationRule[] = []

  const loadRules = (): void => {
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

  // Initial load
  mkdirSync(dirname(rulesPath), { recursive: true })
  loadRules()

  // Hot-reload via file watching
  if (existsSync(rulesPath)) {
    watchFile(rulesPath, { interval: 500 }, () => loadRules())
  }

  const classify = (source: string, body: unknown): WebhookClassification => {
    const matching = currentRules
      .filter((r) => r.source === source && matchValue(body, r.match))
      .sort((a, b) => b.priority - a.priority)

    return matching.length > 0 ? matching[0].classification : 'void'
  }

  const stop = (): void => {
    if (existsSync(rulesPath)) {
      unwatchFile(rulesPath)
    }
  }

  return {
    classify,
    rules: () => [...currentRules],
    stop
  }
}

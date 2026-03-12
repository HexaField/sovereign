// Semantic diff for JSON/YAML/TOML

import * as yaml from 'js-yaml'
import * as toml from 'smol-toml'
import { diffText } from './diff.js'
import type { SemanticDiff, SemanticChange } from './types.js'

function deepCompare(oldObj: unknown, newObj: unknown, pathPrefix: string, changes: SemanticChange[]): void {
  if (oldObj === newObj) return
  if (typeof oldObj !== typeof newObj || Array.isArray(oldObj) !== Array.isArray(newObj)) {
    changes.push({ path: pathPrefix || '.', type: 'changed', oldValue: oldObj, newValue: newObj })
    return
  }

  if (Array.isArray(oldObj) && Array.isArray(newObj)) {
    if (JSON.stringify(oldObj) !== JSON.stringify(newObj)) {
      changes.push({ path: pathPrefix || '.', type: 'changed', oldValue: oldObj, newValue: newObj })
    }
    return
  }

  if (oldObj && typeof oldObj === 'object' && newObj && typeof newObj === 'object') {
    const oldRec = oldObj as Record<string, unknown>
    const newRec = newObj as Record<string, unknown>
    const allKeys = new Set([...Object.keys(oldRec), ...Object.keys(newRec)])

    for (const key of allKeys) {
      const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key
      if (!(key in oldRec)) {
        changes.push({ path: fullPath, type: 'added', newValue: newRec[key] })
      } else if (!(key in newRec)) {
        changes.push({ path: fullPath, type: 'removed', oldValue: oldRec[key] })
      } else {
        deepCompare(oldRec[key], newRec[key], fullPath, changes)
      }
    }
    return
  }

  if (oldObj !== newObj) {
    changes.push({ path: pathPrefix || '.', type: 'changed', oldValue: oldObj, newValue: newObj })
  }
}

function parseFormat(text: string, format: string): unknown {
  switch (format) {
    case 'json':
      return JSON.parse(text)
    case 'yaml':
      return yaml.load(text)
    case 'toml':
      return toml.parse(text)
    default:
      throw new Error(`Unknown format: ${format}`)
  }
}

export function diffSemantic(oldText: string, newText: string, format: string): SemanticDiff {
  const fmt = format as 'json' | 'yaml' | 'toml'

  try {
    const oldObj = parseFormat(oldText, fmt)
    const newObj = parseFormat(newText, fmt)

    const changes: SemanticChange[] = []
    deepCompare(oldObj, newObj, '', changes)

    return { format: fmt, changes }
  } catch {
    // Fallback to text diff
    const hunks = diffText(oldText, newText)
    const additions = hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === 'add').length, 0)
    const deletions = hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === 'remove').length, 0)

    return {
      format: fmt,
      changes: [],
      fallbackTextDiff: {
        path: '',
        status: 'modified',
        binary: false,
        hunks,
        additions,
        deletions
      }
    }
  }
}

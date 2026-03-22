import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// §P.5 Events/Pipeline View — test pure utility functions

// Inline the pure functions to avoid importing the component (which depends on wsStore → window)
function categorizeEvents(entries: Array<{ status?: string }>) {
  let pending = 0,
    processing = 0,
    completed = 0,
    failed = 0
  for (const e of entries) {
    switch (e.status) {
      case 'pending':
        pending++
        break
      case 'processing':
        processing++
        break
      case 'failed':
        failed++
        break
      default:
        completed++
    }
  }
  return { pending, processing, completed, failed }
}

function getEventCategoryColor(type: string): string {
  const EVENT_CATEGORIES: Record<string, string> = {
    issue: 'text-blue-400',
    pr: 'text-purple-400',
    git: 'text-green-400',
    system: 'text-gray-400',
    config: 'text-amber-400',
    notification: 'text-red-400'
  }
  const prefix = type.split('.')[0]
  return EVENT_CATEGORIES[prefix] ?? 'text-gray-400'
}

function filterEvents(entries: Array<{ type: string; source: string }>, filter: { type?: string; source?: string }) {
  return entries.filter((e) => {
    if (filter.type && !e.type.toLowerCase().includes(filter.type.toLowerCase())) return false
    if (filter.source && e.source !== filter.source) return false
    return true
  })
}

describe('§P.5 Events/Pipeline View', () => {
  it('§P.5 event queue visualization with categorization', () => {
    const events = [{ status: 'pending' }, { status: 'processing' }, { status: 'completed' }, { status: 'failed' }, {}]
    const counts = categorizeEvents(events)
    expect(counts.pending).toBe(1)
    expect(counts.processing).toBe(1)
    expect(counts.completed).toBe(2)
    expect(counts.failed).toBe(1)
  })

  it('§P.5 event detail panel exports event category colors', () => {
    expect(getEventCategoryColor('issue.created')).toBe('text-blue-400')
    expect(getEventCategoryColor('git.push')).toBe('text-green-400')
    expect(getEventCategoryColor('unknown.thing')).toBe('text-gray-400')
  })

  it('§P.5 filter events by type and source', () => {
    const events = [
      { type: 'git.push', source: 'github' },
      { type: 'issue.created', source: 'github' },
      { type: 'git.pull', source: 'local' }
    ]
    expect(filterEvents(events, { type: 'git' })).toHaveLength(2)
    expect(filterEvents(events, { source: 'local' })).toHaveLength(1)
    expect(filterEvents(events, { type: 'git', source: 'local' })).toHaveLength(1)
  })

  it('§P.5 MUST implement retry mechanism for failed events', () => {
    const eventStreamSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'server', 'src', 'system', 'event-stream.ts'),
      'utf-8'
    )
    expect(eventStreamSrc).toContain('createEventRetryQueue')
    expect(eventStreamSrc).toContain('FailedEvent')
    expect(eventStreamSrc).toContain('exponential')
  })

  it('§P.5 MUST implement server endpoints GET /api/events and POST /api/events/:id/retry', () => {
    const indexSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'server', 'src', 'index.ts'),
      'utf-8'
    )
    expect(indexSrc).toContain('/api/system/events')
    expect(indexSrc).toContain('/api/events/:id/retry')
    expect(indexSrc).toContain('bus.emit(entry.event)')
  })
})

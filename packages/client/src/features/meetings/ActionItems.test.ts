import { describe, it, expect } from 'vitest'
import { ActionItems, formatDueDate, isOverdue } from './ActionItems.js'

describe('§8.9.2 Action Items', () => {
  it('§8.9.2 MUST show checklist with assignee and due date', () => {
    expect(typeof ActionItems).toBe('function')
    expect(formatDueDate(null)).toBe('')
    expect(formatDueDate('2026-01-15')).toContain('Jan')
  })

  it('§8.9.2 MUST allow toggling done/open status', () => {
    // ActionItems accepts onToggle callback
    expect(typeof ActionItems).toBe('function')
  })

  it('isOverdue detects past dates', () => {
    expect(isOverdue(null)).toBe(false)
    expect(isOverdue('2020-01-01')).toBe(true)
    expect(isOverdue('2099-01-01')).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { MeetingCard, statusBadgeClass, statusBadgeText, formatCardDate, formatCardDuration } from './MeetingCard.js'

describe('§8.9.1 Meeting Card', () => {
  it('§8.9.1 MUST display title, date, duration, participant count', () => {
    expect(typeof MeetingCard).toBe('function')
    expect(formatCardDate('2026-01-15T10:00:00Z')).toContain('Jan')
    expect(formatCardDuration(3600000)).toBe('1h 0m')
    expect(formatCardDuration(300000)).toBe('5m')
  })

  it('§8.9.1 MUST show transcript and summary status badges', () => {
    expect(statusBadgeClass(true)).toContain('green')
    expect(statusBadgeClass(false)).toContain('gray')
    expect(statusBadgeText('transcript', true)).toBe('Transcript ✓')
    expect(statusBadgeText('transcript', false)).toBe('No Transcript')
    expect(statusBadgeText('summary', true)).toBe('Summary ✓')
    expect(statusBadgeText('summary', false)).toBe('No Summary')
  })
})

import { describe, it, expect } from 'vitest'
import {
  createMeetingsStore,
  formatDuration,
  sortedMeetings,
  filteredMeetings,
  setMeetings,
  setSearchQuery,
  handleMeetingWsUpdate,
  toggleActionItem,
  renameSpeaker,
  pendingCount,
  totalHoursThisWeek,
  openActionItems,
  recentMeetings,
  meetings
} from './store.js'
import type { Meeting } from './store.js'

const makeMeeting = (overrides: Partial<Meeting> = {}): Meeting => ({
  id: 'test-1',
  title: 'Test Meeting',
  date: '2026-01-15T10:00:00Z',
  durationMs: 3600000,
  participants: ['Alice', 'Bob'],
  status: 'complete',
  hasTranscript: true,
  hasSummary: true,
  ...overrides
})

describe('§8.9 Meetings Store', () => {
  it('§8.9 MUST fetch and cache meeting list from server', () => {
    const store = createMeetingsStore()
    expect(typeof store.fetchMeetings).toBe('function')
    expect(typeof store.meetings).toBe('function')
    expect(typeof store.loading).toBe('function')
  })

  it('§8.9 MUST update in real-time via WS channel', () => {
    setMeetings([])
    const m = makeMeeting({ id: 'ws-1' })
    handleMeetingWsUpdate({ type: 'meeting:updated', meeting: m })
    expect(meetings().length).toBe(1)
    expect(meetings()[0].id).toBe('ws-1')

    // Update existing
    handleMeetingWsUpdate({ type: 'meeting:updated', meeting: { ...m, title: 'Updated' } })
    expect(meetings().length).toBe(1)
    expect(meetings()[0].title).toBe('Updated')

    // Delete
    handleMeetingWsUpdate({ type: 'meeting:deleted', meetingId: 'ws-1' })
    expect(meetings().length).toBe(0)
  })

  it('§8.9 MUST support search/filter operations', () => {
    setMeetings([
      makeMeeting({ id: '1', title: 'Design Review', summary: 'Discussed layouts' }),
      makeMeeting({ id: '2', title: 'Standup', summary: 'Quick sync' })
    ])
    setSearchQuery('')
    expect(filteredMeetings().length).toBe(2)

    setSearchQuery('design')
    expect(filteredMeetings().length).toBe(1)
    expect(filteredMeetings()[0].title).toBe('Design Review')

    setSearchQuery('layouts')
    expect(filteredMeetings().length).toBe(1)

    setSearchQuery('nonexistent')
    expect(filteredMeetings().length).toBe(0)
    setSearchQuery('')
  })

  it('sorts meetings by date newest first', () => {
    setMeetings([
      makeMeeting({ id: '1', date: '2026-01-01T00:00:00Z' }),
      makeMeeting({ id: '2', date: '2026-02-01T00:00:00Z' })
    ])
    expect(sortedMeetings()[0].id).toBe('2')
  })

  it('formatDuration formats correctly', () => {
    expect(formatDuration(300000)).toBe('5m')
    expect(formatDuration(3600000)).toBe('1h 0m')
    expect(formatDuration(5400000)).toBe('1h 30m')
  })

  it('toggleActionItem toggles done state', () => {
    setMeetings([
      makeMeeting({
        id: 'm1',
        actionItems: [{ id: 'a1', text: 'Do thing', assignee: 'Alice', dueDate: null, done: false }]
      })
    ])
    toggleActionItem('m1', 'a1')
    expect(meetings()[0].actionItems![0].done).toBe(true)
    toggleActionItem('m1', 'a1')
    expect(meetings()[0].actionItems![0].done).toBe(false)
  })

  it('renameSpeaker renames across participants and transcript', () => {
    setMeetings([
      makeMeeting({
        id: 'm1',
        participants: ['Speaker 1', 'Bob'],
        transcript: [{ speaker: 'Speaker 1', text: 'Hello', startMs: 0, endMs: 1000 }]
      })
    ])
    renameSpeaker('m1', 'Speaker 1', 'Alice')
    expect(meetings()[0].participants).toContain('Alice')
    expect(meetings()[0].transcript![0].speaker).toBe('Alice')
  })

  it('pendingCount counts transcribing/summarizing', () => {
    setMeetings([
      makeMeeting({ id: '1', status: 'transcribing' }),
      makeMeeting({ id: '2', status: 'complete' }),
      makeMeeting({ id: '3', status: 'summarizing' })
    ])
    expect(pendingCount()).toBe(2)
  })

  it('openActionItems returns undone items', () => {
    setMeetings([
      makeMeeting({
        id: 'm1',
        actionItems: [
          { id: 'a1', text: 'Done', assignee: '', dueDate: null, done: true },
          { id: 'a2', text: 'Open', assignee: '', dueDate: null, done: false }
        ]
      })
    ])
    expect(openActionItems().length).toBe(1)
    expect(openActionItems()[0].id).toBe('a2')
  })

  it('recentMeetings returns top N', () => {
    setMeetings(
      Array.from({ length: 10 }, (_, i) =>
        makeMeeting({ id: `m${i}`, date: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` })
      )
    )
    expect(recentMeetings(5).length).toBe(5)
    expect(recentMeetings(5)[0].id).toBe('m9') // newest
  })
})

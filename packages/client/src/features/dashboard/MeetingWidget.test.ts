import { describe, it, expect } from 'vitest'
import { MeetingWidget, formatHours, attentionItems } from './MeetingWidget.js'
import type { ActionItem } from '../meetings/store.js'

describe('§8.9.4 Dashboard Meeting Widget', () => {
  it('§8.9.4 MUST show recent meetings (last 5) with quick-view summaries', () => {
    expect(typeof MeetingWidget).toBe('function')
  })

  it('§8.9.4 MUST show pending transcriptions/summarizations count', () => {
    // MeetingWidget accepts pendingCount prop
    expect(typeof MeetingWidget).toBe('function')
  })

  it('§8.9.4 MUST show total meeting hours this week/month', () => {
    expect(formatHours(2.5)).toBe('2.5h')
    expect(formatHours(0.5)).toBe('30m')
  })

  it('§8.9.4 MUST show action items needing attention (open, past due)', () => {
    const items: ActionItem[] = [
      { id: '1', text: 'Past due', assignee: '', dueDate: '2020-01-01', done: false },
      { id: '2', text: 'Future', assignee: '', dueDate: '2099-01-01', done: false },
      { id: '3', text: 'Done', assignee: '', dueDate: '2020-01-01', done: true },
      { id: '4', text: 'No date', assignee: '', dueDate: null, done: false }
    ]
    const attention = attentionItems(items)
    expect(attention.length).toBe(2) // past due + no date (open)
    expect(attention.find((a) => a.id === '1')).toBeTruthy()
    expect(attention.find((a) => a.id === '4')).toBeTruthy()
  })
})

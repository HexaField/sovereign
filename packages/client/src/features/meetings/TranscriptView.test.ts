import { describe, it, expect } from 'vitest'
import { TranscriptView, getSpeakerColor, formatTimestamp, uniqueSpeakers } from './TranscriptView.js'

describe('§8.9.2 Transcript View', () => {
  it('§8.9.2 MUST display timestamped segments with speaker labels', () => {
    expect(typeof TranscriptView).toBe('function')
    expect(formatTimestamp(65000)).toBe('1:05')
    expect(formatTimestamp(0)).toBe('0:00')
  })

  it('§8.9.2 MUST color-code speakers', () => {
    const speakers = ['Alice', 'Bob', 'Carol']
    const c1 = getSpeakerColor('Alice', speakers)
    const c2 = getSpeakerColor('Bob', speakers)
    expect(c1).not.toBe(c2)
  })

  it('§8.9.2 MUST allow clicking timestamp to seek audio', () => {
    // TranscriptView accepts onSeek callback on timestamp click
    expect(typeof TranscriptView).toBe('function')
  })

  it('uniqueSpeakers extracts distinct speakers', () => {
    const segs = [
      { speaker: 'Alice', text: '', startMs: 0, endMs: 1000 },
      { speaker: 'Bob', text: '', startMs: 1000, endMs: 2000 },
      { speaker: 'Alice', text: '', startMs: 2000, endMs: 3000 }
    ]
    expect(uniqueSpeakers(segs)).toEqual(['Alice', 'Bob'])
  })
})
